import type { Database } from '../ledger/sqlite.js';
import { isSentMailboxName } from '../lib/sent-mailboxes.js';

/** One mailbox of one account. A UID means something only within one of these. */
export interface MailboxRef {
  account_id: string;
  mailbox: string;
}

export type MailboxRole = 'inbox' | 'sent' | 'other';

/** The cache keeps no special-use flags, so a cached mailbox's role comes from its name. */
export function mailboxRole(mailbox: string): MailboxRole {
  if (mailbox.toUpperCase() === 'INBOX') return 'inbox';
  return isSentMailboxName(mailbox) ? 'sent' : 'other';
}

/** Every mailbox the cache has sync state for, in these accounts. */
export function cachedMailboxes(
  db: Database,
  accountIds: string[]
): Array<MailboxRef & { role: MailboxRole }> {
  if (accountIds.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT account_id, mailbox FROM mailbox_state
       WHERE account_id IN (${accountIds.map(() => '?').join(', ')})
       ORDER BY account_id, mailbox`
    )
    .all(...accountIds) as unknown as MailboxRef[];
  return rows.map((row) => ({ ...row, role: mailboxRole(row.mailbox) }));
}

/** The cached mailboxes holding mail the operator sent, in these accounts. */
export function sentMailboxes(db: Database, accountIds: string[]): MailboxRef[] {
  return cachedMailboxes(db, accountIds)
    .filter((m) => m.role === 'sent')
    .map(({ account_id, mailbox }) => ({ account_id, mailbox }));
}

/** A WHERE clause matching rows of `alias` that sit in one of `refs`, which must not be empty. */
export function inMailboxes(alias: string, refs: MailboxRef[]): { sql: string; args: string[] } {
  return {
    sql: `(${alias}.account_id, ${alias}.mailbox) IN (VALUES ${refs.map(() => '(?, ?)').join(', ')})`,
    args: refs.flatMap((r) => [r.account_id, r.mailbox]),
  };
}
