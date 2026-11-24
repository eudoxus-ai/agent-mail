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

function seed(cache: Database, accountId: string, uid: number, date: number) {
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
      mailbox: 'INBOX',
    },
  });
}

function executorOver(cache: Database) {
  for (const { id } of ACCOUNTS) {
    upsertMailboxState(cache, id, 'INBOX', { backfill_complete: 1, last_delta_at: Date.now() });
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

async function pageToEnd(executor: Executor, limit: number) {
  const pages: Array<Array<{ account_id: string; uid: number }>> = [];
  let cursor: string | undefined;
  do {
    const { result } = await executor.executeImmediate({
      tool: 'search_threads',
      toolParams: { limit, ...(cursor ? { cursor } : {}) },
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

const key = (r: { account_id: string; uid: number }) => `${r.account_id}:${r.uid}`;

describe('search_threads cache cursor', () => {
  it('returns every row once across ties larger than a page, then stops', async () => {
    const cache = openCache(':memory:');
    const expected: string[] = [];
    // Seven rows per account at one instant, so the tie spans several pages
    // and both accounts, and UIDs repeat across accounts.
    for (const accountId of ['work', 'home']) {
      for (let uid = 1; uid <= 7; uid += 1) {
        seed(cache, accountId, uid, SHARED);
        expected.push(`${accountId}:${uid}`);
      }
    }
    // Two older rows make 16 in all, an exact multiple of the page size.
    seed(cache, 'work', 8, SHARED - 1000);
    seed(cache, 'home', 8, SHARED - 2000);
    expected.push('work:8', 'home:8');

    const pages = await pageToEnd(executorOver(cache), 4);

    expect(pages.map((p) => p.length)).toEqual([4, 4, 4, 4]);
    const seen = pages.flat().map(key);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...expected].sort());
    // Newest first, ties broken by account, then uid, descending.
    expect(seen.slice(0, 8)).toEqual([7, 6, 5, 4, 3, 2, 1].map((u) => `work:${u}`).concat('home:7'));
    expect(seen.slice(-2)).toEqual(['work:8', 'home:8']);
  });

  it('ends without a cursor when the last page is short', async () => {
    const cache = openCache(':memory:');
    for (let uid = 1; uid <= 5; uid += 1) seed(cache, 'work', uid, SHARED - uid * 1000);

    const pages = await pageToEnd(executorOver(cache), 2);

    expect(pages.map((p) => p.map((r) => r.uid))).toEqual([[1, 2], [3, 4], [5]]);
  });
});
