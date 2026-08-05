import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openCache, type Database } from '../../src/cache/db.js';
import { upsertMessage, deleteMessages } from '../../src/cache/store.js';
import { syncMailbox, type SyncOptions } from '../../src/cache/sync.js';
import { FakeSyncProvider, mailbox, message } from './fake-provider.js';
import type { EmailMessage } from '../../src/types.js';

/**
 * A delta the size of the mailbox's whole history must not crash the sync.
 *
 * Observed on a real iCloud account the first tick after the ENABLE repair
 * put it on the delta path: every INBOX pass failed with "too many SQL
 * variables". SQLite binds at most 32766 parameters per statement
 * (SQLITE_MAX_VARIABLE_NUMBER, verified against node:sqlite), and
 * deleteMessages bound one per vanished UID — so a server reporting tens of
 * thousands of vanished UIDs killed the statement outright, every tick.
 *
 * iCloud can genuinely produce a list that size: VANISHED (EARLIER) covers
 * everything expunged since the given modseq, and some server revisions have a
 * documented bug that emits responses spanning the entire mailbox. Either way
 * the list arrives from the network, so its size is not ours to assume.
 */

let db: Database;

beforeEach(() => {
  db = openCache(':memory:');
});

function cached(uid: number): EmailMessage {
  return {
    uid,
    messageId: `<m${uid}@x>`,
    from: { address: 'a@example.com', name: null },
    to: [],
    cc: [],
    date: new Date(Date.now() - 60_000).toISOString(),
    subject: `s${uid}`,
    bodyText: 'b',
    references: [],
    flags: [],
    mailbox: 'INBOX',
  };
}

describe('deleteMessages with a giant UID list', () => {
  it('handles more UIDs than SQLite can bind in one statement', () => {
    for (let uid = 1; uid <= 20; uid++) {
      upsertMessage(db, { accountId: 'work', message: cached(uid), uidvalidity: 1 });
    }

    // Far past the 32766-parameter limit. The cached rows are scattered
    // through the list, so every chunk boundary case gets exercised.
    const uids = Array.from({ length: 40_000 }, (_, i) => i + 1);

    const deleted = deleteMessages(db, {
      accountId: 'work',
      mailbox: 'INBOX',
      uidvalidity: 1,
      uids,
    });

    expect(deleted).toBe(20);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }).n
    ).toBe(0);
  });

  it('only ever deletes rows it actually has', () => {
    upsertMessage(db, { accountId: 'work', message: cached(5), uidvalidity: 1 });
    upsertMessage(db, { accountId: 'other', message: cached(6), uidvalidity: 1 });

    // A bogus vanished list naming the world can, at worst, empty this
    // mailbox's cache — which re-backfills. It cannot touch other accounts or
    // other generations, and it never touches real mail at all.
    const deleted = deleteMessages(db, {
      accountId: 'work',
      mailbox: 'INBOX',
      uidvalidity: 1,
      uids: Array.from({ length: 40_000 }, (_, i) => i + 1),
    });

    expect(deleted).toBe(1);
    const remaining = db.prepare(`SELECT account_id FROM messages`).all() as Array<{
      account_id: string;
    }>;
    expect(remaining).toEqual([{ account_id: 'other' }]);
  });
});

describe('a delta with an absurd vanished list', () => {
  async function syncWithHugeVanished(vanishedCount: number, warn: ReturnType<typeof vi.fn>) {
    const provider = new FakeSyncProvider([mailbox('INBOX', [message(1), message(2)])]);
    // Establish state so the next pass takes the delta path.
    const options: SyncOptions = {
      accountId: 'work',
      provider,
      backfillDays: null,
      logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    };
    await syncMailbox(db, options, 'INBOX');

    provider.delta = vi.fn(async () => ({
      uidValidity: 1,
      highestModseq: 99,
      vanished: Array.from({ length: vanishedCount }, (_, i) => i + 1000),
      changed: [],
      vanishedReliable: true,
    })) as never;

    return syncMailbox(db, options, 'INBOX');
  }

  it('survives it and says so', async () => {
    const warn = vi.fn();

    const result = await syncWithHugeVanished(40_000, warn);

    // Surviving quietly is not enough: a vanished set bigger than the mailbox
    // is the fingerprint of the documented iCloud QRESYNC bug, and the log is
    // where that gets noticed.
    expect(result.mode).toBe('delta');
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/vanished/i),
      expect.objectContaining({ vanished: 40_000 })
    );
  });

  it('does not warn about ordinary deletions', async () => {
    const warn = vi.fn();

    await syncWithHugeVanished(3, warn);

    const vanishedWarnings = warn.mock.calls.filter(([msg]) =>
      /vanished/i.test(String(msg))
    );
    expect(vanishedWarnings).toEqual([]);
  });
});
