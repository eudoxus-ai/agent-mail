import type { Database } from '../ledger/sqlite.js';
import { inMailboxes, type MailboxRef } from './mailboxes.js';

/** Someone the operator exchanged mail with, seen from the cache. */
export interface Correspondent {
  address: string;
  /** The most recent display name used for them, in either direction. */
  name: string | null;
  /** Messages from them outside the sent mailboxes. */
  received: number;
  /** Messages in the sent mailboxes with them in To or Cc. */
  sent: number;
  first_contact_at: string;
  last_received_at: string | null;
  last_sent_at: string | null;
  last_direction: 'received' | 'sent';
  /** Distinct conversations, in either direction. */
  threads: number;
  /** Whether any of their mail to the operator was list mail. */
  is_list_sender: boolean;
}

export interface CorrespondentQuery {
  accountIds: string[];
  /** The sent mailboxes of those accounts. Mail in them is outbound, everything else inbound. */
  sent: MailboxRef[];
  /** The operator's own addresses, which are not correspondents. */
  exclude: string[];
  since?: Date;
  before?: Date;
  minSent: number;
  limit: number;
}

interface Row {
  address: string;
  name: string | null;
  received: number;
  sent: number;
  first_contact: number;
  last_received: number | null;
  last_sent: number | null;
  threads: number;
  is_list_sender: number;
  total: number;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/**
 * One row per address, busiest first. Inbound mail is grouped by sender and
 * outbound mail by every To and Cc recipient, in one statement, so that a
 * conversation running both ways counts once in `threads`.
 */
export function listCorrespondents(
  db: Database,
  q: CorrespondentQuery
): { total: number; correspondents: Correspondent[] } {
  if (q.accountIds.length === 0) return { total: 0, correspondents: [] };

  const dateSql: string[] = [];
  const dateArgs: number[] = [];
  if (q.since) {
    dateSql.push(' AND m.date >= ?');
    dateArgs.push(q.since.getTime());
  }
  if (q.before) {
    dateSql.push(' AND m.date < ?');
    dateArgs.push(q.before.getTime());
  }
  const dates = dateSql.join('');

  const sent = q.sent.length > 0 ? inMailboxes('m', q.sent) : null;
  const branches = [
    `SELECT LOWER(m.from_address) AS address, 1 AS inbound, m.id, m.date, m.thread_id,
            m.from_name AS name, m.is_list_mail
     FROM messages m
     WHERE m.account_id IN (${q.accountIds.map(() => '?').join(', ')})
       ${sent ? `AND NOT ${sent.sql}` : ''}${dates}`,
  ];
  const args: Array<string | number> = [...q.accountIds, ...(sent?.args ?? []), ...dateArgs];
  if (sent) {
    for (const list of ['to_json', 'cc_json']) {
      branches.push(
        `SELECT LOWER(json_extract(r.value, '$.address')), 0, m.id, m.date, m.thread_id,
                json_extract(r.value, '$.name'), 0
         FROM messages m, json_each(m.${list}) r
         WHERE ${sent.sql}${dates}`
      );
      args.push(...sent.args, ...dateArgs);
    }
  }

  const exclude = [...new Set(q.exclude.map((a) => a.toLowerCase()))];
  const rows = db
    .prepare(
      `WITH contact AS (${branches.join(' UNION ALL ')}),
       named AS (
         SELECT *, FIRST_VALUE(name) OVER (
           PARTITION BY address ORDER BY COALESCE(name, '') = '', date DESC
         ) AS latest_name
         FROM contact
         WHERE COALESCE(address, '') != ''
           ${exclude.length > 0 ? `AND address NOT IN (${exclude.map(() => '?').join(', ')})` : ''}
       ),
       grouped AS (
         SELECT address,
                MAX(latest_name) AS name,
                COUNT(DISTINCT CASE WHEN inbound = 1 THEN id END) AS received,
                COUNT(DISTINCT CASE WHEN inbound = 0 THEN id END) AS sent,
                MIN(date) AS first_contact,
                MAX(CASE WHEN inbound = 1 THEN date END) AS last_received,
                MAX(CASE WHEN inbound = 0 THEN date END) AS last_sent,
                COUNT(DISTINCT thread_id) AS threads,
                MAX(is_list_mail) AS is_list_sender
         FROM named
         GROUP BY address
       )
       SELECT *, COUNT(*) OVER () AS total
       FROM grouped
       WHERE sent >= ?
       ORDER BY sent + received DESC, address
       LIMIT ?`
    )
    .all(...args, ...exclude, q.minSent, q.limit) as unknown as Row[];

  return {
    total: rows[0]?.total ?? 0,
    correspondents: rows.map((row) => ({
      address: row.address,
      name: row.name || null,
      received: row.received,
      sent: row.sent,
      first_contact_at: new Date(row.first_contact).toISOString(),
      last_received_at: iso(row.last_received),
      last_sent_at: iso(row.last_sent),
      last_direction:
        row.last_sent !== null && (row.last_received === null || row.last_sent >= row.last_received)
          ? 'sent'
          : 'received',
      threads: row.threads,
      is_list_sender: row.is_list_sender === 1,
    })),
  };
}
