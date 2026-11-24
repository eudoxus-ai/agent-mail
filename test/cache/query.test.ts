import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCache, type Database } from '../../src/cache/db.js';
import { upsertMessage, attachBody } from '../../src/cache/store.js';
import { searchCache, countByAccount, rankedSearch, sentToCounts } from '../../src/cache/query.js';
import { sentMailboxes } from '../../src/cache/mailboxes.js';
import { getCoverage, isServable } from '../../src/cache/coverage.js';
import { upsertMailboxState } from '../../src/cache/state.js';
import type { EmailMessage } from '../../src/types.js';

let db: Database;

beforeEach(() => {
  db = openCache(':memory:');
});

function msg(uid: number, overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    uid,
    messageId: `<m${uid}@x>`,
    from: { address: 'alice@example.com', name: 'Alice Smith' },
    to: [{ address: 'you@example.com', name: null }],
    cc: [],
    date: new Date(Date.UTC(2026, 5, uid)).toISOString(),
    subject: `Subject ${uid}`,
    bodyText: `Body ${uid}`,
    references: [],
    flags: [],
    mailbox: 'INBOX',
    ...overrides,
  };
}

function add(uid: number, overrides: Partial<EmailMessage> = {}, accountId = 'work') {
  return upsertMessage(db, {
    accountId,
    message: msg(uid, overrides),
    uidvalidity: 1,
  });
}

describe('searchCache', () => {
  it('returns newest-first', () => {
    add(1);
    add(3);
    add(2);

    const rows = searchCache(db, {
      mailboxes: [{ account_id: 'work', mailbox: 'INBOX' }],
      limit: 10,
    });
    expect(rows.map((r) => r.uid)).toEqual([3, 2, 1]);
  });

  it('respects limit', () => {
    for (let uid = 1; uid <= 5; uid += 1) add(uid);
    const rows = searchCache(db, { mailboxes: [{ account_id: 'work', mailbox: 'INBOX' }], limit: 2 });
    expect(rows).toHaveLength(2);
  });

  it('scopes to the requested accounts', () => {
    add(1, {}, 'work');
    add(2, {}, 'personal');

    const rows = searchCache(db, { mailboxes: [{ account_id: 'work', mailbox: 'INBOX' }], limit: 10 });
    expect(rows.map((r) => r.account_id)).toEqual(['work']);
  });

  it('scopes to the requested mailbox', () => {
    add(1, { mailbox: 'INBOX' });
    add(2, { mailbox: 'Sent' });

    const rows = searchCache(db, { mailboxes: [{ account_id: 'work', mailbox: 'Sent' }], limit: 10 });
    expect(rows.map((r) => r.uid)).toEqual([2]);
  });

  it('filters by since and before', () => {
    add(1);
    add(10);
    add(20);

    const rows = searchCache(db, {
      mailboxes: [{ account_id: 'work', mailbox: 'INBOX' }],
      since: new Date(Date.UTC(2026, 5, 5)),
      before: new Date(Date.UTC(2026, 5, 15)),
      limit: 10,
    });
    expect(rows.map((r) => r.uid)).toEqual([10]);
  });

  it('matches full-text across subject and body', () => {
    add(1, { subject: 'Pricing review', bodyText: 'nothing here' });
    add(2, { subject: 'Lunch', bodyText: 'the pricing model changed' });
    add(3, { subject: 'Unrelated', bodyText: 'unrelated' });

    const rows = searchCache(db, {
      mailboxes: [{ account_id: 'work', mailbox: 'INBOX' }],
      query: 'pricing',
      limit: 10,
    });
    expect(rows.map((r) => r.uid).sort()).toEqual([1, 2]);
  });

  it('does not throw on a hyphenated query', () => {
    add(1, { subject: 'Q2-pricing' });
    expect(() =>
      searchCache(db, {
        mailboxes: [{ account_id: 'work', mailbox: 'INBOX' }],
        query: 'Q2-pricing',
        limit: 10,
      })
    ).not.toThrow();
  });

  it('filters by sender across address and display name', () => {
    add(1, { from: { address: 'alice@example.com', name: 'Alice Smith' } });
    add(2, { from: { address: 'bob@example.com', name: 'Bob Jones' } });

    expect(
      searchCache(db, {
        mailboxes: [{ account_id: 'work', mailbox: 'INBOX' }],
        from: 'bob@',
        limit: 10,
      }).map((r) => r.uid)
    ).toEqual([2]);

    expect(
      searchCache(db, {
        mailboxes: [{ account_id: 'work', mailbox: 'INBOX' }],
        from: 'Alice',
        limit: 10,
      }).map((r) => r.uid)
    ).toEqual([1]);
  });

  it('filters by recipient', () => {
    add(1, { to: [{ address: 'team@example.com', name: null }] });
    add(2, { to: [{ address: 'you@example.com', name: null }] });

    const rows = searchCache(db, {
      mailboxes: [{ account_id: 'work', mailbox: 'INBOX' }],
      to: 'team@',
      limit: 10,
    });
    expect(rows.map((r) => r.uid)).toEqual([1]);
  });

  it('returns the shape search_threads already emits', () => {
    add(1, { subject: 'Hello' });
    const [row] = searchCache(db, { mailboxes: [{ account_id: 'work', mailbox: 'INBOX' }], limit: 1 });

    expect(row).toMatchObject({
      account_id: 'work',
      mailbox: 'INBOX',
      uid: 1,
      from_address: 'alice@example.com',
      from_name: 'Alice Smith',
      is_list_mail: false,
      target: { account_id: 'work', uid: 1, mailbox: 'INBOX' },
    });
    expect(row.envelope).toMatchObject({ subject: 'Hello', message_id: '<m1@x>' });
    expect(typeof row.envelope.date).toBe('string');
    expect(Array.isArray(row.flags)).toBe(true);
  });

  it('classifies each row as it is read, not by the category stored at ingest', () => {
    const { id } = add(1, { from: { address: 'noreply@service.example', name: null }, subject: 'Hello' });
    // What a row ingested under an older classifier still holds.
    db.prepare(`UPDATE messages SET category = 'personal' WHERE id = ?`).run(id);

    const [row] = searchCache(db, { mailboxes: [{ account_id: 'work', mailbox: 'INBOX' }], limit: 1 });
    expect(row.category).toBe('notification');
  });

  it('includes attachment metadata', () => {
    upsertMessage(db, {
      accountId: 'work',
      message: msg(1),
      uidvalidity: 1,
      attachments: [
        { part_id: '2', filename: 'deck.pdf', mime_type: 'application/pdf', size: 99 },
      ],
    });

    const [row] = searchCache(db, { mailboxes: [{ account_id: 'work', mailbox: 'INBOX' }], limit: 1 });
    expect(row.attachments).toEqual([
      { part_id: '2', filename: 'deck.pdf', mime_type: 'application/pdf', size: 99 },
    ]);
  });

  it('returns nothing for an empty account list', () => {
    add(1);
    expect(searchCache(db, { mailboxes: [], limit: 10 })).toEqual([]);
  });

  it('finds text that only exists in a body fetched later', () => {
    const { id } = upsertMessage(db, {
      accountId: 'work',
      message: msg(1, { bodyText: '' }),
      uidvalidity: 1,
    });
    attachBody(db, id, { text: 'the renewal date is in March' });

    const rows = searchCache(db, {
      mailboxes: [{ account_id: 'work', mailbox: 'INBOX' }],
      query: 'renewal',
      limit: 10,
    });
    expect(rows.map((r) => r.uid)).toEqual([1]);
  });
});

