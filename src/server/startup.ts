import type { AccountConfig } from '../types.js';
import type { MigrationImap, MigrationOutcome } from '../provider/folder-migration.js';
import { migrateHoldingFolder } from '../provider/folder-migration.js';
import type { Database } from '../ledger/sqlite.js';
import { failStaleRunningJobs, pruneScanJobs } from '../ledger/scan-jobs.js';

/**
 * Reap scan jobs left `running` by a previous process that crashed/restarted
 * mid-scan, then prune old terminal rows so the table doesn't grow unbounded.
 *
 * The reap mirrors `checkStuckExecuting` for intents — a `running` row whose
 * background promise died is a permanent zombie unless marked `failed` so a
 * poll reports `failed` and the agent re-issues. Pruning then drops `done`/
 * `failed` rows (with their result blobs) older than the default retention
 * window. Returns the count reaped (not pruned).
 */
export function runStartupScanCleanup(db: Database): number {
  const reaped = failStaleRunningJobs(db);
  pruneScanJobs(db);
  return reaped;
}

export interface StartupPool {
  withConnection<T>(accountId: string, fn: (imap: MigrationImap) => Promise<T>): Promise<T>;
}

export async function runStartupMigrations(args: {
  pool: StartupPool;
  accounts: AccountConfig[];
  migrate?: (imap: MigrationImap) => Promise<MigrationOutcome>;
}): Promise<Record<string, MigrationOutcome>> {
  const migrate = args.migrate ?? migrateHoldingFolder;
  const results: Record<string, MigrationOutcome> = {};
  for (const account of args.accounts) {
    results[account.id] = await args.pool.withConnection(account.id, (imap) => migrate(imap));
  }
  return results;
}
