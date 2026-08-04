import { ImapProvider } from './imap.js';
import { resolveCredentials } from './credentials.js';
import { getAccount } from './accounts.js';
import type { AccountConfig } from '../types.js';
import type { Logger } from '../logger.js';

interface PoolDeps {
  accounts: AccountConfig[];
  logger: Logger;
  /** Interval in ms for keepalive NOOPs. Default 60_000. Pass 0 to disable. */
  keepaliveIntervalMs?: number;
  /**
   * Ceiling on a single borrow. Default 10 minutes. Pass 0 to disable.
   *
   * Not a latency target — an escape hatch. Borrows are serialized per account,
   * so an operation that never settles wedges that account permanently: every
   * later call queues behind it and waits forever. A server can produce that by
   * accepting a command and going silent, with no FIN and no RST, which no
   * error handler will ever see.
   */
  operationTimeoutMs?: number;
  /**
   * How long to wait for a graceful LOGOUT before destroying the socket.
   * Default 3s. Counts against operationTimeoutMs when a teardown happens
   * mid-borrow, so keep it small relative to that.
   */
  logoutGraceMs?: number;
}

function envTimeoutMs(): number | null {
  const raw = process.env.AGENT_MAIL_IMAP_TIMEOUT_MS;
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export class ImapOperationTimeoutError extends Error {
  constructor(accountId: string, ms: number) {
    super(
      `IMAP operation on account "${accountId}" exceeded ${Math.round(ms / 1000)}s and was abandoned. ` +
        'The connection has been torn down; the next call will reconnect. ' +
        'If this was a large sweep, re-run it with background: true.'
    );
    this.name = 'ImapOperationTimeoutError';
  }
}

/** Cancellation signal for a single borrow, set when its timeout fires. */
interface BorrowToken {
  aborted: boolean;
}

interface PoolEntry {
  provider: ImapProvider | null;
  queue: Promise<void>;
  keepaliveTimer: NodeJS.Timeout | null;
  /** Borrows waiting on this account, including the one running. */
  queueDepth: number;
  /** The borrow currently executing, if any. */
  inFlight: { label: string; startedAt: number } | null;
}

export interface AccountDiagnostics {
  account_id: string;
  connected: boolean;
  queue_depth: number;
  in_flight: { label: string; elapsed_ms: number } | null;
}

export interface PoolDiagnostics {
  opened: number;
  closed: number;
  live: number;
  operation_timeout_ms: number;
  accounts: AccountDiagnostics[];
}

/**
 * Per-account IMAP connection pool.
 *
 * - Lazy connect on first borrow.
 * - Per-account serialization (imapflow is not safe for concurrent ops on one conn).
 * - Keepalive NOOP every ~60s to prevent idle disconnects.
 * - Reconnect-once on dropped-connection errors; otherwise propagate.
 * - closeAll() for clean shutdown.
 */
export class ImapConnectionPool {
  private readonly accounts: AccountConfig[];
  private readonly logger: Logger;
  private readonly keepaliveIntervalMs: number;
  private readonly operationTimeoutMs: number;
  private readonly logoutGraceMs: number;
  private readonly entries = new Map<string, PoolEntry>();
  private closed = false;
  private openedConnections = 0;
  private closedConnections = 0;

  constructor(deps: PoolDeps) {
    this.accounts = deps.accounts;
    this.logger = deps.logger;
    this.keepaliveIntervalMs = deps.keepaliveIntervalMs ?? 60_000;
    // 5 minutes, not 10: borrows serialize per account, so several queued
    // background sweeps each waiting out a long timeout turn one slow
    // operation into many minutes of apparent silence. Override with
    // AGENT_MAIL_IMAP_TIMEOUT_MS when a legitimately huge sweep needs longer.
    this.operationTimeoutMs =
      deps.operationTimeoutMs ?? envTimeoutMs() ?? 5 * 60_000;
    this.logoutGraceMs = deps.logoutGraceMs ?? 3_000;
  }

  async withConnection<T>(
    accountId: string,
    fn: (imap: ImapProvider) => Promise<T>,
    label = 'operation'
  ): Promise<T> {
    if (this.closed) {
      throw new Error('ImapConnectionPool is closed');
    }
    // Validate account exists before anything else
    getAccount(this.accounts, accountId);

    const entry = this.getOrCreateEntry(accountId);
    entry.queueDepth += 1;

    // Chain this borrow onto the per-account queue so concurrent calls serialize.
    // The task resolves/rejects with the fn result; the queue uses a swallowed
    // copy so a single failing task never poisons subsequent calls.
    const task: Promise<T> = entry.queue.then(() => {
      entry.inFlight = { label, startedAt: Date.now() };
      const token: BorrowToken = { aborted: false };
      return this.withTimeout(
        accountId,
        this.runWithRetry(accountId, entry, fn, token),
        token
      ).finally(() => {
        entry.inFlight = null;
        entry.queueDepth -= 1;
      });
    });
    entry.queue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    const shutdowns: Array<Promise<void>> = [];
    for (const [accountId, entry] of this.entries) {
      if (entry.keepaliveTimer) {
        clearInterval(entry.keepaliveTimer);
        entry.keepaliveTimer = null;
      }
      if (entry.provider) {
        const p = entry.provider;
        entry.provider = null;
        shutdowns.push(
          (async () => {
            try {
              await p.disconnect();
            } catch (err) {
              this.logger.warn(`Pool shutdown error for ${accountId}`, {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          })()
        );
      }
    }
    // Best-effort: wait up to 5s for all disconnects
    await Promise.race([
      Promise.all(shutdowns),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
  }

  private getOrCreateEntry(accountId: string): PoolEntry {
    let entry = this.entries.get(accountId);
    if (!entry) {
      entry = {
        provider: null,
        queue: Promise.resolve(),
        keepaliveTimer: null,
        queueDepth: 0,
        inFlight: null,
      };
      this.entries.set(accountId, entry);
    }
    return entry;
  }

  /**
   * Bound a borrow so a silently-hung operation cannot wedge the account.
   *
   * On timeout the connection is torn down: the operation is still running on
   * it as far as the server is concerned, so it must not be reused. Rejecting
   * also lets the per-account queue advance, which is the part that actually
   * unblocks everything else.
   */
  private async withTimeout<T>(
    accountId: string,
    work: Promise<T>,
    token: BorrowToken
  ): Promise<T> {
    if (this.operationTimeoutMs <= 0) return work;

    let timer: NodeJS.Timeout | undefined;
    const started = Date.now();

    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new ImapOperationTimeoutError(accountId, this.operationTimeoutMs)),
            this.operationTimeoutMs
          );
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      if (error instanceof ImapOperationTimeoutError) {
        // Mark the borrow abandoned BEFORE tearing down. The underlying work
        // is still running; destroying its socket will make it reject with a
        // connection-drop error, which runWithRetry would otherwise treat as
        // a transient failure and retry — re-executing a move on a fresh
        // connection after the caller was already told it timed out.
        token.aborted = true;

        this.logger.error('IMAP operation timed out; tearing down connection', {
          account_id: accountId,
          elapsed_ms: Date.now() - started,
        });
        const entry = this.entries.get(accountId);
        if (entry) await this.teardown(entry);
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async runWithRetry<T>(
    accountId: string,
    entry: PoolEntry,
    fn: (imap: ImapProvider) => Promise<T>,
    token: BorrowToken
  ): Promise<T> {
    const provider = await this.ensureConnected(accountId, entry);
    try {
      return await fn(provider);
    } catch (err) {
      // The caller has already given up and may have recorded a failure.
      // Retrying now would run the callback a second time — for a move or a
      // flag change, that is a duplicate mutation nobody is waiting for.
      if (token.aborted) throw err;
      if (!isConnectionDropError(err)) throw err;
      this.logger.warn(`IMAP connection dropped for ${accountId}, reconnecting`, {
        error: err instanceof Error ? err.message : String(err),
      });
      // Tear down dead provider
      await this.teardown(entry);
      const freshProvider = await this.ensureConnected(accountId, entry);
      // Retry exactly once
      return await fn(freshProvider);
    }
  }

  private async ensureConnected(
    accountId: string,
    entry: PoolEntry
  ): Promise<ImapProvider> {
    // A provider whose socket died asynchronously is still sitting in the
    // entry. Handing it out again produces a confusing mid-operation failure,
    // so replace it here instead.
    if (entry.provider && entry.provider.isDead()) {
      this.logger.warn(`Discarding dead IMAP connection for ${accountId}`, {
        error: entry.provider.getLastError()?.message,
      });
      await this.teardown(entry);
    }
    if (entry.provider) return entry.provider;

    const account = getAccount(this.accounts, accountId);
    const resolved = resolveCredentials(account);
    const provider = new ImapProvider(resolved, {
      onError: (error) => {
        // Log only. Throwing or rethrowing here would land back on the
        // unhandled-'error' path this listener exists to prevent; the next
        // borrow sees isDead() and reconnects.
        this.logger.warn(`IMAP connection error for ${accountId}`, {
          error: error.message,
          code: (error as Error & { code?: string }).code,
        });
      },
    });
    await provider.connect();
    this.openedConnections += 1;
    entry.provider = provider;
    this.startKeepalive(accountId, entry);

    // Opened-vs-closed makes a leak visible instead of inferred: these should
    // stay within one of each other, and `live` should never exceed the
    // account count.
    this.logger.debug('IMAP connection opened', {
      account_id: accountId,
      ...this.stats(),
    });

    return provider;
  }

  private startKeepalive(accountId: string, entry: PoolEntry): void {
    if (this.keepaliveIntervalMs <= 0) return;
    if (entry.keepaliveTimer) return;
    entry.keepaliveTimer = setInterval(async () => {
      const p = entry.provider;
      if (!p) return;
      try {
        await p.noop();
      } catch (err) {
        this.logger.warn(`Keepalive NOOP failed for ${accountId}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        // Mark provider dead; next borrow will reconnect
        await this.teardown(entry);
      }
    }, this.keepaliveIntervalMs);
    // Don't block process exit on the keepalive timer
    entry.keepaliveTimer.unref?.();
  }

  /**
   * Drop a connection, guaranteed to complete.
   *
   * Teardown runs on the timeout path, so it must never be the thing that
   * hangs. A graceful LOGOUT is attempted briefly because it is politer to the
   * server, but a hung connection will never answer it — so the socket is
   * destroyed outright once that window passes. Skipping the destroy is how
   * orphaned sockets pile up against the provider's connection cap.
   */
  private async teardown(entry: PoolEntry): Promise<void> {
    if (entry.keepaliveTimer) {
      clearInterval(entry.keepaliveTimer);
      entry.keepaliveTimer = null;
    }
    const p = entry.provider;
    entry.provider = null;
    if (!p) return;

    this.closedConnections += 1;

    try {
      await Promise.race([
        p.disconnect(),
        new Promise((resolve) => {
          const t = setTimeout(resolve, this.logoutGraceMs);
          t.unref?.();
        }),
      ]);
    } catch {
      // best-effort
    } finally {
      // Unconditional: after a graceful logout this is a no-op, and after a
      // hung one it is the only thing that actually frees the socket.
      p.destroy();
    }
  }

  /** Connection lifecycle counters, for diagnosing suspected leaks. */
  stats(): { opened: number; closed: number; live: number } {
    let live = 0;
    for (const entry of this.entries.values()) {
      if (entry.provider) live += 1;
    }
    return { opened: this.openedConnections, closed: this.closedConnections, live };
  }

  /**
   * The per-operation ceiling, in ms. The queue worker needs it to check that
   * its lease outlives it — a lease that can expire mid-operation gets the job
   * reclaimed and re-run underneath the worker still performing it.
   */
  getOperationTimeoutMs(): number {
    return this.operationTimeoutMs;
  }

  /**
   * Live pool state. The pool exists only inside this process, so a separate
   * CLI can never observe it — this is the only way to see whether an account
   * is wedged, how deep its queue is, and how long the current operation has
   * been running.
   */
  diagnostics(): PoolDiagnostics {
    const now = Date.now();
    return {
      ...this.stats(),
      operation_timeout_ms: this.operationTimeoutMs,
      accounts: [...this.entries.entries()].map(([account_id, entry]) => ({
        account_id,
        connected: entry.provider != null && !entry.provider.isDead(),
        queue_depth: entry.queueDepth,
        in_flight: entry.inFlight
          ? {
              label: entry.inFlight.label,
              elapsed_ms: now - entry.inFlight.startedAt,
            }
          : null,
      })),
    };
  }
}

export function isConnectionDropError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: string }).code ?? '';
  const msg = err.message ?? '';
  return (
    code === 'NoConnection' ||
    // Socket-level codes. ECONNRESET is the common one on iCloud, and its
    // message ("read ECONNRESET") matches none of the patterns below, so
    // without the code check it was treated as a fatal application error.
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    code === 'ENOTCONN' ||
    /socket\s*closed/i.test(msg) ||
    /connection\s*(reset|lost|closed|ended)/i.test(msg) ||
    /ECONNRESET|EPIPE|ETIMEDOUT/i.test(msg) ||
    /BYE/i.test(msg)
  );
}
