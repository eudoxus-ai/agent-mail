import type { Database } from '../ledger/sqlite.js';

/**
 * Additive migrations for the cache, mirroring the ledger's style.
 *
 * The bar here is lower than the ledger's: the cache is rebuildable, so a
 * migration that can't be expressed additively is allowed to drop and re-sync
 * rather than contort. Use `resetCache` for those.
 */
export function runCacheMigrations(_db: Database): void {
  // No migrations yet — the schema is new. Additive column adds go here,
  // guarded by PRAGMA table_info checks the way ledger/migrations.ts does.
}

/**
 * Drop every cached row while leaving the schema in place. Used on
 * UIDVALIDITY changes that span a whole account, and as the recovery path for
 * a corrupt or unmigratable cache.
 */
export function resetCache(db: Database): void {
  db.exec('DELETE FROM messages');
  db.exec('DELETE FROM messages_fts');
  db.exec('DELETE FROM thread_links');
  db.exec('DELETE FROM mailbox_state');
  // bodies and attachments cascade from messages.
}
