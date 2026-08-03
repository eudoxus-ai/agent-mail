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
  destination_uid?: number;
}

export interface IntentTargetRow {
  intent_id: string;
  account_id: string;
  uid: number;
  mailbox: string;
  envelope_snapshot: EnvelopeSnapshot | null;
  destination_uid: number | null;
}

export function insertIntentTargets(
  db: Database,
  intentId: string,
  targets: IntentTargetInsert[]
): void {
  // Upsert rather than plain insert: targets are now written *before* the IMAP
  // move so a crash mid-operation still leaves a restorable record, and the
  // destination UID is filled in afterwards. A retry of the same batch must
  // not collide on the primary key.
  const stmt = db.prepare(
    `INSERT INTO intent_targets (intent_id, account_id, uid, mailbox, envelope_snapshot, destination_uid)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(intent_id, account_id, uid) DO UPDATE SET
       mailbox = excluded.mailbox,
       envelope_snapshot = COALESCE(excluded.envelope_snapshot, intent_targets.envelope_snapshot),
       destination_uid = COALESCE(excluded.destination_uid, intent_targets.destination_uid)`
  );
  for (const t of targets) {
    stmt.run(
      intentId,
      t.account_id,
      t.uid,
      t.mailbox,
      t.envelope_snapshot ? JSON.stringify(t.envelope_snapshot) : null,
      t.destination_uid ?? null
    );
  }
}

/**
 * Record where each message actually landed, after the move reports its UID
 * remapping. Separate from the insert so the restorable record exists before
 * any mail is touched.
 */
export function updateIntentTargetDestinations(
  db: Database,
  intentId: string,
  accountId: string,
  uidMap: Map<number, number>
): void {
  if (uidMap.size === 0) return;
  const stmt = db.prepare(
    `UPDATE intent_targets SET destination_uid = ?
     WHERE intent_id = ? AND account_id = ? AND uid = ?`
  );
  for (const [sourceUid, destinationUid] of uidMap) {
    stmt.run(destinationUid, intentId, accountId, sourceUid);
  }
}

/**
 * Targets recorded but never confirmed as moved — the signature of a run that
 * died between the ledger write and the IMAP move completing.
 */
export function getUnconfirmedTargets(
  db: Database,
  intentId: string
): IntentTargetRow[] {
  return getIntentTargets(db, intentId).filter((t) => t.destination_uid === null);
}

export function getIntentTargets(db: Database, intentId: string): IntentTargetRow[] {
  const rows = db
    .prepare(
      `SELECT intent_id, account_id, uid, mailbox, envelope_snapshot, destination_uid
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
    destination_uid: r.destination_uid != null ? Number(r.destination_uid) : null,
  }));
}
