import { DatabaseSync, type Database } from '../ledger/sqlite.js';
import { CACHE_DB_PATH } from '../config.js';
import { CACHE_SCHEMA } from './schema.js';
import { runCacheMigrations } from './migrations.js';

export type { Database };

/**
 * Thrown when the SQLite build backing node:sqlite lacks something the cache
 * schema requires. Callers should treat this as "cache unavailable, fall back
 * to IMAP" rather than a fatal error — the cache is an optimization.
 */
export class CacheUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CacheUnsupportedError';
  }
}

/**
 * Verify FTS5 exists and supports contentless_delete before we commit to a
 * schema that depends on both. Node ships one bundled SQLite configuration, so
 * in practice this either passes everywhere or fails everywhere — but failing
 * here with a clear message beats failing on the first DELETE months later.
 */
export function assertFts5Support(db: Database): void {
  try {
    db.exec(
      `CREATE VIRTUAL TABLE temp.__fts_probe USING fts5(x, content='', contentless_delete=1)`
    );
    db.exec(`INSERT INTO temp.__fts_probe(rowid, x) VALUES (1, 'probe')`);
    db.exec(`DELETE FROM temp.__fts_probe WHERE rowid = 1`);
    db.exec(`DROP TABLE temp.__fts_probe`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CacheUnsupportedError(
      `SQLite build does not support contentless FTS5 with deletes: ${detail}`
    );
  }
}

export interface OpenCacheOptions {
  /**
   * Open without writing. Readers (MCP server instances) use this; only the
   * daemon opens the cache for writing. See "Process model" in the design doc.
   */
  readOnly?: boolean;
}

export function openCache(
  dbPath: string = CACHE_DB_PATH,
  options: OpenCacheOptions = {}
): Database {
  const db = new DatabaseSync(dbPath);

  // Same durability posture as the ledger: WAL so readers never block the
  // daemon's writes, and a bounded busy timeout so a mid-sync batch doesn't
  // fail a tool call outright.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA wal_autocheckpoint = 1000');
  db.exec('PRAGMA foreign_keys = ON');

  if (options.readOnly) return db;

  assertFts5Support(db);
  db.exec(CACHE_SCHEMA);
  runCacheMigrations(db);
  return db;
}
