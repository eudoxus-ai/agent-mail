import type { Database } from '../ledger/sqlite.js';
import type { Participant } from '../types.js';
import type { SearchCursor } from '../lib/search-cursor.js';
import { classifyCategory, type Category } from '../attention/category.js';
import { toFtsMatchQuery } from './fts-query.js';
import { inMailboxes, type MailboxRef } from './mailboxes.js';
import { FTS_WEIGHTS } from './schema.js';

/**
 * Cache-backed reads.
 *
 * Returns the shape searchThreadsMulti produces, so shadow mode can diff the
 * two answers directly, short of the fields that need the account
 * configuration: from_me and replied_to_sender. Knows nothing about IMAP.
 */

export interface CachedSearchParams {
  /** Every account's mailbox the search reads, as one date-ordered result. */
  mailboxes: MailboxRef[];
  /** Only messages in this conversation, by the cache's thread root. */
  threadId?: string;
  query?: string;
  from?: string;
  listId?: string;
  to?: string;
  subject?: string;
  since?: Date;
  before?: Date;
  /** Return only rows after this one in search order. */
  cursor?: SearchCursor;
  limit: number;
}

export interface CachedSearchRow {
  account_id: string;
  mailbox: string;
  uid: number;
  /**
   * The generation the UID belongs to. A cached UID is only meaningful while
   * this still matches the mailbox, so anything that acts on one by UID has to
   * check it first.
   */
  uidvalidity: number;
  envelope: {
    message_id: string;
    subject: string;
    from: Participant;
    date: string;
  };
  snippet: string;
  flags: string[];
  from_address: string;
  from_name: string | null;
  to: Participant[];
  cc: Participant[];
  thread_id: string | null;
  in_reply_to: string | null;
  list_id: string | null;
  list_unsubscribe: string | null;
  is_list_mail: boolean;
  category: Category;
  target: { account_id: string; uid: number; mailbox: string };
  attachments: Array<{
    part_id: string;
    filename: string | null;
    mime_type: string | null;
    size: number | null;
  }>;
}

interface RawRow {
  id: number;
  account_id: string;
  mailbox: string;
  uid: number;
  uidvalidity: number;
  message_id: string | null;
  subject: string;
  snippet: string;
  date: number;
  from_address: string | null;
  from_name: string | null;
  to_json: string;
  cc_json: string;
  thread_id: string | null;
  in_reply_to: string | null;
  flags: string;
  list_id: string | null;
  list_unsub: string | null;
  is_list_mail: number;
}

export function searchCache(
  db: Database,
  params: CachedSearchParams
): CachedSearchRow[] {
  if (params.mailboxes.length === 0) return [];

  const where: string[] = [];
  const args: Array<string | number> = [];

  const matchExpr = toFtsMatchQuery(params.query);

  // Two shapes rather than one with a conditional join: FTS5 requires the
  // virtual table to drive the query for MATCH to be usable, while the
  // no-query case is a plain indexed scan on (account_id, date DESC).
  const base = matchExpr
    ? `SELECT m.* FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       WHERE messages_fts MATCH ?`
    : `SELECT m.* FROM messages m WHERE 1 = 1`;

  if (matchExpr) args.push(matchExpr);

  const scope = inMailboxes('m', params.mailboxes);
  where.push(scope.sql);
  args.push(...scope.args);

  if (params.threadId) {
    where.push(`m.thread_id = ?`);
    args.push(params.threadId);
  }

  if (params.since) {
    where.push(`m.date >= ?`);
    args.push(params.since.getTime());
  }
  if (params.before) {
    where.push(`m.date < ?`);
    args.push(params.before.getTime());
  }
  if (params.cursor) {
    const { before, account_id, mailbox, uid } = params.cursor;
    where.push(`(m.date, m.account_id, m.mailbox, m.uid) < (?, ?, ?, ?)`);
    args.push(Date.parse(before), account_id, mailbox, uid);
  }

  // Structured filters are substring matches on the stored values, matching
  // IMAP SEARCH FROM/TO/SUBJECT semantics rather than FTS tokenization.
  if (params.from) {
    where.push(`(LOWER(m.from_address) LIKE ? OR LOWER(COALESCE(m.from_name, '')) LIKE ?)`);
    const needle = `%${params.from.toLowerCase()}%`;
    args.push(needle, needle);
  }
  if (params.listId) {
    where.push(`LOWER(m.list_id) LIKE ?`);
    args.push(`%${params.listId.toLowerCase()}%`);
  }
  if (params.to) {
    where.push(`LOWER(m.to_json) LIKE ?`);
    args.push(`%${params.to.toLowerCase()}%`);
  }
  if (params.subject) {
    where.push(`LOWER(m.subject) LIKE ?`);
    args.push(`%${params.subject.toLowerCase()}%`);
  }

  // Both shapes use the order defined in lib/search-cursor.ts, and the cursor
  // predicate above is its keyset. Relevance ranking is deliberately
  // NOT used for ordering: search_threads is documented to return newest-first,
  // and shadow mode can only diff the two paths if ordering matches.
  const sql = `${base} AND ${where.join(' AND ')}
    ORDER BY m.date DESC, m.account_id DESC, m.mailbox DESC, m.uid DESC LIMIT ?`;
  args.push(params.limit);

  const rows = db.prepare(sql).all(...args) as unknown as RawRow[];
  return rows.map((row) => hydrate(db, row));
}

