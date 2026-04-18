import type { Database } from './sqlite.js';

export interface EnvelopeSnapshot {
  subject: string;
  from: string;
  original_mailbox: string;
}

export interface IntentTargetInsert {
  account_id: string;
  uid: number;
  mailbox: string;
  envelope_snapshot?: EnvelopeSnapshot;
}

export interface IntentTargetRow {
  intent_id: string;
  account_id: string;
  uid: number;
  mailbox: string;
  envelope_snapshot: EnvelopeSnapshot | null;
}

export function insertIntentTargets(
  db: Database,
  intentId: string,
  targets: IntentTargetInsert[]
): void {
  const stmt = db.prepare(
    `INSERT INTO intent_targets (intent_id, account_id, uid, mailbox, envelope_snapshot)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const t of targets) {
    stmt.run(
      intentId,
      t.account_id,
      t.uid,
      t.mailbox,
      t.envelope_snapshot ? JSON.stringify(t.envelope_snapshot) : null
    );
  }
}

export function getIntentTargets(db: Database, intentId: string): IntentTargetRow[] {
  const rows = db
    .prepare(
      `SELECT intent_id, account_id, uid, mailbox, envelope_snapshot
       FROM intent_targets WHERE intent_id = ? ORDER BY account_id, uid`
    )
    .all(intentId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    intent_id: r.intent_id as string,
    account_id: r.account_id as string,
    uid: Number(r.uid),
    mailbox: r.mailbox as string,
    envelope_snapshot: r.envelope_snapshot
      ? (JSON.parse(r.envelope_snapshot as string) as EnvelopeSnapshot)
      : null,
  }));
}
