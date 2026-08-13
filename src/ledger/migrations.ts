import type { Database } from './sqlite.js';

function tableExists(db: Database, name: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) != null
  );
}

/**
 * Run a create-copy-drop-rename table rebuild safely.
 *
 * Two things make the naive version fail on a real ledger, and it failed on a
 * real one — the MCP server would not boot, dying on "table intents_v2 already
 * exists" every start.
 *
 * **Foreign keys.** `node:sqlite` turns `PRAGMA foreign_keys` ON by default,
 * unlike the SQLite C library. `intent_targets` and `audit_log` both reference
 * `intents(id)`, so `DROP TABLE intents` on any ledger that has ever recorded a
 * hold fails with "FOREIGN KEY constraint failed". The references are by name
 * and resolve again once the staging table is renamed into place, so the
 * enforcement is switched off for the rebuild and restored after. The pragma is
 * a no-op inside a transaction, hence the ordering here.
 *
 * **Atomicity.** `db.exec()` does not wrap its statements in a transaction, and
 * SQLite releases the write lock between them — four separate chances for the
 * daemon, which writes to this file every second or so, to take the lock in a
 * gap and leave the rebuild half-done. BEGIN IMMEDIATE takes the lock up front
 * and holds it for all four, so the rebuild either happens or leaves no trace.
 */
