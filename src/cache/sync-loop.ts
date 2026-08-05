import type { Database } from '../ledger/sqlite.js';
import type { Logger } from '../logger.js';
import type { AccountConfig } from '../types.js';
import type { ImapConnectionPool } from '../provider/imap-pool.js';
import { ImapSyncProvider } from '../provider/imap-sync.js';
import { resolveMailboxes, syncMailbox, drainMailboxBodies } from './sync.js';
import { gcAttachments } from './attachment-store.js';
import type { CacheConfig } from './config.js';

/**
 * The daemon's sync loop — the single writer to cache.db.
 *
 * MCP server instances open the cache read-only. If two processes both synced
 * they'd duplicate every fetch and contend on writes, which is why this lives
 * in the daemon and nowhere else.
 */

export interface SyncLoopDeps {
  cache: Database;
  accounts: AccountConfig[];
  pool: ImapConnectionPool;
  logger: Logger;
  config: CacheConfig;
}

const ATTACHMENT_GC_INTERVAL_MS = 6 * 60 * 60 * 1000;

export class SyncLoop {
  private timer: NodeJS.Timeout | null = null;
  /** Accounts whose sync capabilities have been logged this daemon run. */
  private readonly capsLogged = new Set<string>();
  private gcTimer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(private readonly deps: SyncLoopDeps) {}

