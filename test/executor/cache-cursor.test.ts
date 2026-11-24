import { describe, it, expect, vi } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { openCache, type Database } from '../../src/cache/db.js';
import { upsertMessage } from '../../src/cache/store.js';
import { upsertMailboxState } from '../../src/cache/state.js';
import { createLogger } from '../../src/logger.js';
import type { AccountConfig } from '../../src/types.js';

/**
 * Paging search_threads from the cache must reach the end, returning every
 * row exactly once. The old cursor stopped at page two whenever it had to
 * drop rows it had already returned.
 */

const ACCOUNTS: AccountConfig[] = ['work', 'home'].map((id) => ({
  id,
  email: `${id}@example.com`,
  imap: { host: 'h', port: 993, tls: true },
  smtp: { host: 'h', port: 465, tls: true },
}));

const SHARED = Date.UTC(2026, 5, 1, 12);

const MAILBOXES: Record<string, string[]> = { work: ['INBOX', 'Sent'], home: ['INBOX', 'INBOX.Sent'] };

function seed(cache: Database, accountId: string, uid: number, date: number, mailbox = 'INBOX') {
  upsertMessage(cache, {
    accountId,
    uidvalidity: 1,
    message: {
      uid,
      messageId: `<${accountId}-${uid}@x>`,
      from: { address: 'alice@example.com', name: null },
      to: [],
      cc: [],
      date: new Date(date).toISOString(),
      subject: `s${uid}`,
      bodyText: '',
      references: [],
      flags: [],
      mailbox,
    },
  });
}

function executorOver(cache: Database) {
  for (const [id, mailboxes] of Object.entries(MAILBOXES)) {
    for (const mailbox of mailboxes) {
      upsertMailboxState(cache, id, mailbox, { backfill_complete: 1, last_delta_at: Date.now() });
    }
  }
  return new Executor({
    db: openDatabase(':memory:'),
    accounts: ACCOUNTS,
    pool: { withConnection: vi.fn(async () => { throw new Error('IMAP must not be used'); }) } as never,
    logger: createLogger('cli', { minLevel: 'error' }),
    cache,
    cacheConfig: { mode: 'on', freshnessWindowSeconds: 3600 } as never,
  });
}

async function pageToEnd(executor: Executor, params: Record<string, unknown>) {
  const pages: Array<Array<{ account_id: string; mailbox: string; uid: number }>> = [];
  let cursor: string | undefined;
  do {
    const { result } = await executor.executeImmediate({
      tool: 'search_threads',
      toolParams: { ...params, ...(cursor ? { cursor } : {}) },
      accountId: 'work',
      agentId: 'test',
      risk: 'none',
    });
    const payload = JSON.parse(result[0].text);
    pages.push(payload.results);
    cursor = payload.next_cursor;
    if (pages.length > 50) throw new Error('cursor never ended');
  } while (cursor);
  return pages;
}

const key = (r: { account_id: string; mailbox: string; uid: number }) =>
  `${r.account_id}:${r.mailbox}:${r.uid}`;

describe('search_threads cache cursor', () => {
  it('returns every row once across ties larger than a page, then stops', async () => {
    const cache = openCache(':memory:');
    // Fourteen rows at one instant, spread over both accounts and two
    // mailboxes each, with UIDs that repeat across all four. The tie spans
    // several pages.
    for (const [accountId, [inbox, sent]] of Object.entries(MAILBOXES)) {
      for (let uid = 1; uid <= 4; uid += 1) seed(cache, accountId, uid, SHARED, inbox);
      for (let uid = 1; uid <= 3; uid += 1) seed(cache, accountId, uid, SHARED, sent);
    }
    // Two older rows make 16 in all, an exact multiple of the page size.
    seed(cache, 'work', 5, SHARED - 1000);
    seed(cache, 'home', 5, SHARED - 2000);

    const pages = await pageToEnd(executorOver(cache), { limit: 4, include_sent: true });

    expect(pages.map((p) => p.length)).toEqual([4, 4, 4, 4]);
    const seen = pages.flat().map(key);
    // Newest first, ties broken by account, mailbox, then uid, all descending.
    expect(seen).toEqual([
      'work:Sent:3', 'work:Sent:2', 'work:Sent:1',
      'work:INBOX:4', 'work:INBOX:3', 'work:INBOX:2', 'work:INBOX:1',
      'home:INBOX.Sent:3', 'home:INBOX.Sent:2', 'home:INBOX.Sent:1',
      'home:INBOX:4', 'home:INBOX:3', 'home:INBOX:2', 'home:INBOX:1',
      'work:INBOX:5', 'home:INBOX:5',
    ]);
    expect(new Set(seen).size).toBe(16);
  });

  it('ends without a cursor when the last page is short', async () => {
    const cache = openCache(':memory:');
    for (let uid = 1; uid <= 5; uid += 1) seed(cache, 'work', uid, SHARED - uid * 1000);

    const pages = await pageToEnd(executorOver(cache), { limit: 2 });

    expect(pages.map((p) => p.map((r) => r.uid))).toEqual([[1, 2], [3, 4], [5]]);
  });
});