function rebuildTable(db: Database, fn: () => void): void {
  const previous = (db.prepare(`PRAGMA foreign_keys`).get() as { foreign_keys: number })
    .foreign_keys;

  // Must be outside the transaction: SQLite ignores this pragma within one.
  if (previous) db.exec('PRAGMA foreign_keys = OFF');
  try {
    // Outside the inner try: if this throws, there is no transaction to undo.
    db.exec('BEGIN IMMEDIATE');
    try {
      fn();
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Already rolled back by SQLite; the original error is the useful one.
      }
      throw error;
    }
  } finally {
    if (previous) db.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * Finish or discard a rebuild that died partway, from before rebuilds were
 * atomic.
 *
 * Which of the two is right depends entirely on whether the original table is
 * still there, and getting it backwards destroys the ledger:
 *
 * - Both tables present — the copy never replaced the original, so the original
 *   is authoritative and the `_v2` is a leftover. Drop it.
 * - Only `_v2` present — the drop succeeded and the rename did not, so `_v2`
 *   holds the *only* copy of the data. Finish the rename. Deleting it here
 *   would throw away every intent the user has.
 */
function recoverInterruptedRebuild(db: Database, table: string): void {
  const staging = `${table}_v2`;
  if (!tableExists(db, staging)) return;

  if (tableExists(db, table)) {
    db.exec(`DROP TABLE ${staging}`);
  } else {
    db.exec(`ALTER TABLE ${staging} RENAME TO ${table}`);
  }
}

export function runMigrations(db: Database): void {
  // Before anything reads the schema. A ledger left mid-rebuild may have no
  // `intents` table at all, and every migration below assumes there is one.
  recoverInterruptedRebuild(db, 'intents');
  recoverInterruptedRebuild(db, 'intent_targets');

  // Migration 1: add reverses_intent_id column to intents
  const intentCols = db.prepare(`PRAGMA table_info(intents)`).all() as Array<{ name: string }>;
  const intentColNames = intentCols.map((c) => c.name);

  if (!intentColNames.includes('reverses_intent_id')) {
    db.exec(`ALTER TABLE intents ADD COLUMN reverses_intent_id JSON`);
  }

  if (!intentColNames.includes('reversed_by_intent_id')) {
    db.exec(`ALTER TABLE intents ADD COLUMN reversed_by_intent_id TEXT`);
  }

  // Migration 2: create intent_targets table
  db.exec(`
    CREATE TABLE IF NOT EXISTS intent_targets (
      intent_id         TEXT    NOT NULL REFERENCES intents(id),
      account_id        TEXT    NOT NULL,
      uid               INTEGER NOT NULL,
      mailbox           TEXT    NOT NULL,
      envelope_snapshot JSON,
      PRIMARY KEY (intent_id, account_id, uid)
    )
  `);

  // Migration 3: rename legacy quarantine tool names to hold_messages
  db.exec(`
    UPDATE intents
    SET tool = 'hold_messages'
    WHERE tool IN ('quarantine_thread', 'quarantine_messages')
  `);

  // Migration 5: add progress column to intents.
  //
  // A long-running background action previously reported only
  // status: "executing" with an empty targets array, which is
  // indistinguishable from "queued and never started". Progress records the
  // phase so a poller can tell the difference.
  if (!intentColNames.includes('progress')) {
    db.exec(`ALTER TABLE intents ADD COLUMN progress JSON`);
  }

  // Migration 4: add destination_uid column to intent_targets
  const targetCols = db.prepare(`PRAGMA table_info(intent_targets)`).all() as Array<{ name: string }>;
  const targetColNames = targetCols.map((c) => c.name);
  if (!targetColNames.includes('destination_uid')) {
    db.exec(`ALTER TABLE intent_targets ADD COLUMN destination_uid INTEGER`);
  }

  // Migration 6: put mailbox into the intent_targets primary key.
  //
  // IMAP UIDs are unique only within a mailbox, but the key was
  // (intent_id, account_id, uid). A single hold_messages call spanning
  // mailboxes — INBOX uid 123 and Archive uid 123 on one account — collided,
  // and once inserts became upserts the collision silently overwrote the first
  // envelope snapshot. Both messages moved; only one could be restored, which
  // breaks the reversibility guarantee the whole tool rests on.
  //
  // SQLite cannot ALTER a primary key, so rebuild the table.
  const targetsSql = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'intent_targets'`)
    .get() as { sql: string } | undefined;

  if (targetsSql && !/PRIMARY KEY \(intent_id, account_id, mailbox, uid\)/.test(targetsSql.sql)) {
    rebuildTable(db, () => db.exec(`
      CREATE TABLE intent_targets_v2 (
        intent_id         TEXT    NOT NULL REFERENCES intents(id),
        account_id        TEXT    NOT NULL,
        uid               INTEGER NOT NULL,
        mailbox           TEXT    NOT NULL,
        envelope_snapshot JSON,
        destination_uid   INTEGER,
        PRIMARY KEY (intent_id, account_id, mailbox, uid)
      );

      INSERT OR IGNORE INTO intent_targets_v2
        (intent_id, account_id, uid, mailbox, envelope_snapshot, destination_uid)
      SELECT intent_id, account_id, uid, mailbox, envelope_snapshot, destination_uid
      FROM intent_targets;

      DROP TABLE intent_targets;
      ALTER TABLE intent_targets_v2 RENAME TO intent_targets;
    `));
  }

  // Migration 7: record the mailbox generation a UID was captured in.
  //
  // IMAP UIDs are meaningful only within a (mailbox, UIDVALIDITY) pair. Every
  // replay path — restore_messages, undo_intent, and a durable queue's
  // at-least-once retry — moves mail by recorded UID, so replaying across a
  // generation boundary would move messages the user never selected. Nullable
  // on purpose: rows written before this migration have no generation and must
  // stay usable, or undo breaks for everything already in the ledger.
  const targetColsV2 = db
    .prepare(`PRAGMA table_info(intent_targets)`)
    .all() as Array<{ name: string }>;
  if (!targetColsV2.map((c) => c.name).includes('uidvalidity')) {
    db.exec(`ALTER TABLE intent_targets ADD COLUMN uidvalidity INTEGER`);
  }

  // Migration 8: record the generation the *destination* UID belongs to.
  //
  // `uidvalidity` describes (mailbox, uid) — where the message came from. But
  // every replay path moves `destination_uid`, which lives in the mailbox the
  // message was moved *into*: restore and the hold undo both move it back out
  // of the holding folder. Checking the source mailbox's generation there would
  // guard the wrong mailbox — it would miss a rebuild of holding entirely while
  // refusing restores into a mailbox that was merely recreated. Nullable for
  // the same back-compat reason as migration 7.
  const targetColsV3 = db
    .prepare(`PRAGMA table_info(intent_targets)`)
    .all() as Array<{ name: string }>;
  if (!targetColsV3.map((c) => c.name).includes('destination_uidvalidity')) {
    db.exec(`ALTER TABLE intent_targets ADD COLUMN destination_uidvalidity INTEGER`);
  }

  // Migration 9: the ledger becomes the queue.
  //
  // Adds the `queued` status and the four claim columns. SQLite cannot ALTER a
  // CHECK constraint, so this rebuilds `intents` the way migration 6 rebuilt
  // `intent_targets`. Every column added by an earlier migration —
  // reverses_intent_id, reversed_by_intent_id, progress — has to be carried
  // across by name; a rebuild that quietly drops one breaks undo links and
  // progress reporting without failing anything.
  const intentsSql = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'intents'`)
    .get() as { sql: string } | undefined;

  if (intentsSql && !/'queued'/.test(intentsSql.sql)) {
    rebuildTable(db, () => db.exec(`
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

      INSERT INTO intents_v2
        (id, account_id, tool, params, risk, status, error_detail, agent_id,
         created_at, resolved_at, resolved_by, undo_token, undo_expires_at,
         reverses_intent_id, reversed_by_intent_id, progress)
      SELECT
         id, account_id, tool, params, risk, status, error_detail, agent_id,
         created_at, resolved_at, resolved_by, undo_token, undo_expires_at,
         reverses_intent_id, reversed_by_intent_id, progress
      FROM intents;

      DROP TABLE intents;
      ALTER TABLE intents_v2 RENAME TO intents;
    `));
  }

  // Partial index: the worker's claim query only ever looks at live work, and
  // the ledger is mostly terminal rows. Created after the rebuild because
  // DROP TABLE takes its indexes with it.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_intents_queued
      ON intents(status, created_at)
      WHERE status IN ('queued', 'executing')
  `);

  // Migration 10: somewhere for the worker to say it is alive.
  //
  // The worker runs inside the daemon; the MCP server and the CLI are separate
  // processes that can see nothing of it. The ledger file is the only thing all
  // three share, so liveness is written here. Single row on purpose — this
  // answers one question, and a growing log would cost a long-running daemon
  // writes nobody reads.
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_heartbeat (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      worker_id    TEXT    NOT NULL,
      pid          INTEGER NOT NULL,
      last_seen_at DATETIME NOT NULL
    )
  `);

  // Migration 11: create scan_jobs table for async read scans (long reads that
  // return a pollable handle instead of blocking the MCP request). Separate
  // from intents — scans are idempotent reads with a result blob, not gated
  // reversible side effects.
  //
  // Numbered 5 on the branch that introduced it, which predates migrations 5-10
  // on main; renumbered on merge. The step itself is order-independent — it
  // guards with IF NOT EXISTS on a table no other migration touches.
  db.exec(`
    CREATE TABLE IF NOT EXISTS scan_jobs (
      id           TEXT PRIMARY KEY,
      tool         TEXT NOT NULL,
      params       JSON NOT NULL,
      status       TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'done', 'failed')),
      result       JSON,
      error_detail JSON,
      agent_id     TEXT,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    )
  `);
}
