import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import { runMigrations } from '../../src/ledger/migrations.js';
import { DatabaseSync, type Database } from '../../src/ledger/sqlite.js';
import { claimNext, heartbeat, reclaimExpired } from '../../src/ledger/queue.js';

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
 * The claim is the whole safety story: it is the one operation that decides
 * who runs a job, and getting it wrong means either a job runs twice or it
 * never runs at all.
 */
describe('claimNext', () => {
  /** Distinct created_at values, so "oldest first" means something. */
  function queue(id: string, accountId = 'icloud', createdAt?: string): void {
    db.prepare(
      `INSERT INTO intents (id, account_id, tool, params, risk, status, created_at)
       VALUES (?, ?, 'hold_by_sender', '{}', 'medium', 'queued', ?)`
    ).run(id, accountId, createdAt ?? new Date().toISOString());
  }

  it('returns null when nothing is queued', () => {
    expect(claimNext(db, 'worker-1', 60_000)).toBeNull();
  });

  it('claims the oldest queued intent and flips it to executing', () => {
    queue('newer', 'icloud', '2026-08-04T12:00:02.000Z');
    queue('older', 'icloud', '2026-08-04T12:00:01.000Z');

    const claimed = claimNext(db, 'worker-1', 60_000);

    expect(claimed?.id).toBe('older');
    expect(claimed?.status).toBe('executing');
  });

  it('records the claim and counts the attempt', () => {
    queue('a');
    const before = Date.now();

    const claimed = claimNext(db, 'worker-1', 60_000)!;

    expect(claimed.claimed_by).toBe('worker-1');
    expect(claimed.attempts).toBe(1);
    expect(claimed.claimed_at).not.toBeNull();
    // The lease has to be in the future by roughly the requested window, or
    // reclaim will yank the job out from under the worker that just took it.
    const expiry = new Date(claimed.lease_expires_at!).getTime();
    expect(expiry).toBeGreaterThanOrEqual(before + 60_000);
    expect(expiry).toBeLessThan(before + 70_000);
  });

  it('leaves the rest of the queue alone', () => {
    queue('a', 'icloud', '2026-08-04T12:00:01.000Z');
    queue('b', 'icloud', '2026-08-04T12:00:02.000Z');

    claimNext(db, 'worker-1', 60_000);

    const row = db.prepare(`SELECT status FROM intents WHERE id = 'b'`).get() as {
      status: string;
    };
    expect(row.status).toBe('queued');
  });

  it('does not take a second job for an account that already has one running', () => {
    // Per-account IMAP serialization means a second concurrent job on the same
    // account cannot make progress — it would just hold a lease while blocked
    // behind the first, and the lease would expire mid-wait.
    queue('a', 'icloud', '2026-08-04T12:00:01.000Z');
    queue('b', 'icloud', '2026-08-04T12:00:02.000Z');

    expect(claimNext(db, 'worker-1', 60_000)?.id).toBe('a');
    expect(claimNext(db, 'worker-1', 60_000)).toBeNull();
  });

  it('still takes work for a different account', () => {
    queue('a', 'icloud', '2026-08-04T12:00:01.000Z');
    queue('b', 'gmail', '2026-08-04T12:00:02.000Z');

    expect(claimNext(db, 'worker-1', 60_000)?.id).toBe('a');
    expect(claimNext(db, 'worker-1', 60_000)?.id).toBe('b');
  });

  it('is not blocked by a legacy executing intent that nobody claimed', () => {
    // Intents left `executing` by the old in-process path have no claim and no
    // lease. Treating them as live would wedge that account's queue forever.
    db.prepare(
      `INSERT INTO intents (id, account_id, tool, params, risk, status)
       VALUES ('orphan', 'icloud', 'hold_by_sender', '{}', 'medium', 'executing')`
    ).run();
    queue('a');

    expect(claimNext(db, 'worker-1', 60_000)?.id).toBe('a');
  });

  it('does not claim work that is merely pending approval', () => {
    db.prepare(
      `INSERT INTO intents (id, account_id, tool, params, risk, status)
       VALUES ('p', 'icloud', 'hold_by_sender', '{}', 'high', 'pending')`
    ).run();

    expect(claimNext(db, 'worker-1', 60_000)).toBeNull();
  });
});

/**
 * The lease is what makes a dead worker recoverable rather than a permanent
 * hole. A worker holds its claim by heartbeating; when the heartbeats stop, the
 * lease lapses and the job goes back in the queue.
 */
