import { gzipSync, gunzipSync } from 'node:zlib';
import type { Database } from '../ledger/sqlite.js';
import { toMessageRow, toFtsRow, htmlToText, deriveSnippet, type IngestInput } from './ingest.js';
import { linkMessage, applyMerge, syntheticThreadId } from './threading.js';

/**
 * Transactional writes against the cache. Every mutation here keeps three
 * things consistent: the messages row, its FTS5 shadow row (rowid == messages.id),
 * and the thread graph.
 *
 * Nothing in this module talks to IMAP. It is fed by sync.ts.
 */

export function withTransaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // A failed rollback means the transaction was already resolved; the
      // original error is the one worth propagating.
    }
    throw error;
  }
}

const UPSERT_SQL = `
INSERT INTO messages (
  account_id, mailbox, uid, uidvalidity, modseq, message_id, thread_id,
  in_reply_to, refs, from_address, from_name, to_json, cc_json, date, subject,
  snippet, flags, seen, flagged, answered, list_id, list_unsub, is_list_mail,
  category, size, has_attach, body_state
) VALUES (
  ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?
)
ON CONFLICT(account_id, mailbox, uidvalidity, uid) DO UPDATE SET
  modseq       = excluded.modseq,
  thread_id    = excluded.thread_id,
  flags        = excluded.flags,
  seen         = excluded.seen,
  flagged      = excluded.flagged,
  answered     = excluded.answered,
  snippet      = CASE WHEN excluded.snippet != '' THEN excluded.snippet ELSE messages.snippet END,
  -- Never downgrade a fetched body back to pending on a flags-only resync.
  body_state   = CASE WHEN messages.body_state = 'fetched' THEN 'fetched' ELSE excluded.body_state END
RETURNING id
`;

export interface UpsertResult {
  id: number;
  threadId: string;
}

/**
 * Insert or update one message. Idempotent: re-ingesting the same message
 * produces the same rows, which is what lets a backfill batch be safely retried.
 */
export function upsertMessage(db: Database, input: IngestInput): UpsertResult {
  const row = toMessageRow(input);

  const threadId = row.message_id
    ? (() => {
        const { root, merged } = linkMessage(db, {
          messageId: row.message_id,
          inReplyTo: row.in_reply_to,
          references: JSON.parse(row.refs) as string[],
        });
        applyMerge(db, root, merged);
        return root;
      })()
    : syntheticThreadId(row.account_id, row.mailbox, row.uid);

  const result = db
    .prepare(UPSERT_SQL)
    .get(
      row.account_id,
      row.mailbox,
      row.uid,
      row.uidvalidity,
      row.modseq,
      row.message_id,
      threadId,
      row.in_reply_to,
      row.refs,
      row.from_address,
      row.from_name,
      row.to_json,
      row.cc_json,
      row.date,
      row.subject,
      row.snippet,
      row.flags,
      row.seen,
      row.flagged,
      row.answered,
      row.list_id,
      row.list_unsub,
      row.is_list_mail,
      row.category,
      row.size,
      row.has_attach,
      row.body_state
    ) as { id: number };

  const id = Number(result.id);

  const attachments = input.attachments ?? [];
  if (attachments.length > 0) {
    const insertAttachment = db.prepare(
      `INSERT INTO attachments (message_id_fk, part_id, filename, mime_type, size)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(message_id_fk, part_id) DO UPDATE SET
         filename = excluded.filename,
         mime_type = excluded.mime_type,
         size = excluded.size`
    );
    for (const a of attachments) {
      insertAttachment.run(id, a.part_id, a.filename, a.mime_type, a.size);
    }
  }

  writeFts(db, id, toFtsRow(input));

  return { id, threadId };
}

/**
 * Replace a message's FTS row. Contentless FTS5 has no usable UPDATE, so the
 * delete-then-insert is the supported path (contentless_delete=1 makes the
 * delete possible at all).
 */
