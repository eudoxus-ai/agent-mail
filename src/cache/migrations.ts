import type { Database } from '../ledger/sqlite.js';
import { withTransaction } from './store.js';

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

  // Data migrations, numbered by PRAGMA user_version. Each step and its
  // version bump commit together, so a crash leaves the step to run again.
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  if (version < 1) {
    withTransaction(db, () => {
      repairStoredSnippets(db);
      db.exec('PRAGMA user_version = 1');
    });
  }
}

/**
 * Snippets ingested before the preview decoder read charsets hold UTF-8 bytes
 * read one per character as Latin-1. Rows a later sync refreshed are already
 * right, and are left alone because they no longer look garbled.
 */
function repairStoredSnippets(db: Database): void {
  const rows = db
    .prepare(`SELECT id, snippet FROM messages WHERE snippet != ''`)
    .all() as Array<{ id: number; snippet: string }>;
  const update = db.prepare(`UPDATE messages SET snippet = ? WHERE id = ?`);
  for (const row of rows) {
    const repaired = repairLatin1Mojibake(row.snippet);
    if (repaired !== null) update.run(repaired, row.id);
  }
}

// A UTF-8 lead byte followed by a continuation byte, both read as Latin-1.
const MOJIBAKE = /[\u00C2-\u00F4][\u0080-\u00BF]/;
// Snippets are cut by character count after garbling, which can split the
// last sequence. A UTF-8 sequence is at most 4 bytes, so at most 3 are left.
const MAX_CUT_BYTES = 3;

/**
 * The text a garbled snippet was meant to be, or null when it does not look
 * garbled or its bytes are not valid UTF-8. Text that is real Latin-1 almost
 * never decodes as strict UTF-8, which is what keeps it untouched.
 */
export function repairLatin1Mojibake(snippet: string): string | null {
  if (!MOJIBAKE.test(snippet)) return null;
  for (let i = 0; i < snippet.length; i += 1) {
    if (snippet.charCodeAt(i) > 0xff) return null;
  }

  const bytes = Buffer.from(snippet, 'latin1');
  const strict = new TextDecoder('utf-8', { fatal: true });
  for (let cut = 0; cut <= MAX_CUT_BYTES && cut < bytes.length; cut += 1) {
    try {
      return strict.decode(bytes.subarray(0, bytes.length - cut));
    } catch {
      // Not valid UTF-8 at this length; try without one more trailing byte.
    }
  }
  return null;
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
