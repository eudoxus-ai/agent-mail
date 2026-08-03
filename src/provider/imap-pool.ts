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

interface PoolEntry {
  provider: ImapProvider | null;
  queue: Promise<void>;
  keepaliveTimer: NodeJS.Timeout | null;
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
  private readonly entries = new Map<string, PoolEntry>();
  private closed = false;

  constructor(deps: PoolDeps) {
    this.accounts = deps.accounts;
    this.logger = deps.logger;
    this.keepaliveIntervalMs = deps.keepaliveIntervalMs ?? 60_000;
    this.operationTimeoutMs = deps.operationTimeoutMs ?? 10 * 60_000;
  }

  async withConnection<T>(
    accountId: string,
    fn: (imap: ImapProvider) => Promise<T>
  ): Promise<T> {
    if (this.closed) {
      throw new Error('ImapConnectionPool is closed');
    }
    // Validate account exists before anything else
    getAccount(this.accounts, accountId);

    const entry = this.getOrCreateEntry(accountId);

    // Chain this borrow onto the per-account queue so concurrent calls serialize.
    // The task resolves/rejects with the fn result; the queue uses a swallowed
    // copy so a single failing task never poisons subsequent calls.
    const task: Promise<T> = entry.queue.then(() =>
      this.withTimeout(accountId, this.runWithRetry(accountId, entry, fn))
    );
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
      entry = { provider: null, queue: Promise.resolve(), keepaliveTimer: null };
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
  private async withTimeout<T>(accountId: string, work: Promise<T>): Promise<T> {
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
    fn: (imap: ImapProvider) => Promise<T>
  ): Promise<T> {
    const provider = await this.ensureConnected(accountId, entry);
    try {
      return await fn(provider);
    } catch (err) {
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
    entry.provider = provider;
    this.startKeepalive(accountId, entry);
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

  private async teardown(entry: PoolEntry): Promise<void> {
    if (entry.keepaliveTimer) {
      clearInterval(entry.keepaliveTimer);
      entry.keepaliveTimer = null;
    }
    const p = entry.provider;
    entry.provider = null;
    if (p) {
      try {
        await p.disconnect();
      } catch {
        // best-effort
      }
    }
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
