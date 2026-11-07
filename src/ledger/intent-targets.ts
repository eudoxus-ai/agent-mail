import type { Database } from './sqlite.js';

export interface EnvelopeSnapshot {
  subject: string;
  from: string;
  original_mailbox: string;
  /** Finds the message when its UID was never confirmed or has gone stale. */
  message_id?: string;
}

export interface IntentTargetInsert {
  account_id: string;
  uid: number;
  mailbox: string;
  envelope_snapshot?: EnvelopeSnapshot;
  destination_uid?: number;
  /** UIDVALIDITY of `mailbox` when this UID was captured. */
  uidvalidity?: number;
  /** UIDVALIDITY of the mailbox `destination_uid` lives in. */
  destination_uidvalidity?: number;
}

export interface IntentTargetRow {
  intent_id: string;
  account_id: string;
  uid: number;
  mailbox: string;
  envelope_snapshot: EnvelopeSnapshot | null;
  destination_uid: number | null;
  /**
   * Null for targets recorded before migration 7. Those predate the guard and
   * are allowed through rather than refused — see assertGenerationMatches.
   */
  uidvalidity: number | null;
  /**
   * The generation that makes `destination_uid` meaningful. This is the one
   * every replay path checks, because replays move the destination UID.
   */
  destination_uidvalidity: number | null;
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
    // Conflict key includes mailbox: IMAP UIDs are unique only within a
    // mailbox, so INBOX uid 123 and Archive uid 123 are different messages.
    // Keying without it silently overwrote one snapshot with the other and
    // left a moved message unrestorable.
    `INSERT INTO intent_targets
       (intent_id, account_id, uid, mailbox, envelope_snapshot, destination_uid,
        uidvalidity, destination_uidvalidity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(intent_id, account_id, mailbox, uid) DO UPDATE SET
       envelope_snapshot = COALESCE(excluded.envelope_snapshot, intent_targets.envelope_snapshot),
       destination_uid = COALESCE(excluded.destination_uid, intent_targets.destination_uid),
       -- COALESCE, not overwrite: a retry that omits the generation must not
       -- erase one already recorded, or the guard silently stops guarding.
       uidvalidity = COALESCE(excluded.uidvalidity, intent_targets.uidvalidity),
       destination_uidvalidity =
         COALESCE(excluded.destination_uidvalidity, intent_targets.destination_uidvalidity)`
  );
  for (const t of targets) {
    stmt.run(
      intentId,
      t.account_id,
      t.uid,
      t.mailbox,
      t.envelope_snapshot ? JSON.stringify(t.envelope_snapshot) : null,
      t.destination_uid ?? null,
      t.uidvalidity ?? null,
      t.destination_uidvalidity ?? null
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
  uidMap: Map<number, number>,
  mailbox: string,
  /** UIDVALIDITY of the mailbox the messages landed in. */
  destinationUidvalidity?: number
): void {
  if (uidMap.size === 0) return;

  // Scoped by mailbox for the same reason the conflict key includes it: the
  // same UID in two mailboxes is two messages.
  //
  // COALESCE on the generation so a caller without one can't erase it.
  const stmt = db.prepare(
    `UPDATE intent_targets
        SET destination_uid = ?,
            destination_uidvalidity = COALESCE(?, destination_uidvalidity)
      WHERE intent_id = ? AND account_id = ? AND mailbox = ? AND uid = ?`
  );

  const generation = destinationUidvalidity ?? null;
  for (const [sourceUid, destinationUid] of uidMap) {
    stmt.run(destinationUid, generation, intentId, accountId, mailbox, sourceUid);
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
      `SELECT intent_id, account_id, uid, mailbox, envelope_snapshot, destination_uid,
              uidvalidity, destination_uidvalidity
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
    uidvalidity: r.uidvalidity != null ? Number(r.uidvalidity) : null,
    destination_uidvalidity:
      r.destination_uidvalidity != null ? Number(r.destination_uidvalidity) : null,
  }));
}
