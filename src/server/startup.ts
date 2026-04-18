import type { AccountConfig } from '../types.js';
import type { MigrationImap, MigrationOutcome } from '../provider/folder-migration.js';
import { migrateHoldingFolder } from '../provider/folder-migration.js';

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
