import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import type { Database } from '../../src/ledger/sqlite.js';
import { openCache, type Database as CacheDatabase } from '../../src/cache/db.js';
import { upsertMessage } from '../../src/cache/store.js';
import { upsertMailboxState } from '../../src/cache/state.js';
import { createLogger } from '../../src/logger.js';
import { getIntentTargets } from '../../src/ledger/intent-targets.js';
import type { AccountConfig, EmailMessage } from '../../src/types.js';

vi.mock('../../src/provider/credentials.js', () => ({
  resolveCredentials: vi.fn((account: any) => ({
    ...account,
    auth: { user: account.email, pass: 'pw' },
  })),
}));

const { Executor } = await import('../../src/executor/executor.js');

/**
 * The IMAP server's FROM search misses messages, and the local cache can prove
 * it.
 *
 * Reported from real use: a sweep on a long sender address matched nothing
 * while ten messages from that sender sat in the inbox. The match is done by
 * the server and is not ours to fix — but the cache stores the address parsed
 * out of the IMAP ENVELOPE and matches it locally, so it can find what the
 * server's search did not.
 *
 * The relationship is deliberately one-way. The cache has a backfill floor and
 * a sync interval, so it under-reports too — just differently. A cache hit the
 * server missed is evidence; a cache miss proves nothing. So the cache may only
 * ever add messages to a sweep, never remove them.
 */

const GENERATION = 42;

/**
 * Dates are relative to now, not fixed calendar dates. The cache rejects a
 * Date: header that is implausibly far in the future — sender-controlled and
 * routinely abused to pin a message to the top of an inbox — so a fixture
 * dated past today's clock silently lands at epoch zero.
 */
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

const accounts: AccountConfig[] = [
  {
    id: 'work',
    email: 'you@example.com',
    imap: { host: 'h', port: 993, tls: true },
    smtp: { host: 'h', port: 587, tls: true },
  },
];

let db: Database;
let cache: CacheDatabase;

function cachedMessage(uid: number, from: string, date: Date): EmailMessage {
  return {
    uid,
    messageId: `<m${uid}@x>`,
    from: { address: from, name: 'Colorado Buffaloes Store' },
    to: [{ address: 'you@example.com', name: null }],
    cc: [],
    date: date.toISOString(),
    subject: `Subject ${uid}`,
    bodyText: `Body ${uid}`,
    references: [],
    flags: [],
    mailbox: 'INBOX',
  };
}

function cacheMessage(
  uid: number,
  from: string,
  date = daysAgo(30),
  uidvalidity = GENERATION
) {
  upsertMessage(cache, { accountId: 'work', message: cachedMessage(uid, from, date), uidvalidity });
}

/** Mark the mailbox freshly synced, or coverage reports it unusable. */
function markFresh() {
  upsertMailboxState(cache, 'work', 'INBOX', {
    uidvalidity: GENERATION,
    uidnext: 9999,
    highestmodseq: 1,
    last_delta_at: Date.now(),
    oldest_date: Date.now() - 730 * DAY,
    backfill_complete: 1,
  });
}

function fakeImap(imapUids: number[], generation = GENERATION) {
  return {
    search: vi.fn(async () => imapUids.map((uid) => ({ uid }))),
    searchUids: vi.fn(async () => []),
    getMailboxPath: vi.fn(async () => 'agent-mail-holding'),
    mailboxSnapshot: vi.fn(async () => ({
      uidValidity: generation,
      uidNext: 9999,
      highestModseq: 1,
      exists: 5,
    })),
    fetchEnvelopes: vi.fn(async (_m: string, uids: number[]) =>
      uids.map((uid) => ({
        uid,
        subject: `Subject ${uid}`,
        from: { address: 'store@example.com', name: null },
      }))
    ),
    moveMessages: vi.fn(async (uids: number[]) => ({
      uidMap: new Map(uids.map((u) => [u, u + 9000])),
    })),
    fetchMessages: vi.fn(async () => []),
    fetchThreadContext: vi.fn(async () => []),
  };
}

function makeExecutor(imap: ReturnType<typeof fakeImap>, withCache = true) {
  return new Executor({
    db,
    accounts,
    pool: {
      withConnection: vi.fn(async (_a: string, fn: (i: unknown) => Promise<unknown>) => fn(imap)),
    } as never,
    logger: createLogger('cli', { minLevel: 'error' }),
    cache: withCache ? cache : undefined,
    cacheConfig: { mode: 'on', freshnessWindowSeconds: 3600 } as never,
  });
}

