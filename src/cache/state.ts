import type { Database } from '../ledger/sqlite.js';

/** Read/write helpers for mailbox_state — the sync engine's bookkeeping. */

export interface MailboxState {
  account_id: string;
  mailbox: string;
  uidvalidity: number | null;
  highestmodseq: number | null;
  uidnext: number | null;
  backfill_complete: number;
  backfill_cursor: number | null;
  oldest_date: number | null;
  last_delta_at: number | null;
  last_flag_sync_at: number | null;
  last_error: string | null;
}

export function getMailboxState(
  db: Database,
  accountId: string,
  mailbox: string
): MailboxState | null {
  const row = db
    .prepare(`SELECT * FROM mailbox_state WHERE account_id = ? AND mailbox = ?`)
    .get(accountId, mailbox) as MailboxState | undefined;
  return row ?? null;
}

export function upsertMailboxState(
  db: Database,
  accountId: string,
  mailbox: string,
  patch: Partial<Omit<MailboxState, 'account_id' | 'mailbox'>>
): void {
  db.prepare(
    `INSERT INTO mailbox_state (account_id, mailbox) VALUES (?, ?)
     ON CONFLICT(account_id, mailbox) DO NOTHING`
  ).run(accountId, mailbox);

  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;

  const assignments = entries.map(([k]) => `${k} = ?`).join(', ');
  db.prepare(
    `UPDATE mailbox_state SET ${assignments} WHERE account_id = ? AND mailbox = ?`
  ).run(...entries.map(([, v]) => v as never), accountId, mailbox);
}

/**
 * Drop every cached message for one mailbox. Used when UIDVALIDITY changes:
 * the server has reassigned UIDs, so every cached row for this mailbox is
 * referring to a message that may no longer be the one at that UID.
 */
export function purgeMailbox(
  db: Database,
  accountId: string,
  mailbox: string
): number {
  const rows = db
    .prepare(`SELECT id FROM messages WHERE account_id = ? AND mailbox = ?`)
    .all(accountId, mailbox) as Array<{ id: number }>;

  for (const { id } of rows) {
    db.prepare(`DELETE FROM messages_fts WHERE rowid = ?`).run(id);
  }
  db.prepare(`DELETE FROM messages WHERE account_id = ? AND mailbox = ?`).run(
    accountId,
    mailbox
  );

  db.prepare(
    `UPDATE mailbox_state
     SET backfill_complete = 0, backfill_cursor = NULL, highestmodseq = NULL, oldest_date = NULL
     WHERE account_id = ? AND mailbox = ?`
  ).run(accountId, mailbox);

  return rows.length;
}

/** UIDs currently cached for a mailbox generation, ascending. */
export function cachedUids(
  db: Database,
  accountId: string,
  mailbox: string,
  uidvalidity: number
): number[] {
  return (
    db
      .prepare(
        `SELECT uid FROM messages
         WHERE account_id = ? AND mailbox = ? AND uidvalidity = ?
         ORDER BY uid`
      )
      .all(accountId, mailbox, uidvalidity) as Array<{ uid: number }>
  ).map((r) => r.uid);
}

/** Message rowids still awaiting a body fetch, oldest-first by UID descending. */
export function pendingBodyUids(
  db: Database,
  accountId: string,
  mailbox: string,
  limit: number
): number[] {
  return (
    db
      .prepare(
        `SELECT uid FROM messages
         WHERE account_id = ? AND mailbox = ? AND body_state = 'pending'
         ORDER BY uid DESC
         LIMIT ?`
      )
      .all(accountId, mailbox, limit) as Array<{ uid: number }>
  ).map((r) => r.uid);
}
