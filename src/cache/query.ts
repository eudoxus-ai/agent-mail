import type { Database } from '../ledger/sqlite.js';
import type { Participant } from '../types.js';
import { toFtsMatchQuery } from './fts-query.js';
import { FTS_WEIGHTS } from './schema.js';

/**
 * Cache-backed reads.
 *
 * Returns the exact shape searchThreadsMulti already produces, so the tool
 * contract is untouched and shadow mode can diff the two answers directly.
 * Knows nothing about IMAP.
 */

export interface CachedSearchParams {
  accountIds: string[];
  mailbox: string;
  query?: string;
  from?: string;
  to?: string;
  subject?: string;
  since?: Date;
  before?: Date;
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
  list_id: string | null;
  list_unsubscribe: string | null;
  is_list_mail: boolean;
  category: string;
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
  flags: string;
  list_id: string | null;
  list_unsub: string | null;
  is_list_mail: number;
  category: string | null;
}

export function searchCache(
  db: Database,
  params: CachedSearchParams
): CachedSearchRow[] {
  if (params.accountIds.length === 0) return [];

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

  where.push(`m.account_id IN (${params.accountIds.map(() => '?').join(', ')})`);
  args.push(...params.accountIds);

  where.push(`m.mailbox = ?`);
  args.push(params.mailbox);

  if (params.since) {
    where.push(`m.date >= ?`);
    args.push(params.since.getTime());
  }
  if (params.before) {
    where.push(`m.date < ?`);
    args.push(params.before.getTime());
  }

  // Structured filters are substring matches on the stored values, matching
  // IMAP SEARCH FROM/TO/SUBJECT semantics rather than FTS tokenization.
  if (params.from) {
    where.push(`(LOWER(m.from_address) LIKE ? OR LOWER(COALESCE(m.from_name, '')) LIKE ?)`);
    const needle = `%${params.from.toLowerCase()}%`;
    args.push(needle, needle);
  }
  if (params.to) {
    where.push(`LOWER(m.to_json) LIKE ?`);
    args.push(`%${params.to.toLowerCase()}%`);
  }
  if (params.subject) {
    where.push(`LOWER(m.subject) LIKE ?`);
    args.push(`%${params.subject.toLowerCase()}%`);
  }

  // Ordering is date DESC in both shapes. Relevance ranking is deliberately
  // NOT used for ordering: search_threads is documented to return newest-first,
  // and shadow mode can only diff the two paths if ordering matches.
  const sql = `${base} AND ${where.join(' AND ')} ORDER BY m.date DESC, m.uid DESC LIMIT ?`;
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
    list_id: row.list_id,
    list_unsubscribe: listUnsub?.raw ?? null,
    is_list_mail: row.is_list_mail === 1,
    category: row.category ?? 'personal',
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

/** Per-account result counts, matching the IMAP path's envelope. */
export function countByAccount(rows: CachedSearchRow[]): Record<string, number> {
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
  if (!matchExpr || params.accountIds.length === 0) return [];

  const rows = db
    .prepare(
      `SELECT m.* FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       WHERE messages_fts MATCH ?
         AND m.account_id IN (${params.accountIds.map(() => '?').join(', ')})
       ORDER BY bm25(messages_fts, ${FTS_WEIGHTS.subject}, ${FTS_WEIGHTS.body}, ${FTS_WEIGHTS.participants}, ${FTS_WEIGHTS.attachment_names})
       LIMIT ?`
    )
    .all(matchExpr, ...params.accountIds, params.limit) as unknown as RawRow[];

  return rows.map((row) => hydrate(db, row));
}
