import { describe, it, expect, beforeEach } from 'vitest';
import { openCache, type Database } from '../../src/cache/db.js';
import { upsertMessage } from '../../src/cache/store.js';
import { invalidate, markDirty, dirtyMailboxes } from '../../src/cache/invalidate.js';
import { searchCache } from '../../src/cache/query.js';
import { upsertMailboxState, getMailboxState } from '../../src/cache/state.js';
import { diffResults } from '../../src/cache/shadow.js';
import type { EmailMessage } from '../../src/types.js';

let db: Database;

beforeEach(() => {
  db = openCache(':memory:');
  upsertMailboxState(db, 'work', 'INBOX', {
    uidvalidity: 1,
    backfill_complete: 1,
    last_delta_at: Date.now(),
  });
});

function msg(uid: number, overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    uid,
    messageId: `<m${uid}@x>`,
    from: { address: 'alice@example.com', name: null },
    to: [],
    cc: [],
    date: new Date(Date.UTC(2026, 5, uid)).toISOString(),
    subject: `Subject ${uid}`,
    bodyText: 'body',
    references: [],
    flags: [],
    mailbox: 'INBOX',
    ...overrides,
  };
}

function add(uid: number, overrides: Partial<EmailMessage> = {}) {
  return upsertMessage(db, { accountId: 'work', message: msg(uid, overrides), uidvalidity: 1 });
}

function inboxUids(): number[] {
  return searchCache(db, { accountIds: ['work'], mailbox: 'INBOX', limit: 100 }).map(
    (r) => r.uid
  );
}

describe('invalidate — moved', () => {
  it('drops held messages from their source mailbox immediately', () => {
    add(1);
    add(2);

    invalidate(db, {
      accountId: 'work',
      mailbox: 'INBOX',
      uids: [1],
      effect: 'moved',
      detail: { toMailbox: 'agent-mail-holding' },
    });

    // The whole point: an agent that holds and then searches must not see the
    // message still sitting in INBOX.
    expect(inboxUids()).toEqual([2]);
  });

  it('marks both source and destination mailboxes for priority resync', () => {
    add(1);
    upsertMailboxState(db, 'work', 'agent-mail-holding', {
      uidvalidity: 1,
      last_delta_at: Date.now(),
    });

    invalidate(db, {
      accountId: 'work',
      mailbox: 'INBOX',
      uids: [1],
      effect: 'moved',
      detail: { toMailbox: 'agent-mail-holding' },
    });

    expect(dirtyMailboxes(db, 'work')).toEqual(['INBOX', 'agent-mail-holding']);
  });
});

describe('invalidate — flags_changed', () => {
  it('adds a flag without disturbing existing ones', () => {
    add(1, { flags: ['\\Seen'] });

    invalidate(db, {
      accountId: 'work',
      mailbox: 'INBOX',
      uids: [1],
      effect: 'flags_changed',
      detail: { flagsAdded: ['\\Flagged'] },
    });

    const row = db
      .prepare(`SELECT flags, seen, flagged FROM messages WHERE uid = 1`)
      .get() as { flags: string; seen: number; flagged: number };
    expect(JSON.parse(row.flags)).toEqual(['\\Seen', '\\Flagged']);
    expect(row.seen).toBe(1);
    expect(row.flagged).toBe(1);
  });

  it('removes a flag case-insensitively', () => {
    add(1, { flags: ['\\Seen', '\\Flagged'] });

    invalidate(db, {
      accountId: 'work',
      mailbox: 'INBOX',
      uids: [1],
      effect: 'flags_changed',
      detail: { flagsRemoved: ['\\flagged'] },
    });

    const row = db.prepare(`SELECT flagged FROM messages WHERE uid = 1`).get() as {
      flagged: number;
    };
    expect(row.flagged).toBe(0);
  });

  it('does not duplicate a flag that is already present', () => {
    add(1, { flags: ['\\Seen'] });

    invalidate(db, {
      accountId: 'work',
      mailbox: 'INBOX',
      uids: [1],
      effect: 'flags_changed',
      detail: { flagsAdded: ['\\seen'] },
    });

    const row = db.prepare(`SELECT flags FROM messages WHERE uid = 1`).get() as {
      flags: string;
    };
    expect(JSON.parse(row.flags)).toEqual(['\\Seen']);
  });
});

describe('invalidate — resilience', () => {
  it('is a no-op for a mailbox that was never cached', () => {
    expect(() =>
      invalidate(db, {
        accountId: 'work',
        mailbox: 'NeverSynced',
        uids: [1],
        effect: 'moved',
      })
    ).not.toThrow();
  });

  it('never throws, so a cache problem cannot fail a mail operation', () => {
    add(1);
    db.exec('DROP TABLE messages_fts');

    // deleteMessages touches messages_fts; with it gone this must still be
    // swallowed — the IMAP move already succeeded by the time we get here.
    expect(() =>
      invalidate(db, {
        accountId: 'work',
        mailbox: 'INBOX',
        uids: [1],
        effect: 'moved',
      })
    ).not.toThrow();
  });

  it('leaves the row untouched when a flag echo carries no flags', () => {
    add(1, { flags: ['\\Seen'] });

    invalidate(db, {
      accountId: 'work',
      mailbox: 'INBOX',
      uids: [1],
      effect: 'flags_changed',
      detail: {},
    });

    const row = db.prepare(`SELECT flags FROM messages WHERE uid = 1`).get() as {
      flags: string;
    };
    expect(JSON.parse(row.flags)).toEqual(['\\Seen']);
  });
});

describe('markDirty', () => {
  it('clears last_delta_at so the next tick resyncs first', () => {
    markDirty(db, 'work', 'INBOX');
    expect(getMailboxState(db, 'work', 'INBOX')!.last_delta_at).toBeNull();
  });
});

describe('shadow diff', () => {
  const row = (uid: number, date = '2026-06-01T00:00:00.000Z') => ({
    account_id: 'work',
    mailbox: 'INBOX',
    uid,
    envelope: { date },
  });

  it('matches identical result sets', () => {
    const diff = diffResults([row(1), row(2)], [row(1), row(2)]);
    expect(diff.matched).toBe(true);
  });

  it('flags a message the cache is missing — the dangerous direction', () => {
    const diff = diffResults([row(1), row(2)], [row(1)]);
    expect(diff.matched).toBe(false);
    expect(diff.missingFromCache).toHaveLength(1);
    expect(diff.extraInCache).toHaveLength(0);
  });

  it('flags an extra message the cache invented', () => {
    const diff = diffResults([row(1)], [row(1), row(2)]);
    expect(diff.extraInCache).toHaveLength(1);
  });

  it('flags ordering divergence even when membership matches', () => {
    const diff = diffResults([row(1), row(2)], [row(2), row(1)]);
    expect(diff.matched).toBe(false);
    expect(diff.orderDiverged).toBe(true);
    expect(diff.missingFromCache).toHaveLength(0);
  });

  it('does not confuse identical uids across different accounts', () => {
    const a = { ...row(1), account_id: 'work' };
    const b = { ...row(1), account_id: 'personal' };
    expect(diffResults([a, b], [a, b]).matched).toBe(true);
    expect(diffResults([a], [b]).matched).toBe(false);
  });
});
