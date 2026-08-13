import { describe, it, expect, beforeEach } from 'vitest';
import { openCache, type Database } from '../../src/cache/db.js';
import {
  upsertMessage,
  attachBody,
  deleteMessages,
  updateFlags,
  readBodyHtml,
  withTransaction,
} from '../../src/cache/store.js';
import { resolveRoot } from '../../src/cache/threading.js';
import type { EmailMessage } from '../../src/types.js';
import type { IngestInput } from '../../src/cache/ingest.js';

let db: Database;

beforeEach(() => {
  db = openCache(':memory:');
});

function msg(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    uid: 1,
    messageId: '<root@example.com>',
    from: { address: 'alice@example.com', name: 'Alice' },
    to: [{ address: 'you@example.com', name: null }],
    cc: [],
    date: '2026-06-01T10:00:00Z',
    subject: 'Q2 pricing',
    bodyText: 'We decided to hold the price steady.',
    references: [],
    flags: [],
    mailbox: 'INBOX',
    ...overrides,
  };
}

function ingest(overrides: Partial<IngestInput> = {}): IngestInput {
  return { accountId: 'work', message: msg(), uidvalidity: 1, ...overrides };
}

function search(query: string): number[] {
  return (
    db
      .prepare(
        `SELECT m.id FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         WHERE messages_fts MATCH ?
         ORDER BY bm25(messages_fts, 8.0, 1.0, 4.0, 2.0)`
      )
      .all(query) as Array<{ id: number }>
  ).map((r) => r.id);
}

describe('upsertMessage', () => {
  it('indexes subject, body, participants and attachment names', () => {
    const { id } = upsertMessage(
      db,
      ingest({
        attachments: [
          { part_id: '2', filename: 'pricing-deck.pdf', mime_type: null, size: null },
        ],
      })
    );

    expect(search('pricing')).toContain(id);
    expect(search('steady')).toContain(id);
    expect(search('alice')).toContain(id);
    expect(search('deck')).toContain(id);
  });

  it('is idempotent — re-ingesting does not duplicate rows or FTS entries', () => {
    upsertMessage(db, ingest());
    upsertMessage(db, ingest());

    const count = db.prepare(`SELECT COUNT(*) c FROM messages`).get() as { c: number };
    expect(count.c).toBe(1);
    expect(search('pricing').length).toBe(1);
  });

  it('ranks a subject hit above a body-only hit', () => {
    const subjectHit = upsertMessage(
      db,
      ingest({ message: msg({ uid: 1, messageId: '<s@x>', subject: 'Budget', bodyText: 'hello' }) })
    );
    const bodyHit = upsertMessage(
      db,
      ingest({
        message: msg({ uid: 2, messageId: '<b@x>', subject: 'hello', bodyText: 'the budget is fine' }),
      })
    );

    expect(search('budget')).toEqual([subjectHit.id, bodyHit.id]);
  });

  it('stores attachment metadata', () => {
    const { id } = upsertMessage(
      db,
      ingest({
        attachments: [
          { part_id: '2', filename: 'deck.pdf', mime_type: 'application/pdf', size: 1024 },
        ],
      })
    );
    const rows = db
      .prepare(`SELECT part_id, filename, size FROM attachments WHERE message_id_fk = ?`)
      .all(id);
    expect(rows).toEqual([{ part_id: '2', filename: 'deck.pdf', size: 1024 }]);
  });

  it('gives a message with no Message-Id its own synthetic thread', () => {
    const a = upsertMessage(db, ingest({ message: msg({ uid: 1, messageId: '' }) }));
    const b = upsertMessage(db, ingest({ message: msg({ uid: 2, messageId: '' }) }));

    const rows = db
      .prepare(`SELECT thread_id FROM messages WHERE id IN (?, ?)`)
      .all(a.id, b.id) as Array<{ thread_id: string }>;
    expect(rows[0].thread_id).not.toBe(rows[1].thread_id);
  });
});

describe('threading across mailboxes', () => {
  it('joins a Sent reply to its INBOX parent', () => {
    const inbox = upsertMessage(
      db,
      ingest({ message: msg({ uid: 1, messageId: '<root@x>', mailbox: 'INBOX' }) })
    );
    const sent = upsertMessage(
      db,
      ingest({
        message: msg({
          uid: 7,
          messageId: '<reply@x>',
          mailbox: 'Sent',
          inReplyTo: '<root@x>',
          references: ['<root@x>'],
        }),
      })
    );

    const rows = db
      .prepare(`SELECT thread_id FROM messages WHERE id IN (?, ?)`)
      .all(inbox.id, sent.id) as Array<{ thread_id: string }>;
    expect(rows[0].thread_id).toBe(rows[1].thread_id);
  });

  it('converges on the same root regardless of arrival order', () => {
    // Reply first, parent second — the out-of-order backfill case.
    const reply = upsertMessage(
      db,
      ingest({
        message: msg({
          uid: 2,
          messageId: '<reply@x>',
          inReplyTo: '<root@x>',
          references: ['<root@x>'],
        }),
      })
    );
    const parent = upsertMessage(
      db,
      ingest({ message: msg({ uid: 1, messageId: '<root@x>' }) })
    );

    expect(reply.threadId).toBe(parent.threadId);
    expect(resolveRoot(db, '<reply@x>')).toBe(resolveRoot(db, '<root@x>'));
  });

  it('merges two threads when a late message references both', () => {
    const a = upsertMessage(db, ingest({ message: msg({ uid: 1, messageId: '<a@x>' }) }));
    const b = upsertMessage(db, ingest({ message: msg({ uid: 2, messageId: '<b@x>' }) }));
    expect(a.threadId).not.toBe(b.threadId);

    const bridge = upsertMessage(
      db,
      ingest({
        message: msg({ uid: 3, messageId: '<c@x>', references: ['<a@x>', '<b@x>'] }),
      })
    );

    const rows = db
      .prepare(`SELECT DISTINCT thread_id FROM messages`)
      .all() as Array<{ thread_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].thread_id).toBe(bridge.threadId);
  });
});

