import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openCache, type Database } from '../../src/cache/db.js';
import { syncMailbox, drainMailboxBodies, type SyncOptions } from '../../src/cache/sync.js';
import { getMailboxState } from '../../src/cache/state.js';
import { FakeSyncProvider, mailbox, message } from './fake-provider.js';

/**
 * A server without CONDSTORE must not cost a full rescan every minute.
 *
 * iCloud advertises CONDSTORE but botches the ENABLE handshake, which left
 * `highestmodseq` unrecorded and every tick on the fallback path (the repair
 * for that lives in the provider; this file is about what fallback costs when
 * it does run). That path re-fetched the newest 500
 * envelopes per mailbox every time, purely to notice flag changes — a fixed
 * per-tick cost that never converges. The reported log shows it plainly:
 * `ingested: 6363` on three consecutive successful passes, the same number
 * each time, while two mailboxes timed out at 300s and never finished at all.
 *
 * Arrivals are cheap and stay per-tick. The flag resync is the expensive half
 * and only has to happen periodically.
 */

let db: Database;

beforeEach(() => {
  db = openCache(':memory:');
});

let clock = Date.UTC(2026, 6, 31);
const MINUTE = 60_000;

function opts(provider: FakeSyncProvider, extra: Partial<SyncOptions> = {}): SyncOptions {
  return {
    accountId: 'work',
    provider,
    now: () => clock,
    backfillDays: null,
    ...extra,
  };
}

/** A mailbox with no CONDSTORE support, already fully backfilled. */
async function settledMailbox(count: number): Promise<FakeSyncProvider> {
  const provider = new FakeSyncProvider([
    mailbox(
      'INBOX',
      Array.from({ length: count }, (_, i) => message(i + 1))
    ),
  ]);
  // No modseq: the provider does not support CONDSTORE, so every subsequent
  // sync takes the fallback path.
  provider.snapshot = vi.fn(async () => ({
    uidValidity: 1,
    uidNext: count + 1,
    highestModseq: undefined,
    exists: count,
  })) as never;

  await syncMailbox(db, opts(provider, { batchSize: 10_000 }), 'INBOX');
  return provider;
}

beforeEach(() => {
  clock = Date.UTC(2026, 6, 31);
});

describe('the no-CONDSTORE fallback', () => {
  it('does not re-fetch the flag window on every tick', async () => {
    const provider = await settledMailbox(40);
    (provider.fetchEnvelopes as ReturnType<typeof vi.fn>).mockClear?.();
    const spy = vi.spyOn(provider, 'fetchEnvelopes');

    clock += MINUTE;
    await syncMailbox(db, opts(provider), 'INBOX');
    clock += MINUTE;
    await syncMailbox(db, opts(provider), 'INBOX');

    // Nothing arrived and nothing is due for a flag check, so these two ticks
    // should cost no envelope fetches at all. Re-fetching here is what pinned
    // a real account at thousands of envelopes a minute, forever.
    const fetched = spy.mock.calls.reduce((n, call) => n + (call[1] as number[]).length, 0);
    expect(fetched).toBe(0);
  });

  it('still picks up new mail on every tick', async () => {
    const provider = await settledMailbox(10);

    clock += MINUTE;
    provider.arrive('INBOX', { uid: 11, ...message(11) } as never);
    const result = await syncMailbox(db, opts(provider), 'INBOX');

    // Arrivals are the cheap half and the half that matters for freshness.
    expect(result.ingested).toBeGreaterThan(0);
    const uids = (
      db.prepare(`SELECT uid FROM messages ORDER BY uid`).all() as Array<{ uid: number }>
    ).map((r) => r.uid);
    expect(uids).toContain(11);
  });

  it('does resync flags once the interval has passed', async () => {
    const provider = await settledMailbox(40);
    const spy = vi.spyOn(provider, 'fetchEnvelopes');

    clock += 31 * MINUTE;
    await syncMailbox(db, opts(provider), 'INBOX');

    // Flag changes made in another client still have to land eventually —
    // periodically, not every minute.
    const fetched = spy.mock.calls.reduce((n, call) => n + (call[1] as number[]).length, 0);
    expect(fetched).toBeGreaterThan(0);
  });

  it('records when it last resynced flags, so the interval survives a restart', async () => {
    const provider = await settledMailbox(20);
    clock += 31 * MINUTE;
    await syncMailbox(db, opts(provider), 'INBOX');

    expect(getMailboxState(db, 'work', 'INBOX')!.last_flag_sync_at).toBe(clock);
  });

  it('leaves a CONDSTORE server on the cheap delta path', async () => {
    // The fallback only exists for servers that cannot do better. This must
    // not quietly become the path everyone takes.
    const provider = new FakeSyncProvider([mailbox('INBOX', [message(1), message(2)])]);
    await syncMailbox(db, opts(provider), 'INBOX');
    clock += MINUTE;

    const result = await syncMailbox(db, opts(provider), 'INBOX');
    expect(result.mode).toBe('delta');
  });
});

describe('drainMailboxBodies', () => {
  it('is a separate step the caller can give its own connection', async () => {
    // Bodies used to run inside the same borrow as the envelope sync, so they
    // shared one five-minute budget — and on a slow server the bodies ate it.
    const provider = await settledMailbox(5);

    const fetched = await drainMailboxBodies(db, opts(provider), 'INBOX', 1);

    expect(fetched).toBeGreaterThan(0);
  });

  it('is not run by syncMailbox any more', async () => {
    const provider = new FakeSyncProvider([mailbox('INBOX', [message(1), message(2)])]);
    const spy = vi.spyOn(provider, 'fetchBodies');

    await syncMailbox(db, opts(provider), 'INBOX');

    // The envelope sync has to be able to finish on its own budget, whatever
    // the body queue looks like.
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('body draining under a flaky server', () => {
  it('keeps the bodies fetched before a mid-batch failure', async () => {
    // The batch used to be one provider call: 50 bodies downloaded, nothing
    // persisted until all 50 were back. A timeout at message 49 threw away 48
    // finished downloads — and on a server slow enough to time out, that means
    // the same bodies are re-downloaded and re-lost every tick, forever.
    const provider = await settledMailbox(25);
    const original = provider.fetchBodies.bind(provider);
    let calls = 0;
    provider.fetchBodies = vi.fn(async (mbx: string, uids: number[]) => {
      calls += 1;
      if (calls > 1) throw new Error('Connection not available');
      return original(mbx, uids);
    }) as never;

    const fetched = await drainMailboxBodies(
      db,
      opts(provider, { bodyBatchSize: 25 }),
      'INBOX',
      1
    );

    // The first chunk landed and stayed landed.
    expect(fetched).toBeGreaterThan(0);
    const stored = db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE body_state = 'fetched'`)
      .get() as { n: number };
    expect(Number(stored.n)).toBe(fetched);
  });

  it('fetches in chunks small enough to survive a slow server', async () => {
    const provider = await settledMailbox(25);
    const spy = vi.spyOn(provider, 'fetchBodies');

    await drainMailboxBodies(db, opts(provider, { bodyBatchSize: 25 }), 'INBOX', 1);

    // One giant fetch is one giant all-or-nothing wait. Several small ones
    // bound how much a single stall can take down with it.
    expect(spy.mock.calls.length).toBeGreaterThan(1);
    for (const call of spy.mock.calls) {
      expect((call[1] as number[]).length).toBeLessThanOrEqual(10);
    }
  });
});