describe('reading a cache the daemon wrote', () => {
  it('works on a connection opened read-only, as the MCP server opens it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-mail-ro-'));
    try {
      const path = join(dir, 'cache.db');
      const writer = openCache(path);
      upsertMessage(writer, { accountId: 'work', uidvalidity: 1, message: msg(1, { cc: [{ address: 'bob@example.com', name: null }] }) });
      upsertMessage(writer, {
        accountId: 'work',
        uidvalidity: 1,
        message: msg(2, {
          mailbox: 'Sent Messages',
          from: { address: 'you@example.com', name: null },
          to: [{ address: 'alice@example.com', name: null }],
        }),
      });
      upsertMailboxState(writer, 'work', 'INBOX', {});
      upsertMailboxState(writer, 'work', 'Sent Messages', {});
      writer.close();

      const reader = openCache(path, { readOnly: true });
      const [row] = searchCache(reader, { mailboxes: [{ account_id: 'work', mailbox: 'INBOX' }], limit: 10 });
      expect(row).toMatchObject({ uid: 1, cc: [{ address: 'bob@example.com', name: null }] });
      const sent = sentMailboxes(reader, ['work']);
      expect(sent).toEqual([{ account_id: 'work', mailbox: 'Sent Messages' }]);
      expect(sentToCounts(reader, sent, ['Alice@example.com', 'bob@example.com'])).toEqual(
        new Map([['alice@example.com', 1]])
      );
      reader.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('countByAccount', () => {
  it('counts per account', () => {
    add(1, {}, 'work');
    add(2, {}, 'work');
    add(3, {}, 'personal');

    const rows = searchCache(db, {
      mailboxes: [{ account_id: 'work', mailbox: 'INBOX' }, { account_id: 'personal', mailbox: 'INBOX' }],
      limit: 10,
    });
    expect(countByAccount(rows)).toEqual({ work: 2, personal: 1 });
  });
});

describe('rankedSearch', () => {
  it('ranks subject hits above body hits', () => {
    add(1, { subject: 'Budget', bodyText: 'hello' });
    add(2, { subject: 'hello', bodyText: 'the budget is fine' });

    const rows = rankedSearch(db, {
      mailboxes: [{ account_id: 'work', mailbox: 'INBOX' }],
      query: 'budget',
      limit: 10,
    });
    expect(rows.map((r) => r.uid)).toEqual([1, 2]);
  });

  it('returns nothing without a query', () => {
    add(1);
    expect(
      rankedSearch(db, { mailboxes: [{ account_id: 'work', mailbox: 'INBOX' }], limit: 10 })
    ).toEqual([]);
  });
});

describe('getCoverage', () => {
  const NOW = Date.UTC(2026, 6, 31, 12, 0, 0);
  const opts = { freshnessWindowSeconds: 300, now: NOW };

  it('reports unavailable when nothing has synced', () => {
    expect(getCoverage(db, ['work'], opts).state).toBe('unavailable');
  });

  it('reports fresh after a recent sync', () => {
    add(1);
    upsertMailboxState(db, 'work', 'INBOX', {
      backfill_complete: 1,
      last_delta_at: NOW - 1000,
      oldest_date: Date.UTC(2026, 0, 1),
    });

    const coverage = getCoverage(db, ['work'], opts);
    expect(coverage.state).toBe('fresh');
    expect(coverage.coverage.work.INBOX).toMatchObject({ complete: true, messages: 1 });
    expect(coverage.coverage.work.INBOX.oldest).toBe(
      new Date(Date.UTC(2026, 0, 1)).toISOString()
    );
  });

  it('reports stale when the daemon has not synced recently', () => {
    upsertMailboxState(db, 'work', 'INBOX', {
      backfill_complete: 1,
      last_delta_at: NOW - 60 * 60 * 1000,
    });
    expect(getCoverage(db, ['work'], opts).state).toBe('stale');
  });

  it('reports backfilling while a mailbox is incomplete', () => {
    upsertMailboxState(db, 'work', 'INBOX', {
      backfill_complete: 0,
      last_delta_at: NOW - 1000,
    });
    expect(getCoverage(db, ['work'], opts).state).toBe('backfilling');
  });

  it('judges staleness on the laggard, not the leader', () => {
    // One account synced a second ago, another a day ago. The answer as a
    // whole is a day stale; taking the max would hide the lagging account.
    upsertMailboxState(db, 'work', 'INBOX', {
      backfill_complete: 1,
      last_delta_at: NOW - 1000,
    });
    upsertMailboxState(db, 'personal', 'INBOX', {
      backfill_complete: 1,
      last_delta_at: NOW - 24 * 60 * 60 * 1000,
    });

    expect(getCoverage(db, ['work', 'personal'], opts).state).toBe('stale');
  });

  it('treats backfilling as servable but stale as not', () => {
    expect(isServable('fresh')).toBe(true);
    expect(isServable('backfilling')).toBe(true);
    expect(isServable('stale')).toBe(false);
    expect(isServable('unavailable')).toBe(false);
  });
});

describe('coverage must match the scope actually being searched', () => {
  const NOW = Date.UTC(2026, 6, 31, 12, 0, 0);
  const opts = (mailbox: string, accountIds = ['work']) => ({
    freshnessWindowSeconds: 300,
    now: NOW,
    mailboxes: accountIds.map((account_id) => ({ account_id, mailbox })),
  });

  function synced(accountId: string, mailbox: string) {
    upsertMailboxState(db, accountId, mailbox, {
      backfill_complete: 1,
      last_delta_at: NOW - 1000,
      oldest_date: Date.UTC(2026, 0, 1),
    });
  }

  it('is unavailable for a mailbox that has never been synced', () => {
    synced('work', 'INBOX');

    // Serving Drafts from INBOX's freshness would return an empty result
    // while suppressing the IMAP fallback — silently missing mail.
    expect(getCoverage(db, ['work'], opts('Drafts')).state).toBe('unavailable');
    expect(getCoverage(db, ['work'], opts('INBOX')).state).toBe('fresh');
  });

  it('is unavailable when one of several mailboxes has never been synced', () => {
    synced('work', 'INBOX');
    const mailboxes = ['INBOX', 'Sent'].map((mailbox) => ({ account_id: 'work', mailbox }));

    // A synced INBOX does not vouch for the Sent mailbox read alongside it.
    expect(
      getCoverage(db, ['work'], { freshnessWindowSeconds: 300, now: NOW, mailboxes }).state
    ).toBe('unavailable');
  });

  it('is unavailable when only some requested accounts have synced', () => {
    synced('work', 'INBOX');

    // A two-account search must not quietly return one account's results.
    expect(getCoverage(db, ['work', 'personal'], opts('INBOX', ['work', 'personal'])).state).toBe('unavailable');
    expect(getCoverage(db, ['work'], opts('INBOX')).state).toBe('fresh');
  });

  it('serves once every requested account has that mailbox', () => {
    synced('work', 'INBOX');
    synced('personal', 'INBOX');

    expect(getCoverage(db, ['work', 'personal'], opts('INBOX', ['work', 'personal'])).state).toBe('fresh');
  });

  it('is unavailable when a mailbox is known but has never completed a sync', () => {
    upsertMailboxState(db, 'work', 'INBOX', {
      backfill_complete: 0,
      last_delta_at: null,
    });

    // The mailbox is registered but nothing has been read from it yet.
    expect(getCoverage(db, ['work'], opts('INBOX')).state).toBe('unavailable');
  });
});
