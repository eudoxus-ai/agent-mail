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
  async function syncWithVanished(
    vanished: number[],
    warn: ReturnType<typeof vi.fn>,
    seedCount = 2
  ) {
    const provider = new FakeSyncProvider([
      mailbox(
        'INBOX',
        Array.from({ length: seedCount }, (_, i) => message(i + 1))
      ),
    ]);
    const options: SyncOptions = {
      accountId: 'work',
      provider,
      backfillDays: null,
      batchSize: 10_000,
      logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    };
    await syncMailbox(db, options, 'INBOX');

    provider.delta = vi.fn(async () => ({
      uidValidity: 1,
      highestModseq: 99,
      vanished,
      changed: [],
      vanishedReliable: true,
    })) as never;

    const result = await syncMailbox(db, options, 'INBOX');
    return { result, options };
  }

  it('ignores vanished UIDs that were never cached, quietly', async () => {
    const warn = vi.fn();

    // Observed on a real iCloud account: the server re-announces the entire
    // lifetime expunge history on every SELECT — 37164 UIDs, none of them in
    // the cache, the identical number every tick. Warning about it each time
    // is an alarm that cries wolf on schedule; deleting is a no-op anyway.
    // The only part of a vanished list that means anything to us is the part
    // we hold.
    const historical = Array.from({ length: 40_000 }, (_, i) => i + 100_000);
    const { result } = await syncWithVanished(historical, warn);

    expect(result.mode).toBe('delta');
    expect(result.vanished).toBe(0);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }).n
    ).toBe(2);
    const vanishedWarnings = warn.mock.calls.filter(([msg]) =>
      /vanished/i.test(String(msg))
    );
    expect(vanishedWarnings).toEqual([]);
  });

  it('stays quiet on the second tick too', async () => {
    // The reported failure mode was the same warning on every tick, forever.
    const warn = vi.fn();
    const historical = Array.from({ length: 40_000 }, (_, i) => i + 100_000);
    const { options } = await syncWithVanished(historical, warn);

    await syncMailbox(db, options, 'INBOX');

    expect(warn.mock.calls.filter(([msg]) => /vanished/i.test(String(msg)))).toEqual([]);
  });

  it('still deletes and still warns when the cache is genuinely affected', async () => {
    const warn = vi.fn();

    // 6000 cached messages all reported vanished: a real mass deletion (or
    // the bug actually reaching cached rows). This is the case the warning
    // exists for, and filtering must not silence it.
    const { result } = await syncWithVanished(
      Array.from({ length: 6_000 }, (_, i) => i + 1),
      warn,
      6_000
    );

    expect(result.vanished).toBe(6_000);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }).n
    ).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/vanished/i),
      expect.objectContaining({ vanished_cached: 6_000 })
    );
  });

  it('deletes ordinary small vanishes without ceremony', async () => {
    const warn = vi.fn();

    const { result } = await syncWithVanished([1, 2], warn, 5);

    expect(result.vanished).toBe(2);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }).n
    ).toBe(3);
    expect(warn.mock.calls.filter(([msg]) => /vanished/i.test(String(msg)))).toEqual([]);
  });
});