  start(): void {
    const intervalMs = this.deps.config.syncIntervalSeconds * 1000;

    // Kick off immediately so a freshly started daemon begins backfilling
    // rather than idling for a full interval.
    void this.tick();

    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();

    this.gcTimer = setInterval(() => {
      try {
        const removed = gcAttachments();
        if (removed > 0) {
          this.deps.logger.info('cache: expired staged attachments removed', { removed });
        }
      } catch (error) {
        this.deps.logger.warn('cache: attachment gc failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, ATTACHMENT_GC_INTERVAL_MS);
    this.gcTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.gcTimer) clearInterval(this.gcTimer);
    this.timer = null;
    this.gcTimer = null;
  }

  /**
   * One pass over every account. Guarded against overlap: a backfill batch can
   * outrun the tick interval, and starting a second pass on top of it would
   * double-fetch and fight over the write lock.
   */
  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;

    try {
      for (const account of this.deps.accounts) {
        if (this.stopped) break;
        try {
          await this.syncOneAccount(account.id);
        } catch (error) {
          // One unreachable account must not stop the others.
          this.deps.logger.warn('cache: account sync failed', {
            account_id: account.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Sync one account, one mailbox at a time, each in its own borrow.
   *
   * The whole account used to share a single borrow — and the pool applies its
   * operation timeout to the borrow as a whole. A large INBOX and Sent with
   * thousands of bodies queued behind them consumed the five-minute budget; the
   * pool timed out and destroyed the connection; the loop carried on, because a
   * promise cannot be cancelled, and every remaining mailbox threw "Connection
   * not available" in turn. With a fixed mailbox order that is not bad luck but
   * starvation: the same tail failed on every tick. One real account had an
   * Archive 29 hours stale and a holding folder that had never synced at all.
   *
   * A borrow per mailbox gives each its own timeout budget and a connection the
   * pool has had a chance to replace.
   */
  private async syncOneAccount(accountId: string): Promise<void> {
    const descriptors = await this.deps.pool.withConnection(
      accountId,
      async (imap) => {
        // Once per account per daemon run: what the server offers for sync and
        // whether the iCloud ENABLE workaround fired. This line is the answer
        // to "why is this account on the fallback path" without a debugger.
        if (!this.capsLogged.has(accountId)) {
          this.capsLogged.add(accountId);
          const caps = (imap as { syncCapabilities?: () => Record<string, unknown> })
            .syncCapabilities?.();
          if (caps) {
            this.deps.logger.info('cache: sync capabilities', {
              account_id: accountId,
              ...caps,
            });
          }
        }
        return new ImapSyncProvider(imap).listMailboxes();
      },
      'cache:list-mailboxes'
    );
    const mailboxes = orderByStaleness(
      this.deps.cache,
      accountId,
      resolveMailboxes(descriptors, this.deps.config.mailboxes)
    );

    let ingested = 0;
    let bodies = 0;

    for (const mailbox of mailboxes) {
      if (this.stopped) break;
      const startedAt = Date.now();
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await this.deps.pool.withConnection(
          accountId,
          async (imap) =>
            syncMailbox(
              this.deps.cache,
              {
                accountId,
                provider: new ImapSyncProvider(imap),
                mailboxes: this.deps.config.mailboxes,
                backfillDays: this.deps.config.backfillDays,
                batchSize: this.deps.config.batchSize,
                bodyBatchSize: this.deps.config.bodyBatchSize,
                // One batch per mailbox per tick keeps a large backfill from
                // monopolizing the account's single IMAP connection, which the
                // reviewer UI also needs for approvals.
                maxBatches: 1,
                logger: this.deps.logger,
              },
              mailbox
            ),
          `cache:sync ${mailbox}`
        );

        ingested += result.ingested;
        const envelopeMs = Date.now() - startedAt;

        // Per-mailbox, per-phase timing. When a borrow times out at exactly
        // the pool ceiling, this is what says which phase spent the budget —
        // the alternative was inferring it from which mailboxes failed, which
        // took three rounds of log-reading to get right.
        this.deps.logger.debug('cache: mailbox pass', {
          account_id: accountId,
          mailbox,
          mode: result.mode,
          ingested: result.ingested,
          envelope_ms: envelopeMs,
        });

        // A mailbox on the fallback path costs a periodic rescan; on a server
        // that advertises CONDSTORE it should be on the delta path instead,
        // and being here anyway means the modseq recovery is not working —
        // exactly the state that burned 300s per mailbox per tick unnoticed.
        if (result.mode === 'fallback' && result.ingested > 0) {
          this.deps.logger.info('cache: fallback rescan', {
            account_id: accountId,
            mailbox,
            ingested: result.ingested,
            hint: 'no HIGHESTMODSEQ recorded for this mailbox — see "cache: sync capabilities"',
          });
        }

        // Bodies on their own borrow, so they get their own timeout budget.
        // Sharing the envelope sync's meant a slow body fetch consumed it and
        // took an otherwise-successful mailbox down with it.
        const generation = result.uidvalidity;
        if (result.mode !== 'error' && generation != null) {
          const bodiesStartedAt = Date.now();
          // eslint-disable-next-line no-await-in-loop
          const fetchedHere = await this.deps.pool.withConnection(
            accountId,
            async (imap) =>
              drainMailboxBodies(
                this.deps.cache,
                {
                  accountId,
                  provider: new ImapSyncProvider(imap),
                  bodyBatchSize: this.deps.config.bodyBatchSize,
                  logger: this.deps.logger,
                },
                mailbox,
                generation
              ),
            `cache:bodies ${mailbox}`
          );
          bodies += fetchedHere;
          if (fetchedHere > 0) {
            this.deps.logger.debug('cache: bodies pass', {
              account_id: accountId,
              mailbox,
              fetched: fetchedHere,
              bodies_ms: Date.now() - bodiesStartedAt,
            });
          }
        }

        if (result.mode === 'error') {
          this.deps.logger.warn('cache: mailbox sync failed', {
            account_id: accountId,
            mailbox,
            error: result.error,
          });
        }
      } catch (error) {
        // A borrow-level failure — timeout, dead connection — belongs to this
        // mailbox alone now. The next one gets a fresh borrow.
        this.deps.logger.warn('cache: mailbox sync failed', {
          account_id: accountId,
          mailbox,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (ingested > 0 || bodies > 0) {
      this.deps.logger.info('cache: synced', {
        account_id: accountId,
        ingested,
        bodies,
        mailboxes: mailboxes.length,
      });
    }
  }
}

/**
 * Least-recently-synced first, never-synced before that.
 *
 * A fixed order means a pass that ends early always ends early in the same
 * place, so the tail never syncs. Ordering by staleness is self-correcting:
 * whatever missed out last time goes to the front, and a mailbox that just
 * synced rotates to the back.
 */
export function orderByStaleness(
  cache: Database,
  accountId: string,
  mailboxes: string[]
): string[] {
  const rows = cache
    .prepare(`SELECT mailbox, last_delta_at FROM mailbox_state WHERE account_id = ?`)
    .all(accountId) as Array<{ mailbox: string; last_delta_at: number | null }>;

  const lastSync = new Map(rows.map((r) => [r.mailbox, r.last_delta_at]));

  return [...mailboxes].sort((a, b) => {
    // -1 rather than 0: a mailbox with no state at all has never synced, and
    // belongs ahead of one that synced at the epoch.
    const at = lastSync.get(a) ?? -1;
    const bt = lastSync.get(b) ?? -1;
    return at - bt;
  });
}
