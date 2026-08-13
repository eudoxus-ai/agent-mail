import type { Database } from '../ledger/sqlite.js';

/**
 * Additive migrations for the cache, mirroring the ledger's style.
 *
 * The bar here is lower than the ledger's: the cache is rebuildable, so a
 * migration that can't be expressed additively is allowed to drop and re-sync
 * rather than contort. Use `resetCache` for those.
 */
export function runCacheMigrations(db: Database): void {
  // Additive column adds go here, guarded by PRAGMA table_info checks the way
  // ledger/migrations.ts does.

  // When flags were last re-read for a mailbox on a server without CONDSTORE.
  // Without it the fallback path re-fetched its flag window every single tick,
  // which on one real account meant thousands of envelopes a minute, forever.
  const cols = db.prepare(`PRAGMA table_info(mailbox_state)`).all() as Array<{ name: string }>;
  if (!cols.map((c) => c.name).includes('last_flag_sync_at')) {
    db.exec(`ALTER TABLE mailbox_state ADD COLUMN last_flag_sync_at INTEGER`);
  }
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