describe('heartbeat', () => {
  function claimOne(worker = 'worker-1', leaseMs = 60_000) {
    db.prepare(
      `INSERT INTO intents (id, account_id, tool, params, risk, status)
       VALUES ('a', 'icloud', 'hold_by_sender', '{}', 'medium', 'queued')`
    ).run();
    return claimNext(db, worker, leaseMs)!;
  }

  function leaseOf(id: string): string {
    return (
      db.prepare(`SELECT lease_expires_at FROM intents WHERE id = ?`).get(id) as {
        lease_expires_at: string;
      }
    ).lease_expires_at;
  }

  it('pushes the lease out', () => {
    const claimed = claimOne('worker-1', 1_000);
    const before = leaseOf(claimed.id);

    expect(heartbeat(db, claimed.id, 'worker-1', 60_000)).toBe(true);

    expect(new Date(leaseOf(claimed.id)).getTime()).toBeGreaterThan(
      new Date(before).getTime()
    );
  });

  it('refuses a worker that does not hold the claim', () => {
    const claimed = claimOne('worker-1', 1_000);
    const before = leaseOf(claimed.id);

    // Otherwise a worker that lost its claim to reclaim could keep extending
    // the lease of whoever took the job over from it.
    expect(heartbeat(db, claimed.id, 'worker-2', 60_000)).toBe(false);
    expect(leaseOf(claimed.id)).toBe(before);
  });

  it('refuses once the job is no longer executing', () => {
    const claimed = claimOne();
    db.prepare(`UPDATE intents SET status = 'executed' WHERE id = ?`).run(claimed.id);

    expect(heartbeat(db, claimed.id, 'worker-1', 60_000)).toBe(false);
  });
});

describe('reclaimExpired', () => {
  function claimWithLease(id: string, accountId: string, leaseMs: number): void {
    db.prepare(
      `INSERT INTO intents (id, account_id, tool, params, risk, status)
       VALUES (?, ?, 'hold_by_sender', '{}', 'medium', 'queued')`
    ).run(id, accountId);
    claimNext(db, 'dead-worker', leaseMs);
  }

  function statusOf(id: string) {
    return db
      .prepare(
        `SELECT status, claimed_by, lease_expires_at, attempts, error_detail
           FROM intents WHERE id = ?`
      )
      .get(id) as {
      status: string;
      claimed_by: string | null;
      lease_expires_at: string | null;
      attempts: number;
      error_detail: string | null;
    };
  }

  it('puts an expired claim back in the queue', () => {
    claimWithLease('a', 'icloud', -1_000); // already expired

    const result = reclaimExpired(db);

    expect(result.requeued).toEqual(['a']);
    const row = statusOf('a');
    expect(row.status).toBe('queued');
    // The claim must be cleared too, or the per-account rule keeps treating
    // this account as busy and nothing on it ever runs again.
    expect(row.claimed_by).toBeNull();
    expect(row.lease_expires_at).toBeNull();
  });

  it('leaves a live lease alone', () => {
    claimWithLease('a', 'icloud', 60_000);

    expect(reclaimExpired(db).requeued).toEqual([]);
    expect(statusOf('a').status).toBe('executing');
  });

  it('leaves an unclaimed executing intent alone', () => {
    // Legacy rows from the in-process path have no claim and no lease. They are
    // not the queue's to reclaim — requeuing them would re-run a mutation that
    // may well have completed.
    db.prepare(
      `INSERT INTO intents (id, account_id, tool, params, risk, status)
       VALUES ('legacy', 'icloud', 'hold_by_sender', '{}', 'medium', 'executing')`
    ).run();

    expect(reclaimExpired(db).requeued).toEqual([]);
    expect(statusOf('legacy').status).toBe('executing');
  });

  it('gives up after too many attempts instead of requeuing forever', () => {
    claimWithLease('a', 'icloud', -1_000);
    // Two prior attempts already burned; this expiry is the third.
    db.prepare(`UPDATE intents SET attempts = 3 WHERE id = 'a'`).run();

    const result = reclaimExpired(db);

    expect(result.requeued).toEqual([]);
    expect(result.failed).toEqual(['a']);

    const row = statusOf('a');
    expect(row.status).toBe('failed');
    // A bare 'failed' with no explanation is what sent the last round of
    // debugging in circles. Say what happened and how many times.
    const detail = JSON.parse(row.error_detail!) as {
      code: string;
      attempts: number;
      message: string;
    };
    expect(detail.code).toBe('lease_expired_max_attempts');
    expect(detail.attempts).toBe(3);
    expect(detail.message).toMatch(/3/);
  });

  it('requeues one job and fails another in the same sweep', () => {
    claimWithLease('a', 'icloud', -1_000);
    claimWithLease('b', 'gmail', -1_000);
    db.prepare(`UPDATE intents SET attempts = 3 WHERE id = 'b'`).run();

    const result = reclaimExpired(db);

    expect(result.requeued).toEqual(['a']);
    expect(result.failed).toEqual(['b']);
  });

  it('makes a reclaimed job claimable again', () => {
    claimWithLease('a', 'icloud', -1_000);
    reclaimExpired(db);

    const reclaimed = claimNext(db, 'worker-2', 60_000);

    expect(reclaimed?.id).toBe('a');
    // Attempt two. The count is what eventually stops a poison job.
    expect(reclaimed?.attempts).toBe(2);
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
