import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openCache, type Database } from '../../src/cache/db.js';
import { upsertMailboxState } from '../../src/cache/state.js';
import { orderByStaleness } from '../../src/cache/sync-loop.js';

/** orderByStaleness works on resolved entries; these tests care only about names. */
const entries = (names: string[]) => names.map((n) => ({ path: n, storeAs: n }));
const first = (db: never, account: string, names: string[]) =>
  orderByStaleness(db, account, entries(names))[0].storeAs;

/**
 * Why some iCloud mailboxes synced and others said "Connection not available".
 *
 * The whole account was synced inside ONE pool borrow, and the pool applies its
 * operation timeout to the borrow as a whole. A big INBOX plus a big Sent, with
 * eleven thousand bodies queued behind them, ate the five-minute budget; the
 * pool then timed out and destroyed the connection. The sync loop kept going —
 * a JavaScript promise cannot be cancelled — so every remaining mailbox threw
 * "Connection not available", recorded it, and moved on to the next, which
 * failed the same way.
 *
 * With a fixed mailbox order (INBOX, Sent, Archive, holding) that is not bad
 * luck, it is starvation: the same tail fails on every tick, forever. Archive
 * had not synced in 29 hours and the holding folder never had.
 *
 * Two things fix it, and both are needed. A borrow per mailbox, so one
 * mailbox's timeout cannot poison the rest. And an order that puts the
 * least-recently-synced first, so a pass cut short for any other reason still
 * cannot strand the same mailbox twice.
 */

let db: Database;

beforeEach(() => {
  db = openCache(':memory:');
});

function synced(mailbox: string, lastDeltaAt: number | null): void {
  upsertMailboxState(db, 'icloud', mailbox, { last_delta_at: lastDeltaAt } as never);
}

describe('orderByStaleness', () => {
  const MINUTE = 60_000;

  it('puts a mailbox that has never synced first', () => {
    const now = Date.now();
    synced('INBOX', now - MINUTE);
    synced('Sent', now - 2 * MINUTE);
    synced('holding', null);

    // The holding folder had never synced once in a day and a half of ticks,
    // because it was always last in a list that never got that far.
    expect(first(db as never, 'icloud', ['INBOX', 'Sent', 'holding'])).toBe('holding');
  });

  it('orders the rest oldest-sync-first', () => {
    const now = Date.now();
    synced('INBOX', now - MINUTE);
    synced('Sent', now - 30 * MINUTE);
    synced('Archive', now - 29 * 60 * MINUTE);

    expect(
      orderByStaleness(db, 'icloud', entries(['INBOX', 'Sent', 'Archive'])).map((m) => m.storeAs)
    ).toEqual(['Archive', 'Sent', 'INBOX']);
  });

  it('rotates: a mailbox that just synced goes to the back', () => {
    const now = Date.now();
    synced('INBOX', now - 10 * MINUTE);
    synced('Archive', now - 20 * MINUTE);

    expect(first(db as never, 'icloud', ['INBOX', 'Archive'])).toBe('Archive');
    // ...and once Archive syncs, INBOX is the stale one. Nothing can hold the
    // front of the queue and starve the others.
    synced('Archive', now);
    expect(first(db as never, 'icloud', ['INBOX', 'Archive'])).toBe('INBOX');
  });

  it('keeps mailboxes it knows nothing about', () => {
    synced('INBOX', Date.now());
    const ordered = orderByStaleness(db, 'icloud', entries(['INBOX', 'BrandNew']));
    expect(ordered).toHaveLength(2);
    expect(ordered[0].storeAs).toBe('BrandNew');
  });

  it('is scoped to the account', () => {
    upsertMailboxState(db, 'other', 'INBOX', { last_delta_at: null } as never);
    synced('INBOX', Date.now());

    // A never-synced mailbox on a different account must not drag this
    // account's INBOX to the front.
    expect(orderByStaleness(db, 'icloud', entries(['INBOX'])).map((m) => m.storeAs)).toEqual([
      'INBOX',
    ]);
  });
});

describe('one borrow per mailbox', () => {
  it('gives each mailbox its own connection and its own timeout budget', async () => {
    const { SyncLoop } = await import('../../src/cache/sync-loop.js');

    const borrows: string[] = [];
    const syncedMailboxes: string[] = [];
    const pool = {
      withConnection: vi.fn(async (accountId: string, fn: (i: unknown) => Promise<unknown>, label?: string) => {
        borrows.push(label ?? 'unlabelled');
        return fn({
          listMailboxes: async () => [
            { path: 'INBOX', specialUse: null },
            { path: 'Archive', specialUse: '\\Archive' },
          ],
          mailboxSnapshot: async () => {
            throw new Error('stop here — only the borrow structure is under test');
          },
        });
      }),
    };

    const loop = new SyncLoop({
      cache: db,
      accounts: [{ id: 'icloud', email: 'a@b.c', imap: {} as never, smtp: {} as never }],
      pool: pool as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      config: { mailboxes: ['INBOX', '\\Archive'], syncIntervalSeconds: 60 } as never,
    });

    await loop.tick();

    // One borrow to list the mailboxes, then one per mailbox. The old shape was
    // a single borrow for all of it, which is what let one slow mailbox consume
    // the timeout budget for every mailbox after it.
    expect(pool.withConnection.mock.calls.length).toBeGreaterThanOrEqual(3);
    void syncedMailboxes;
  });

  it('keeps syncing after one mailbox fails', async () => {
    const { SyncLoop } = await import('../../src/cache/sync-loop.js');

    const attempted: string[] = [];
    let borrow = 0;
    const pool = {
      withConnection: vi.fn(async (_a: string, fn: (i: unknown) => Promise<unknown>) => {
        borrow += 1;
        return fn({
          listMailboxes: async () => [
            { path: 'INBOX', specialUse: null },
            { path: 'Archive', specialUse: '\\Archive' },
          ],
          mailboxSnapshot: async (mailbox: string) => {
            attempted.push(mailbox);
            // The reported failure: the connection is gone for this borrow.
            throw new Error('Connection not available');
          },
        });
      }),
    };

    const loop = new SyncLoop({
      cache: db,
      accounts: [{ id: 'icloud', email: 'a@b.c', imap: {} as never, smtp: {} as never }],
      pool: pool as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      config: { mailboxes: ['INBOX', '\\Archive'], syncIntervalSeconds: 60 } as never,
    });

    await loop.tick();

    // Both were attempted. Under the old shape the second never got a chance
    // once the shared connection was destroyed.
    expect(attempted).toEqual(expect.arrayContaining(['INBOX', 'Archive']));
    void borrow;
  });
});