function writeFts(
  db: Database,
  id: number,
  fts: { subject: string; body: string; participants: string; attachment_names: string }
): void {
  db.prepare(`DELETE FROM messages_fts WHERE rowid = ?`).run(id);
  db.prepare(
    `INSERT INTO messages_fts (rowid, subject, body, participants, attachment_names)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, fts.subject, fts.body, fts.participants, fts.attachment_names);
}

export interface BodyInput {
  text?: string | null;
  html?: string | null;
  charset?: string | null;
}

/**
 * Attach a fetched body and reindex. Bodies arrive after envelopes, so this
 * rebuilds the FTS row from the stored columns rather than requiring the caller
 * to hand back the original EmailMessage.
 */
export function attachBody(db: Database, id: number, body: BodyInput): void {
  const text =
    body.text && body.text.trim()
      ? body.text
      : body.html
        ? htmlToText(body.html)
        : '';

  db.prepare(
    `INSERT INTO bodies (message_id_fk, body_text, body_html_gz, charset)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(message_id_fk) DO UPDATE SET
       body_text = excluded.body_text,
       body_html_gz = excluded.body_html_gz,
       charset = excluded.charset`
  ).run(
    id,
    text,
    body.html ? gzipSync(Buffer.from(body.html, 'utf8')) : null,
    body.charset ?? null
  );

  const row = db
    .prepare(`SELECT subject, snippet, from_address, from_name, to_json, cc_json FROM messages WHERE id = ?`)
    .get(id) as
    | {
        subject: string;
        snippet: string;
        from_address: string | null;
        from_name: string | null;
        to_json: string;
        cc_json: string;
      }
    | undefined;

  if (!row) return;

  const names = db
    .prepare(`SELECT filename FROM attachments WHERE message_id_fk = ?`)
    .all(id) as Array<{ filename: string | null }>;

  const participants = [
    row.from_name ? `${row.from_name} <${row.from_address}>` : row.from_address,
    ...(JSON.parse(row.to_json) as Array<{ address: string; name: string | null }>).map((p) =>
      p.name ? `${p.name} <${p.address}>` : p.address
    ),
    ...(JSON.parse(row.cc_json) as Array<{ address: string; name: string | null }>).map((p) =>
      p.name ? `${p.name} <${p.address}>` : p.address
    ),
  ]
    .filter(Boolean)
    .join(' ');

  writeFts(db, id, {
    subject: row.subject,
    body: text,
    participants,
    attachment_names: names
      .map((n) => n.filename)
      .filter((n): n is string => Boolean(n))
      .join(' '),
  });

  // A row ingested envelope-first has no snippet; fill it now that we have text.
  db.prepare(
    `UPDATE messages
     SET body_state = 'fetched',
         snippet = CASE WHEN snippet = '' THEN ? ELSE snippet END
     WHERE id = ?`
  ).run(deriveSnippet(text), id);
}

export function readBodyHtml(db: Database, id: number): string | null {
  const row = db
    .prepare(`SELECT body_html_gz FROM bodies WHERE message_id_fk = ?`)
    .get(id) as { body_html_gz: Uint8Array | null } | undefined;
  if (!row?.body_html_gz) return null;
  return gunzipSync(Buffer.from(row.body_html_gz)).toString('utf8');
}

/** Remove messages the server reported as VANISHED, keeping FTS in step. */
/**
 * One bind parameter per UID, and SQLite caps a statement at 32766 of them
 * (SQLITE_MAX_VARIABLE_NUMBER; verified against node:sqlite). The vanished
 * list comes from the network — a QRESYNC VANISHED (EARLIER) can cover a
 * mailbox's whole expunge history, and one iCloud server bug emits responses
 * spanning the entire mailbox — so its size is not ours to assume. Well under
 * the cap, and small enough that no single statement gets slow.
 */
const DELETE_CHUNK = 500;

export function deleteMessages(
  db: Database,
  params: { accountId: string; mailbox: string; uidvalidity: number; uids: number[] }
): number {
  if (params.uids.length === 0) return 0;

  let deleted = 0;
  for (let start = 0; start < params.uids.length; start += DELETE_CHUNK) {
    const chunk = params.uids.slice(start, start + DELETE_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT id FROM messages
         WHERE account_id = ? AND mailbox = ? AND uidvalidity = ? AND uid IN (${placeholders})`
      )
      .all(params.accountId, params.mailbox, params.uidvalidity, ...chunk) as Array<{
      id: number;
    }>;

    for (const { id } of rows) {
      db.prepare(`DELETE FROM messages_fts WHERE rowid = ?`).run(id);
      db.prepare(`DELETE FROM messages WHERE id = ?`).run(id);
    }
    deleted += rows.length;
  }

  // thread_links rows are intentionally left behind: a message vanishing from
  // one mailbox (moved to holding, archived) shouldn't dissolve the thread it
  // belonged to, and a stale link costs one row.
  return deleted;
}

/**
 * Apply a flag change without refetching the message. Used both by delta sync
 * and by the optimistic echo after a mutation (design D2).
 */
export function updateFlags(
  db: Database,
  params: {
    accountId: string;
    mailbox: string;
    uidvalidity: number;
    uid: number;
    flags: string[];
    modseq?: number | null;
  }
): void {
  const lower = params.flags.map((f) => f.toLowerCase());
  db.prepare(
    `UPDATE messages
     SET flags = ?, seen = ?, flagged = ?, answered = ?, modseq = COALESCE(?, modseq)
     WHERE account_id = ? AND mailbox = ? AND uidvalidity = ? AND uid = ?`
  ).run(
    JSON.stringify(params.flags),
    lower.includes('\\seen') ? 1 : 0,
    lower.includes('\\flagged') ? 1 : 0,
    lower.includes('\\answered') ? 1 : 0,
    params.modseq ?? null,
    params.accountId,
    params.mailbox,
    params.uidvalidity,
    params.uid
  );
}