describe('attachBody', () => {
  it('makes body text searchable after an envelope-only ingest', () => {
    const { id } = upsertMessage(
      db,
      ingest({ message: msg({ bodyText: '', subject: 'Contract' }) })
    );
    expect(search('indemnity')).toHaveLength(0);

    attachBody(db, id, { text: 'the indemnity clause is unchanged' });

    expect(search('indemnity')).toContain(id);
    expect(search('contract')).toContain(id);
  });

  it('flips body_state and backfills the snippet', () => {
    const { id } = upsertMessage(db, ingest({ message: msg({ bodyText: '' }) }));
    attachBody(db, id, { text: 'now we have a body' });

    const row = db
      .prepare(`SELECT body_state, snippet FROM messages WHERE id = ?`)
      .get(id) as { body_state: string; snippet: string };
    expect(row.body_state).toBe('fetched');
    expect(row.snippet).toBe('now we have a body');
  });

  it('round-trips gzipped HTML', () => {
    const { id } = upsertMessage(db, ingest({ message: msg({ bodyText: '' }) }));
    const html = '<p>Hello <b>there</b></p>';
    attachBody(db, id, { html });

    expect(readBodyHtml(db, id)).toBe(html);
    expect(search('there')).toContain(id);
  });

  it('does not double-index when a body is attached twice', () => {
    const { id } = upsertMessage(db, ingest({ message: msg({ bodyText: '' }) }));
    attachBody(db, id, { text: 'uniquetoken' });
    attachBody(db, id, { text: 'uniquetoken' });
    expect(search('uniquetoken')).toEqual([id]);
  });
});

describe('deleteMessages', () => {
  it('removes the row and its FTS entry', () => {
    const { id } = upsertMessage(db, ingest());
    expect(search('pricing')).toContain(id);

    const removed = deleteMessages(db, {
      accountId: 'work',
      mailbox: 'INBOX',
      uidvalidity: 1,
      uids: [1],
    });

    expect(removed).toBe(1);
    expect(search('pricing')).toHaveLength(0);
    expect(db.prepare(`SELECT COUNT(*) c FROM messages`).get()).toEqual({ c: 0 });
  });

  it('cascades to bodies and attachments', () => {
    const { id } = upsertMessage(
      db,
      ingest({
        attachments: [{ part_id: '2', filename: 'x.pdf', mime_type: null, size: 1 }],
      })
    );
    attachBody(db, id, { text: 'body' });

    deleteMessages(db, { accountId: 'work', mailbox: 'INBOX', uidvalidity: 1, uids: [1] });

    expect(db.prepare(`SELECT COUNT(*) c FROM bodies`).get()).toEqual({ c: 0 });
    expect(db.prepare(`SELECT COUNT(*) c FROM attachments`).get()).toEqual({ c: 0 });
  });

  it('is a no-op for an empty uid list', () => {
    upsertMessage(db, ingest());
    expect(
      deleteMessages(db, { accountId: 'work', mailbox: 'INBOX', uidvalidity: 1, uids: [] })
    ).toBe(0);
  });

  it('ignores uids from a different uidvalidity generation', () => {
    upsertMessage(db, ingest());
    const removed = deleteMessages(db, {
      accountId: 'work',
      mailbox: 'INBOX',
      uidvalidity: 999,
      uids: [1],
    });
    expect(removed).toBe(0);
  });
});

describe('updateFlags', () => {
  it('updates both the JSON and the denormalized columns', () => {
    upsertMessage(db, ingest());
    updateFlags(db, {
      accountId: 'work',
      mailbox: 'INBOX',
      uidvalidity: 1,
      uid: 1,
      flags: ['\\Seen', '\\Answered'],
      modseq: 12,
    });

    const row = db
      .prepare(`SELECT flags, seen, flagged, answered, modseq FROM messages WHERE uid = 1`)
      .get() as {
      flags: string;
      seen: number;
      flagged: number;
      answered: number;
      modseq: number;
    };

    expect(JSON.parse(row.flags)).toEqual(['\\Seen', '\\Answered']);
    expect(row.seen).toBe(1);
    expect(row.answered).toBe(1);
    expect(row.flagged).toBe(0);
    expect(row.modseq).toBe(12);
  });
});

describe('resync behavior', () => {
  it('does not downgrade a fetched body when a flags-only resync re-ingests', () => {
    const { id } = upsertMessage(db, ingest({ message: msg({ bodyText: '' }) }));
    attachBody(db, id, { text: 'real body' });

    // Delta sync re-ingests the envelope with no body attached.
    upsertMessage(db, ingest({ message: msg({ bodyText: '', flags: ['\\Seen'] }) }));

    const row = db
      .prepare(`SELECT body_state, seen FROM messages WHERE id = ?`)
      .get(id) as { body_state: string; seen: number };
    expect(row.body_state).toBe('fetched');
    expect(row.seen).toBe(1);
  });
});

describe('withTransaction', () => {
  it('rolls back on failure', () => {
    expect(() =>
      withTransaction(db, () => {
        upsertMessage(db, ingest());
        throw new Error('boom');
      })
    ).toThrow('boom');

    expect(db.prepare(`SELECT COUNT(*) c FROM messages`).get()).toEqual({ c: 0 });
  });

  it('commits on success', () => {
    withTransaction(db, () => upsertMessage(db, ingest()));
    expect(db.prepare(`SELECT COUNT(*) c FROM messages`).get()).toEqual({ c: 1 });
  });
});
