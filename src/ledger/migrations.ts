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
}
