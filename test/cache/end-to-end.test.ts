import { describe, it, expect, beforeEach } from 'vitest';
import { openCache, type Database } from '../../src/cache/db.js';
import { syncAccount } from '../../src/cache/sync.js';
import { searchCache } from '../../src/cache/query.js';
import { getCoverage } from '../../src/cache/coverage.js';
import { invalidate } from '../../src/cache/invalidate.js';
import { diffResults } from '../../src/cache/shadow.js';
import { FakeSyncProvider, mailbox, message } from './fake-provider.js';

/**
 * Sync -> index -> query, end to end. The unit tests cover each stage in
 * isolation; this checks that a message fetched from a server is actually
 * findable through the path search_threads uses.
 */

let db: Database;

beforeEach(() => {
  db = openCache(':memory:');
});

const NOW = Date.UTC(2026, 6, 31);

function provider() {
  return new FakeSyncProvider([
    mailbox(
      'INBOX',
      [
        message(1, {
          subject: 'Q2 pricing review',
          from: 'alice@example.com',
          body: 'We agreed to hold the indemnity clause unchanged.',
        }),
        message(2, {
          subject: 'Lunch Thursday',
          from: 'bob@example.com',
          body: 'Are you free around noon?',
        }),
      ],
      { specialUse: '\\Inbox' }
    ),
    mailbox(
      'Sent',
      [
        message(1, {
          messageId: '<reply@x>',
          subject: 'Re: Q2 pricing review',
          from: 'you@example.com',
          inReplyTo: '<msg-1@example.com>',
          references: ['<msg-1@example.com>'],
          body: 'Confirming the indemnity position.',
        }),
      ],
      { specialUse: '\\Sent' }
    ),
  ]);
}

async function sync(p: FakeSyncProvider) {
  return syncAccount(db, {
    accountId: 'work',
    provider: p,
    now: () => NOW,
    backfillDays: null,
  });
}

describe('sync to search', () => {
  it('makes synced mail findable by body text', async () => {
    await sync(provider());

    const rows = searchCache(db, {
      accountIds: ['work'],
      mailbox: 'INBOX',
      query: 'indemnity',
      limit: 10,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].envelope.subject).toBe('Q2 pricing review');
    expect(rows[0].target).toEqual({ account_id: 'work', uid: 1, mailbox: 'INBOX' });
  });

  it('finds mail by sender across mailboxes', async () => {
    await sync(provider());

    expect(
      searchCache(db, {
        accountIds: ['work'],
        mailbox: 'INBOX',
        from: 'bob@',
        limit: 10,
      })
    ).toHaveLength(1);

    expect(
      searchCache(db, {
        accountIds: ['work'],
        mailbox: 'Sent',
        limit: 10,
      })
    ).toHaveLength(1);
  });

  it('threads an INBOX message with its Sent reply', async () => {
    await sync(provider());

    const threads = db
      .prepare(
        `SELECT thread_id, COUNT(*) AS n FROM messages GROUP BY thread_id ORDER BY n DESC`
      )
      .all() as Array<{ thread_id: string; n: number }>;

    // Three messages, two of which are the same conversation across mailboxes.
    expect(threads[0].n).toBe(2);
  });

  it('reports coverage a caller can reason about', async () => {
    await sync(provider());

    const coverage = getCoverage(db, ['work'], {
      freshnessWindowSeconds: 300,
      now: NOW + 1000,
    });

    expect(coverage.state).toBe('fresh');
    expect(coverage.coverage.work.INBOX.complete).toBe(true);
    expect(coverage.coverage.work.INBOX.messages).toBe(2);
  });
});

describe('mutation echo through the query path', () => {
  it('hides a held message from its source mailbox before the next sync', async () => {
    const p = provider();
    await sync(p);
    expect(searchCache(db, { accountIds: ['work'], mailbox: 'INBOX', limit: 10 })).toHaveLength(2);

    // What the executor does after a successful IMAP move.
    invalidate(db, {
      accountId: 'work',
      mailbox: 'INBOX',
      uids: [2],
      effect: 'moved',
      detail: { toMailbox: 'agent-mail-holding' },
    });

    const rows = searchCache(db, { accountIds: ['work'], mailbox: 'INBOX', limit: 10 });
    expect(rows.map((r) => r.uid)).toEqual([1]);
  });

  it('lets the server overwrite an echo that turned out to be wrong', async () => {
    const p = provider();
    await sync(p);

    // Echo a flag change that never actually happened on the server.
    invalidate(db, {
      accountId: 'work',
      mailbox: 'INBOX',
      uids: [1],
      effect: 'flags_changed',
      detail: { flagsAdded: ['\\Flagged'] },
    });
    expect(
      (db.prepare(`SELECT flagged FROM messages WHERE uid = 1`).get() as { flagged: number })
        .flagged
    ).toBe(1);

    // The server says otherwise on the next delta, and the server wins.
    p.setFlags('INBOX', 1, []);
    await sync(p);

    expect(
      (db.prepare(`SELECT flagged FROM messages WHERE uid = 1`).get() as { flagged: number })
        .flagged
    ).toBe(0);
  });
});

describe('shadow mode', () => {
  it('reports a match when the cache agrees with the server', async () => {
    const p = provider();
    await sync(p);

    const cacheRows = searchCache(db, {
      accountIds: ['work'],
      mailbox: 'INBOX',
      limit: 10,
    });
    // What IMAP would have returned for the same query, newest-first.
    const imapRows = [2, 1].map((uid) => ({
      account_id: 'work',
      mailbox: 'INBOX',
      uid,
      envelope: {
        date: new Date(Date.UTC(2026, 5, 1, 0, 0, uid)).toISOString(),
      },
    }));

    expect(diffResults(imapRows, cacheRows).matched).toBe(true);
  });

  it('catches the cache missing a message the server has', async () => {
    const p = provider();
    await sync(p);

    const cacheRows = searchCache(db, {
      accountIds: ['work'],
      mailbox: 'INBOX',
      limit: 10,
    });
    const imapRows = [
      ...cacheRows,
      {
        account_id: 'work',
        mailbox: 'INBOX',
        uid: 99,
        envelope: { date: new Date(Date.UTC(2026, 5, 1)).toISOString() },
      },
    ];

    const diff = diffResults(imapRows, cacheRows);
    expect(diff.matched).toBe(false);
    expect(diff.missingFromCache).toHaveLength(1);
  });
});
