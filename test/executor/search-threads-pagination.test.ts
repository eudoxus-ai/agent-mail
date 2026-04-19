import { describe, it, expect, vi } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { createLogger } from '../../src/logger.js';
import type { AccountConfig } from '../../src/types.js';
import { decodeCursor, encodeCursor } from '../../src/lib/search-cursor.js';

const logger = createLogger('cli', { minLevel: 'error' });

function accounts(): AccountConfig[] {
  return [{
    id: 'a@x.com',
    email: 'a@x.com',
    imap: { host: 'h', port: 993, tls: true },
    smtp: { host: 'h', port: 465, tls: true },
  }];
}

describe('search_threads `before` cursor', () => {
  it('forwards `before` as a Date in SearchCriteria to imap.search', async () => {
    const searchSpy = vi.fn(async () => []);
    const pool = {
      withConnection: vi.fn(async (_id: string, fn: any) =>
        fn({ search: searchSpy })
      ),
    };

    const executor = new Executor({
      db: openDatabase(':memory:'),
      accounts: accounts(),
      pool: pool as any,
      logger,
    });

    await executor.executeImmediate({
      tool: 'search_threads',
      toolParams: { before: '2026-03-18T00:00:00Z' },
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'none',
    });

    expect(searchSpy).toHaveBeenCalled();
    const [, criteria] = searchSpy.mock.calls[0];
    expect(criteria.before).toBeInstanceOf(Date);
    expect((criteria.before as Date).toISOString()).toBe('2026-03-18T00:00:00.000Z');
  });
});

// Generate a fake corpus of 30 messages, newest first.
function fakeCorpus() {
  return Array.from({ length: 30 }, (_, i) => {
    const day = 30 - i; // newest = day 30
    const date = new Date(`2026-04-${String(day).padStart(2, '0')}T12:00:00Z`);
    return {
      uid: 1000 + i,
      envelope: {
        message_id: `m${i}`,
        subject: `subject ${i}`,
        from: { address: 'x@y', name: null },
        date: date.toISOString(),
      },
      snippet: '',
      flags: [],
      list_id: null,
      list_unsubscribe: null,
    };
  });
}

function buildExecutor(corpus: ReturnType<typeof fakeCorpus>) {
  const searchSpy = vi.fn(async (_mailbox: string, criteria: any, limit: number) => {
    let rows = corpus;
    if (criteria.before instanceof Date) {
      const beforeMs = criteria.before.getTime();
      rows = rows.filter((r) => new Date(r.envelope.date).getTime() < beforeMs);
    }
    return rows.slice(0, limit);
  });
  const pool = {
    withConnection: vi.fn(async (_id: string, fn: any) =>
      fn({ search: searchSpy, fetchSnippet: async () => '' })
    ),
  };
  const executor = new Executor({
    db: openDatabase(':memory:'),
    accounts: accounts(),
    pool: pool as any,
    logger,
  });
  return { executor, searchSpy };
}