function hydrate(db: Database, row: RawRow): CachedSearchRow {
  const flags = safeParse<string[]>(row.flags, []);
  const listUnsub = safeParse<{ raw?: string } | null>(row.list_unsub, null);

  const attachments = db
    .prepare(
      `SELECT part_id, filename, mime_type, size FROM attachments WHERE message_id_fk = ?`
    )
    .all(row.id) as CachedSearchRow['attachments'];

  return {
    account_id: row.account_id,
    mailbox: row.mailbox,
    uid: row.uid,
    uidvalidity: row.uidvalidity,
    envelope: {
      message_id: row.message_id ?? '',
      subject: row.subject,
      from: { address: row.from_address ?? '', name: row.from_name },
      date: new Date(row.date).toISOString(),
    },
    snippet: row.snippet,
    flags,
    from_address: row.from_address ?? '',
    from_name: row.from_name,
    to: safeParse<Participant[]>(row.to_json, []),
    cc: safeParse<Participant[]>(row.cc_json, []),
    thread_id: row.thread_id,
    in_reply_to: row.in_reply_to,
    list_id: row.list_id,
    list_unsubscribe: listUnsub?.raw ?? null,
    is_list_mail: row.is_list_mail === 1,
    // Classified here rather than read from messages.category, which holds
    // whatever the classifier said when the row was ingested.
    category: classifyCategory({
      list_id: row.list_id,
      list_unsubscribe: listUnsub?.raw ?? null,
      subject: row.subject,
      from_address: row.from_address,
    }),
    target: { account_id: row.account_id, uid: row.uid, mailbox: row.mailbox },
    attachments,
  };
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Per-account result counts for the search_threads envelope. */
export function countByAccount(rows: Array<{ account_id: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.account_id] = (counts[row.account_id] ?? 0) + 1;
  }
  return counts;
}

/** Relevance-ranked search. Not wired to search_threads; used by shadow diagnostics. */
export function rankedSearch(
  db: Database,
  params: CachedSearchParams
): CachedSearchRow[] {
  const matchExpr = toFtsMatchQuery(params.query);
  if (!matchExpr || params.mailboxes.length === 0) return [];

  const scope = inMailboxes('m', params.mailboxes);
  const rows = db
    .prepare(
      `SELECT m.* FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       WHERE messages_fts MATCH ?
         AND ${scope.sql}
       ORDER BY bm25(messages_fts, ${FTS_WEIGHTS.subject}, ${FTS_WEIGHTS.body}, ${FTS_WEIGHTS.participants}, ${FTS_WEIGHTS.attachment_names})
       LIMIT ?`
    )
    .all(matchExpr, ...scope.args, params.limit) as unknown as RawRow[];

  return rows.map((row) => hydrate(db, row));
}

/**
 * For each address, how many messages in the `sent` mailboxes have it in To
 * or Cc. One statement for a whole page: sent mail is a small share of a
 * cache, so reading its recipient lists with json_each is cheap.
 */
export function sentToCounts(
  db: Database,
  sent: MailboxRef[],
  addresses: string[]
): Map<string, number> {
  const wanted = [...new Set(addresses.map((a) => a.toLowerCase()).filter(Boolean))];
  if (sent.length === 0 || wanted.length === 0) return new Map();

  const scope = inMailboxes('m', sent);
  const rows = db
    .prepare(
      `SELECT address, COUNT(DISTINCT id) AS n FROM (
         SELECT m.id, LOWER(json_extract(r.value, '$.address')) AS address
         FROM messages m, json_each(m.to_json) r WHERE ${scope.sql}
         UNION ALL
         SELECT m.id, LOWER(json_extract(r.value, '$.address')) AS address
         FROM messages m, json_each(m.cc_json) r WHERE ${scope.sql}
       )
       WHERE address IN (${wanted.map(() => '?').join(', ')})
       GROUP BY address`
    )
    .all(...scope.args, ...scope.args, ...wanted) as Array<{ address: string; n: number }>;
  return new Map(rows.map((r) => [r.address, r.n]));
}
