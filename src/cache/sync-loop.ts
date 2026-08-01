import type { Database } from '../ledger/sqlite.js';
import type { Logger } from '../logger.js';
import type { AccountConfig } from '../types.js';
import type { ImapConnectionPool } from '../provider/imap-pool.js';
import { ImapSyncProvider } from '../provider/imap-sync.js';
import { syncAccount } from './sync.js';
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
          await this.deps.pool.withConnection(account.id, async (imap) => {
            const results = await syncAccount(this.deps.cache, {
              accountId: account.id,
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
            });

            const ingested = results.reduce((n, r) => n + r.ingested, 0);
            const bodies = results.reduce((n, r) => n + r.bodiesFetched, 0);
            const failed = results.filter((r) => r.mode === 'error');

            if (ingested > 0 || bodies > 0) {
              this.deps.logger.info('cache: synced', {
                account_id: account.id,
                ingested,
                bodies,
                mailboxes: results.length,
              });
            }
            for (const failure of failed) {
              this.deps.logger.warn('cache: mailbox sync failed', {
                account_id: account.id,
                mailbox: failure.mailbox,
                error: failure.error,
              });
            }
          });
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
}