describe('search_threads opaque cursor pagination', () => {
  it('returns next_cursor when results fill the limit', async () => {
    const corpus = fakeCorpus();
    const { executor } = buildExecutor(corpus);

    const { result } = await executor.executeImmediate({
      tool: 'search_threads',
      toolParams: { limit: 10 },
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'none',
    });

    const payload = JSON.parse(result[0].text);
    expect(payload.results).toHaveLength(10);
    expect(payload.next_cursor).toBeTruthy();
    const decoded = decodeCursor(payload.next_cursor);
    expect(decoded).not.toBeNull();
    // oldest of first page is the 10th newest = index 9 in corpus
    expect(decoded!.before).toBe(corpus[9].envelope.date);
    expect(decoded!.lastUid).toBe(corpus[9].uid);
  });

  it('advances past the first page when cursor is passed back', async () => {
    const corpus = fakeCorpus();
    const { executor } = buildExecutor(corpus);

    const page1 = JSON.parse(
      (
        await executor.executeImmediate({
          tool: 'search_threads',
          toolParams: { limit: 10 },
          accountId: 'a@x.com',
          agentId: 'test',
          risk: 'none',
        })
      ).result[0].text
    );
    const firstIds = page1.results.map((r: any) => r.uid);

    const page2 = JSON.parse(
      (
        await executor.executeImmediate({
          tool: 'search_threads',
          toolParams: { limit: 10, cursor: page1.next_cursor },
          accountId: 'a@x.com',
          agentId: 'test',
          risk: 'none',
        })
      ).result[0].text
    );
    const secondIds = page2.results.map((r: any) => r.uid);

    expect(page2.results).toHaveLength(10);
    // No overlap between pages.
    expect(secondIds.some((id: number) => firstIds.includes(id))).toBe(false);
    // Page 2 should be the next 10 oldest entries in the corpus.
    expect(secondIds).toEqual(corpus.slice(10, 20).map((r) => r.uid));
  });

  it('omits next_cursor when results are below the limit', async () => {
    const corpus = fakeCorpus().slice(0, 5);
    const { executor } = buildExecutor(corpus);

    const { result } = await executor.executeImmediate({
      tool: 'search_threads',
      toolParams: { limit: 10 },
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'none',
    });

    const payload = JSON.parse(result[0].text);
    expect(payload.results).toHaveLength(5);
    expect(payload.next_cursor).toBeUndefined();
  });

  it('does not crash on invalid cursor (treated as absent)', async () => {
    const corpus = fakeCorpus();
    const { executor } = buildExecutor(corpus);

    const { result } = await executor.executeImmediate({
      tool: 'search_threads',
      toolParams: { limit: 10, cursor: 'garbage!!!' },
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'none',
    });

    const payload = JSON.parse(result[0].text);
    expect(payload.results).toHaveLength(10);
    // Falls back to no `before` filter — first page returned.
    expect(payload.results[0].uid).toBe(corpus[0].uid);
  });

  it('includes boundary-timestamp rows when 15 messages share one date (regression)', async () => {
    // 15 messages, all sharing the SAME timestamp, distinct UIDs.
    // A naive cursor that only passes `before` (strict less-than on IMAP
    // SEARCH) will return 0 rows on page 2 since nothing is strictly older.
    const sharedDate = '2026-04-15T12:00:00.000Z';
    const corpus = Array.from({ length: 15 }, (_, i) => ({
      uid: 2000 + i,
      envelope: {
        message_id: `m${i}`,
        subject: `s ${i}`,
        from: { address: 'x@y', name: null },
        date: sharedDate,
      },
      snippet: '',
      flags: [],
      list_id: null,
      list_unsubscribe: null,
    }));
    // Search spy: filter by before (strict <) if provided, else return all.
    // This mirrors real IMAP SEARCH BEFORE semantics (date-exclusive).
    const searchSpy = vi.fn(async (_mailbox: string, criteria: any, limit: number) => {
      let rows = corpus;
      if (criteria.before instanceof Date) {
        const beforeMs = criteria.before.getTime();
        rows = rows.filter((r) => new Date(r.envelope.date).getTime() < beforeMs);
      }
      return rows.slice(0, limit);
    });
    const pool = {
      withConnection: vi.fn(async (_id: string, fn: any) =>
        fn({ search: searchSpy, fetchSnippet: async () => '' })
      ),
    };
    const executor = new Executor({
      db: openDatabase(':memory:'),
      accounts: accounts(),
      pool: pool as any,
      logger,
    });

    const page1 = JSON.parse(
      (await executor.executeImmediate({
        tool: 'search_threads',
        toolParams: { limit: 10 },
        accountId: 'a@x.com',
        agentId: 'test',
        risk: 'none',
      })).result[0].text
    );
    expect(page1.results).toHaveLength(10);
    expect(page1.next_cursor).toBeTruthy();
    const page1Uids = page1.results.map((r: any) => r.uid);

    const page2 = JSON.parse(
      (await executor.executeImmediate({
        tool: 'search_threads',
        toolParams: { limit: 10, cursor: page1.next_cursor },
        accountId: 'a@x.com',
        agentId: 'test',
        risk: 'none',
      })).result[0].text
    );

    // The 5 remaining messages (not returned on page 1) should surface here.
    expect(page2.results).toHaveLength(5);
    const page2Uids = page2.results.map((r: any) => r.uid);
    // No overlap between pages.
    expect(page2Uids.some((id: number) => page1Uids.includes(id))).toBe(false);
    // Together pages must cover all 15 corpus UIDs.
    const combined = [...page1Uids, ...page2Uids].sort((a, b) => a - b);
    expect(combined).toEqual(corpus.map((r) => r.uid).sort((a, b) => a - b));
  });

  it('cursor overrides `before` param', async () => {
    const corpus = fakeCorpus();
    const { executor, searchSpy } = buildExecutor(corpus);

    const cursor = encodeCursor({
      before: '2026-04-20T00:00:00.000Z',
      lastUid: 9999,
    });

    await executor.executeImmediate({
      tool: 'search_threads',
      toolParams: {
        limit: 10,
        cursor,
        before: '2099-01-01T00:00:00Z',
      },
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'none',
    });

    const [, criteria] = searchSpy.mock.calls[0];
    // Cursor `before` is padded by 1ms so IMAP's strict less-than still
    // surfaces boundary-timestamp rows; tuple filter in JS enforces
    // the true `(date, uid) < (cursor.before, cursor.lastUid)` ordering.
    expect((criteria.before as Date).toISOString()).toBe('2026-04-20T00:00:00.001Z');
  });
});
