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

export interface MailboxSummary extends MailboxRef {
  role: MailboxRole;
  messages: number;
  /** The oldest message the cache holds, as ISO8601. */
  oldest: string | null;
  backfill_complete: boolean;
}

/** What the cache holds in each mailbox of these accounts. */
export function summarizeMailboxes(db: Database, accountIds: string[]): MailboxSummary[] {
  if (accountIds.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT s.account_id, s.mailbox, s.backfill_complete, s.oldest_date,
              (SELECT COUNT(*) FROM messages m
               WHERE m.account_id = s.account_id AND m.mailbox = s.mailbox) AS messages
       FROM mailbox_state s
       WHERE s.account_id IN (${accountIds.map(() => '?').join(', ')})
       ORDER BY s.account_id, s.mailbox`
    )
    .all(...accountIds) as unknown as Array<
    MailboxRef & { backfill_complete: number; oldest_date: number | null; messages: number }
  >;
  return rows.map((row) => ({
    account_id: row.account_id,
    mailbox: row.mailbox,
    role: mailboxRole(row.mailbox),
    messages: row.messages,
    oldest: row.oldest_date ? new Date(row.oldest_date).toISOString() : null,
    backfill_complete: row.backfill_complete === 1,
  }));
}

/** Each From address in the `sent` mailboxes and how many messages used it, busiest first. */
export function sentFromAddresses(
  db: Database,
  sent: MailboxRef[]
): Array<{ account_id: string; address: string; sent: number }> {
  if (sent.length === 0) return [];
  const scope = inMailboxes('m', sent);
  return db
    .prepare(
      `SELECT m.account_id, LOWER(m.from_address) AS address, COUNT(*) AS sent
       FROM messages m
       WHERE ${scope.sql} AND COALESCE(m.from_address, '') != ''
       GROUP BY m.account_id, LOWER(m.from_address)
       ORDER BY sent DESC, address`
    )
    .all(...scope.args) as Array<{ account_id: string; address: string; sent: number }>;
}
