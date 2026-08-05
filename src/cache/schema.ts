/**
 * Cache schema. See docs/superpowers/specs/2026-07-31-local-message-cache-design.md.
 *
 * Everything here is derived from IMAP and can be rebuilt. No row in this
 * database is authoritative for anything — deleting cache.db loses nothing but
 * the time it takes to re-sync.
 */

export const CACHE_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY,
  account_id    TEXT    NOT NULL,
  mailbox       TEXT    NOT NULL,
  uid           INTEGER NOT NULL,
  uidvalidity   INTEGER NOT NULL,
  modseq        INTEGER,
  message_id    TEXT,
  thread_id     TEXT,
  in_reply_to   TEXT,
  refs          JSON    NOT NULL DEFAULT '[]',
  from_address  TEXT,
  from_name     TEXT,
  to_json       JSON    NOT NULL DEFAULT '[]',
  cc_json       JSON    NOT NULL DEFAULT '[]',
  date          INTEGER NOT NULL,
  subject       TEXT    NOT NULL DEFAULT '',
  snippet       TEXT    NOT NULL DEFAULT '',
  flags         JSON    NOT NULL DEFAULT '[]',
  seen          INTEGER NOT NULL DEFAULT 0,
  flagged       INTEGER NOT NULL DEFAULT 0,
  answered      INTEGER NOT NULL DEFAULT 0,
  list_id       TEXT,
  list_unsub    JSON,
  is_list_mail  INTEGER NOT NULL DEFAULT 0,
  category      TEXT,
  size          INTEGER,
  has_attach    INTEGER NOT NULL DEFAULT 0,
  body_state    TEXT    NOT NULL DEFAULT 'pending'
                CHECK (body_state IN ('pending', 'fetched', 'failed', 'skipped')),
  UNIQUE (account_id, mailbox, uidvalidity, uid)
);

CREATE INDEX IF NOT EXISTS idx_msg_recent  ON messages(account_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_msg_thread  ON messages(account_id, thread_id, date);
CREATE INDEX IF NOT EXISTS idx_msg_sender  ON messages(account_id, from_address, date DESC);
CREATE INDEX IF NOT EXISTS idx_msg_mid     ON messages(message_id);
CREATE INDEX IF NOT EXISTS idx_msg_pending ON messages(body_state) WHERE body_state = 'pending';

CREATE TABLE IF NOT EXISTS bodies (
  message_id_fk INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  body_text     TEXT,
  body_html_gz  BLOB,
  charset       TEXT
);

CREATE TABLE IF NOT EXISTS attachments (
  message_id_fk INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  part_id       TEXT    NOT NULL,
  filename      TEXT,
  mime_type     TEXT,
  size          INTEGER,
  PRIMARY KEY (message_id_fk, part_id)
);

-- Contentless FTS5. contentless_delete requires SQLite >= 3.43; openCache()
-- asserts the runtime supports it rather than failing later on a DELETE.
-- rowid is always messages.id, written in the same transaction as the row.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  subject,
  body,
  participants,
  attachment_names,
  content='',
  contentless_delete=1,
  tokenize='porter unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS thread_links (
  message_id TEXT PRIMARY KEY,
  root_id    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_thread_root ON thread_links(root_id);

CREATE TABLE IF NOT EXISTS mailbox_state (
  account_id        TEXT    NOT NULL,
  mailbox           TEXT    NOT NULL,
  uidvalidity       INTEGER,
  highestmodseq     INTEGER,
  uidnext           INTEGER,
  backfill_complete INTEGER NOT NULL DEFAULT 0,
  backfill_cursor   INTEGER,
  oldest_date       INTEGER,
  last_delta_at     INTEGER,
  last_flag_sync_at INTEGER,
  last_error        TEXT,
  PRIMARY KEY (account_id, mailbox)
);
`;

/** Column weights for bm25(). Subject beats body; participants beat filenames. */
export const FTS_WEIGHTS = {
  subject: 8.0,
  body: 1.0,
  participants: 4.0,
  attachment_names: 2.0,
} as const;
