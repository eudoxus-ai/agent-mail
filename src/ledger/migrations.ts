import type { Database } from './sqlite.js';

export function runMigrations(db: Database): void {
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
    db.exec(`
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
    `);
  }
}
