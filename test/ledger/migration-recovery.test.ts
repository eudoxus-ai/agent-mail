import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type Database } from '../../src/ledger/sqlite.js';
import { runMigrations } from '../../src/ledger/migrations.js';

/**
 * A table rebuild has to be all-or-nothing.
 *
 * Migrations 6 and 9 cannot ALTER what they need to change, so they rebuild:
 * create a `_v2`, copy, drop, rename. Run as one multi-statement `exec` that is
 * exactly four chances to fail halfway, because node:sqlite does not wrap an
 * exec in a transaction and SQLite releases the write lock between statements.
 *
 * That is not hypothetical. The daemon writes to this same file every second or
 * so; it took the lock between the copy and the drop, the drop failed with
 * "database is locked", and `intents_v2` was left behind. Every subsequent
 * start then died on "table intents_v2 already exists" — the MCP server would
 * not boot at all.
 */

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-mail-migrate-'));
  dbPath = join(dir, 'ledger.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const LEGACY_INTENTS = `
  CREATE TABLE intents (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    params JSON NOT NULL,
    risk TEXT NOT NULL CHECK (risk IN ('none', 'low', 'medium', 'high')),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'approved', 'executing', 'executed', 'rejected', 'failed', 'undone')),
    error_detail JSON,
    agent_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME,
    resolved_by TEXT,
    undo_token TEXT,
    undo_expires_at DATETIME,
    reverses_intent_id JSON,
    reversed_by_intent_id TEXT,
    progress JSON
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    intent_id TEXT REFERENCES intents(id),
    account_id TEXT,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    detail JSON,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

/** The shape of `intents` after migration 9, for hand-building a stranded db. */
const V2_INTENTS = `
  CREATE TABLE intents_v2 (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    params JSON NOT NULL,
    risk TEXT NOT NULL CHECK (risk IN ('none', 'low', 'medium', 'high')),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'queued', 'approved', 'executing', 'executed', 'rejected', 'failed', 'undone')),
    error_detail JSON,
    agent_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME,
    resolved_by TEXT,
    undo_token TEXT,
    undo_expires_at DATETIME,
    reverses_intent_id JSON,
    reversed_by_intent_id TEXT,
    progress JSON,
    claimed_by TEXT,
    claimed_at DATETIME,
    lease_expires_at DATETIME,
    attempts INTEGER NOT NULL DEFAULT 0
  );
`;

function open(path = dbPath): Database {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 500');
  return db;
}

function insertIntent(db: Database, table: string, id: string, status = 'executed'): void {
  db.prepare(
    `INSERT INTO ${table} (id, account_id, tool, params, risk, status)
     VALUES (?, 'icloud', 'hold_messages', '{}', 'medium', ?)`
  ).run(id, status);
}

function tables(db: Database): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

describe('recovering a half-finished rebuild', () => {
  it('clears a stranded intents_v2 and migrates', () => {
    // The state the crash actually left: the copy was made, the drop failed,
    // so both tables exist and `intents` is still the real one.
    const db = open();
    db.exec(LEGACY_INTENTS);
    insertIntent(db, 'intents', 'a');
    insertIntent(db, 'intents', 'b');
    db.exec(V2_INTENTS);
    db.prepare(
      `INSERT INTO intents_v2 (id, account_id, tool, params, risk, status)
       VALUES ('a', 'icloud', 'hold_messages', '{}', 'medium', 'executed')`
    ).run();

    expect(() => runMigrations(db)).not.toThrow();

    expect(tables(db)).not.toContain('intents_v2');
    const rows = db.prepare(`SELECT id FROM intents ORDER BY id`).all() as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    db.close();
  });

  it('adopts intents_v2 when the original was already dropped', () => {
    // The dangerous variant: the drop succeeded and the rename did not, so the
    // ONLY copy of the ledger is in intents_v2. Treating it as a leftover and
    // deleting it would destroy every intent the user has.
    const db = open();
    db.exec(V2_INTENTS);
    db.exec(`
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, intent_id TEXT, account_id TEXT,
        action TEXT NOT NULL, actor TEXT NOT NULL, detail JSON,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    insertIntent(db, 'intents_v2', 'survivor');

    expect(() => runMigrations(db)).not.toThrow();

    expect(tables(db)).toContain('intents');
    expect(tables(db)).not.toContain('intents_v2');
    const rows = db.prepare(`SELECT id FROM intents`).all() as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['survivor']);
    db.close();
  });

  it('clears a stranded intent_targets_v2 too', () => {
    // Migration 6 has the identical shape and the identical hazard.
    const db = open();
    db.exec(LEGACY_INTENTS);
    db.exec(`
      CREATE TABLE intent_targets (
        intent_id TEXT NOT NULL, account_id TEXT NOT NULL, uid INTEGER NOT NULL,
        mailbox TEXT NOT NULL, envelope_snapshot JSON, destination_uid INTEGER,
        PRIMARY KEY (intent_id, account_id, uid)
      );
      CREATE TABLE intent_targets_v2 (
        intent_id TEXT NOT NULL, account_id TEXT NOT NULL, uid INTEGER NOT NULL,
        mailbox TEXT NOT NULL, envelope_snapshot JSON, destination_uid INTEGER,
        PRIMARY KEY (intent_id, account_id, mailbox, uid)
      );
    `);
    insertIntent(db, 'intents', 'a');
    db.prepare(
      `INSERT INTO intent_targets (intent_id, account_id, uid, mailbox)
       VALUES ('a', 'icloud', 1, 'INBOX')`
    ).run();

    expect(() => runMigrations(db)).not.toThrow();

    expect(tables(db)).not.toContain('intent_targets_v2');
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM intent_targets`).get() as { n: number }).n
    ).toBe(1);
    db.close();
  });

  it('is repeatable — running it again after recovery changes nothing', () => {
    const db = open();
    db.exec(LEGACY_INTENTS);
    insertIntent(db, 'intents', 'a');
    db.exec(V2_INTENTS);

    runMigrations(db);
    runMigrations(db);

    expect(tables(db)).not.toContain('intents_v2');
    expect((db.prepare(`SELECT COUNT(*) AS n FROM intents`).get() as { n: number }).n).toBe(1);
    db.close();
  });
});

describe('the rebuild is atomic', () => {
  it('leaves nothing behind when another process holds the write lock', () => {
    const db = open();
    db.exec(LEGACY_INTENTS);
    insertIntent(db, 'intents', 'a');
    insertIntent(db, 'intents', 'b');

    // The daemon, mid-write. This is what actually happened: it holds the lock
    // for a moment and the rebuild loses it partway through.
    const daemon = open();
    daemon.exec('BEGIN IMMEDIATE');
    daemon
      .prepare(
        `INSERT INTO intents (id, account_id, tool, params, risk, status)
         VALUES ('daemon-write', 'icloud', 'hold_messages', '{}', 'medium', 'executing')`
      )
      .run();

    expect(() => runMigrations(db)).toThrow(/lock/i);

    // The point: a failed migration must leave a ledger that still opens.
    // Stranding intents_v2 here is what made the MCP server unbootable.
    expect(tables(db)).not.toContain('intents_v2');

    daemon.exec('ROLLBACK');
    daemon.close();

    // And once the lock is free, the same call succeeds with everything intact.
    expect(() => runMigrations(db)).not.toThrow();
    const rows = db.prepare(`SELECT id FROM intents ORDER BY id`).all() as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(
      db.prepare(`SELECT sql FROM sqlite_master WHERE name='intents'`).get() as { sql: string }
    ).toBeTruthy();
    db.close();
  });
});
