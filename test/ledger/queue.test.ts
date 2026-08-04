import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import { runMigrations } from '../../src/ledger/migrations.js';
import { DatabaseSync, type Database } from '../../src/ledger/sqlite.js';

/**
 * The ledger becomes the queue.
 *
 * Accepted work has to survive a process restart, which means it lives in the
 * database rather than in a promise chain in memory. `queued` is the status
 * that says "accepted, not yet started"; the claim columns are how a worker
 * takes ownership of one without two workers taking the same one.
 */

let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:');
});

function insertIntent(status: string): void {
  db.prepare(
    `INSERT INTO intents (id, account_id, tool, params, risk, status)
     VALUES (?, 'icloud', 'hold_by_sender', '{}', 'medium', ?)`
  ).run(`id-${status}-${Math.floor(performance.now() * 1000)}`, status);
}

describe('queued status', () => {
  it('accepts an intent at status queued', () => {
    expect(() => insertIntent('queued')).not.toThrow();

    const row = db
      .prepare(`SELECT status FROM intents WHERE status = 'queued'`)
      .get() as { status: string };
    expect(row.status).toBe('queued');
  });

  it('still rejects a status that is not in the vocabulary', () => {
    // The CHECK constraint is the only thing standing between a typo and an
    // intent that no reader will ever look for. Widening it must not remove it.
    expect(() => insertIntent('kweued')).toThrow();
  });

  it('keeps every status it accepted before', () => {
    for (const status of [
      'pending',
      'approved',
      'executing',
      'executed',
      'rejected',
      'failed',
      'undone',
    ]) {
      expect(() => insertIntent(status), status).not.toThrow();
    }
  });
});

describe('claim columns', () => {
  it('round-trips claimed_by, claimed_at, lease_expires_at and attempts', () => {
    insertIntent('queued');
    const { id } = db.prepare(`SELECT id FROM intents`).get() as { id: string };

    db.prepare(
      `UPDATE intents
          SET claimed_by = ?, claimed_at = ?, lease_expires_at = ?, attempts = ?
        WHERE id = ?`
    ).run('worker-1', '2026-08-04T12:00:00.000Z', '2026-08-04T12:10:00.000Z', 2, id);

    const row = db
      .prepare(
        `SELECT claimed_by, claimed_at, lease_expires_at, attempts FROM intents WHERE id = ?`
      )
      .get(id) as {
      claimed_by: string;
      claimed_at: string;
      lease_expires_at: string;
      attempts: number;
    };

    expect(row.claimed_by).toBe('worker-1');
    expect(row.claimed_at).toBe('2026-08-04T12:00:00.000Z');
    expect(row.lease_expires_at).toBe('2026-08-04T12:10:00.000Z');
    expect(Number(row.attempts)).toBe(2);
  });

  it('starts a fresh intent at zero attempts, not null', () => {
    // The claim increments this. Starting from NULL would make every increment
    // NULL and quietly disable the give-up-after-3 rule.
    insertIntent('queued');
    const row = db.prepare(`SELECT attempts FROM intents`).get() as { attempts: number };
    expect(Number(row.attempts)).toBe(0);
  });

  it('leaves a fresh intent unclaimed', () => {
    insertIntent('queued');
    const row = db
      .prepare(`SELECT claimed_by, lease_expires_at FROM intents`)
      .get() as { claimed_by: string | null; lease_expires_at: string | null };
    expect(row.claimed_by).toBeNull();
    expect(row.lease_expires_at).toBeNull();
  });
});

/**
 * Migration 9 rewrites the ledger's primary table. SQLite cannot ALTER a CHECK
 * constraint, so the only way to widen it is create-copy-drop-rename — and that
 * is exactly the operation that loses data when it is written carelessly.
 */
describe('migration 9 against a populated legacy ledger', () => {
  /** The `intents` table as it stood before this migration, columns and all. */
  function legacyLedger(): Database {
    const legacy = new DatabaseSync(':memory:');
    legacy.exec(`
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
    `);
    return legacy;
  }

  const STATUSES = [
    'pending',
    'approved',
    'executing',
    'executed',
    'rejected',
    'failed',
    'undone',
  ];

  it('preserves every row and every column', () => {
    const legacy = legacyLedger();
    const insert = legacy.prepare(
      `INSERT INTO intents
         (id, account_id, tool, params, risk, status, error_detail, agent_id,
          created_at, resolved_at, resolved_by, undo_token, undo_expires_at,
          reverses_intent_id, reversed_by_intent_id, progress)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const status of STATUSES) {
      insert.run(
        `id-${status}`,
        'icloud',
        'hold_messages',
        JSON.stringify({ note: status }),
        'medium',
        status,
        JSON.stringify({ message: `why ${status}` }),
        'agent-x',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
        'user',
        `undo-${status}`,
        '2026-01-03T00:00:00.000Z',
        JSON.stringify([`rev-${status}`]),
        `revby-${status}`,
        JSON.stringify({ phase: status, updated_at: '2026-01-01T00:00:00.000Z' })
      );
    }

    runMigrations(legacy);

    const rows = legacy
      .prepare(`SELECT * FROM intents ORDER BY id`)
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(STATUSES.length);

    for (const status of STATUSES) {
      const row = rows.find((r) => r.id === `id-${status}`)!;
      expect(row, status).toBeDefined();
      expect(row.status).toBe(status);
      expect(row.params).toBe(JSON.stringify({ note: status }));
      expect(row.error_detail).toBe(JSON.stringify({ message: `why ${status}` }));
      expect(row.agent_id).toBe('agent-x');
      expect(row.created_at).toBe('2026-01-01T00:00:00.000Z');
      expect(row.resolved_at).toBe('2026-01-02T00:00:00.000Z');
      expect(row.resolved_by).toBe('user');
      expect(row.undo_token).toBe(`undo-${status}`);
      expect(row.undo_expires_at).toBe('2026-01-03T00:00:00.000Z');
      // These three arrived in earlier migrations. A rebuild that forgets them
      // silently breaks undo links and progress reporting.
      expect(row.reverses_intent_id).toBe(JSON.stringify([`rev-${status}`]));
      expect(row.reversed_by_intent_id).toBe(`revby-${status}`);
      expect(row.progress).toBe(
        JSON.stringify({ phase: status, updated_at: '2026-01-01T00:00:00.000Z' })
      );
      // New columns arrive with sane defaults, not nulls that break arithmetic.
      expect(Number(row.attempts)).toBe(0);
      expect(row.claimed_by).toBeNull();
    }
  });

  it('leaves the widened ledger able to take queued work', () => {
    const legacy = legacyLedger();
    runMigrations(legacy);

    expect(() =>
      legacy
        .prepare(
          `INSERT INTO intents (id, account_id, tool, params, risk, status)
           VALUES ('q1', 'icloud', 'hold_by_sender', '{}', 'medium', 'queued')`
        )
        .run()
    ).not.toThrow();
  });

  it('is idempotent — a second run changes nothing', () => {
    const legacy = legacyLedger();
    legacy
      .prepare(
        `INSERT INTO intents (id, account_id, tool, params, risk, status)
         VALUES ('a', 'icloud', 'hold_messages', '{}', 'medium', 'executed')`
      )
      .run();

    runMigrations(legacy);
    runMigrations(legacy);

    const rows = legacy.prepare(`SELECT id FROM intents`).all();
    expect(rows).toHaveLength(1);
  });
});