async function sweep(
  imap: ReturnType<typeof fakeImap>,
  params: Record<string, unknown> = {},
  withCache = true
) {
  const { intent, result } = await makeExecutor(imap, withCache).executeImmediate({
    tool: 'hold_by_sender',
    toolParams: { from: 'store@a.fanaticscommerce.com', include_summary: false, ...params },
    accountId: 'work',
    agentId: 'test',
    risk: 'medium',
  });
  return { intent, payload: JSON.parse(result[0].text) };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  cache = openCache(':memory:');
  markFresh();
});

describe('the cache catches what the server search missed', () => {
  it('holds messages the server never returned', async () => {
    cacheMessage(101, 'store@a.fanaticscommerce.com');
    cacheMessage(102, 'store@a.fanaticscommerce.com');
    const imap = fakeImap([]); // the reported case: server matches nothing

    const { payload, intent } = await sweep(imap);

    // The whole point: these get held, not merely reported.
    expect(payload.total_messages).toBe(2);
    expect(payload.status).not.toBe('no_match');
    const held = getIntentTargets(db, intent.id).map((t) => t.uid).sort();
    expect(held).toEqual([101, 102]);
  });

  it('says the server search was incomplete, and by how much', async () => {
    cacheMessage(101, 'store@a.fanaticscommerce.com');
    cacheMessage(102, 'store@a.fanaticscommerce.com');

    const { payload } = await sweep(fakeImap([101]));

    // Silently papering over a broken server search would leave the caller
    // believing FROM search works, and every dry_run preview would still lie.
    expect(payload.cache_cross_check.recovered).toBe(1);
    expect(payload.warning).toMatch(/server/i);
  });

  it('adds nothing when the server already found everything', async () => {
    cacheMessage(101, 'store@a.fanaticscommerce.com');

    const { payload } = await sweep(fakeImap([101]));

    expect(payload.total_messages).toBe(1);
    expect(payload.cache_cross_check.recovered).toBe(0);
    expect(payload.warning).toBeUndefined();
  });

  it('never removes what the server found but the cache lacks', async () => {
    // The cache has a backfill floor and a sync interval, so it under-reports
    // in its own way. Trusting it to subtract would turn its gaps into missed
    // holds — the same bug in a new place.
    const { payload, intent } = await sweep(fakeImap([500, 501]));

    expect(payload.total_messages).toBe(2);
    expect(getIntentTargets(db, intent.id).map((t) => t.uid).sort()).toEqual([500, 501]);
  });

  it('honours the before cursor on cache hits', async () => {
    cacheMessage(101, 'store@a.fanaticscommerce.com', daysAgo(200));
    cacheMessage(102, 'store@a.fanaticscommerce.com', daysAgo(10));

    const { payload, intent } = await sweep(fakeImap([]), {
      before: daysAgo(100).toISOString(),
    });

    // A recovered message still has to obey the caller's bounds.
    expect(payload.total_messages).toBe(1);
    expect(getIntentTargets(db, intent.id)[0].uid).toBe(101);
  });

  it('refuses cached UIDs from a stale generation', async () => {
    // A UID means nothing across a UIDVALIDITY change. Holding on a cached UID
    // from an older generation would move a message the user never selected —
    // exactly what the Phase 1 guard exists to prevent.
    cacheMessage(101, 'store@a.fanaticscommerce.com', daysAgo(30), 7);

    const { payload } = await sweep(fakeImap([]));

    expect(payload.status).toBe('no_match');
    expect(payload.total_messages).toBe(0);
  });

  it('does not match a different sender', async () => {
    cacheMessage(101, 'someone-else@example.com');

    const { payload } = await sweep(fakeImap([]));

    expect(payload.status).toBe('no_match');
  });

  it('is a no-op when there is no cache', async () => {
    cacheMessage(101, 'store@a.fanaticscommerce.com');

    const { payload } = await sweep(fakeImap([]), {}, false);

    // Cache off is the default today, so the IMAP-only path has to behave
    // exactly as it did before.
    expect(payload.status).toBe('no_match');
    expect(payload.cache_cross_check).toBeUndefined();
  });

  it('says the cross-check did not run when the cache is unusable', async () => {
    // An empty, never-synced cache is not evidence of anything. Reporting
    // "0 recovered" would read as "the server search was verified complete".
    cache = openCache(':memory:');
    const { payload } = await sweep(fakeImap([]));

    expect(payload.cache_cross_check?.checked).toBe(false);
    expect(payload.diagnosis).toMatch(/cache/i);
  });
});
