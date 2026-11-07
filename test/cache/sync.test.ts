import { describe, it, expect, beforeEach } from 'vitest';
import { openCache, type Database } from '../../src/cache/db.js';
import {
  syncAccount,
  syncMailbox,
  drainMailboxBodies,
  resolveMailboxes,
  unresolvedSelectors,
  DEFAULT_MAILBOX_SELECTORS,
  type SyncOptions,
} from '../../src/cache/sync.js';

/**
 * Bodies are drained separately now, on their own connection, so that a slow
 * body fetch cannot consume the envelope sync's timeout budget. These helpers
 * do both, which is what the sync loop does per mailbox.
 */
async function syncAndDrain(
  database: Database,
  options: SyncOptions,
  mbx: string
): Promise<{ ingested: number; bodiesFetched: number; mode: string }> {
  const result = await syncMailbox(database, options, mbx);
  const bodiesFetched = result.uidvalidity
    ? await drainMailboxBodies(database, options, mbx, result.uidvalidity)
    : 0;
  return { ...result, bodiesFetched };
}
import { getMailboxState } from '../../src/cache/state.js';
import { FakeSyncProvider, mailbox, message } from './fake-provider.js';

let db: Database;

beforeEach(() => {
  db = openCache(':memory:');
});

const NOW = Date.UTC(2026, 6, 31);

function opts(provider: FakeSyncProvider, extra: Partial<SyncOptions> = {}): SyncOptions {
  return {
    accountId: 'work',
    provider,
    now: () => NOW,
    backfillDays: null,
    ...extra,
  };
}

function cachedCount(): number {
  return (db.prepare(`SELECT COUNT(*) c FROM messages`).get() as { c: number }).c;
}

function uidsInCache(): number[] {
  return (
    db.prepare(`SELECT uid FROM messages ORDER BY uid`).all() as Array<{ uid: number }>
  ).map((r) => r.uid);
}

describe('resolveMailboxes', () => {
  it('resolves special-use flags across provider naming differences', () => {
    const gmail = [
      { path: 'INBOX', specialUse: '\\Inbox' },
      { path: '[Gmail]/Sent Mail', specialUse: '\\Sent' },
      { path: '[Gmail]/All Mail', specialUse: '\\All' },
    ];
    expect(resolveMailboxes(gmail).map((m) => m.path)).toEqual(['INBOX', '[Gmail]/Sent Mail']);

    const icloud = [
      { path: 'INBOX', specialUse: null },
      { path: 'Sent Messages', specialUse: '\\Sent' },
      { path: 'Archive', specialUse: '\\Archive' },
    ];
    expect(resolveMailboxes(icloud).map((m) => m.path)).toEqual([
      'INBOX',
      'Sent Messages',
      'Archive',
    ]);
  });

  it('excludes Gmail All Mail by default (design D3)', () => {
    const descriptors = [
      { path: 'INBOX', specialUse: '\\Inbox' },
      { path: '[Gmail]/All Mail', specialUse: '\\All' },
    ];
    expect(resolveMailboxes(descriptors).map((m) => m.path)).not.toContain('[Gmail]/All Mail');
  });

  it('includes All Mail when explicitly opted in', () => {
    const descriptors = [
      { path: 'INBOX', specialUse: '\\Inbox' },
      { path: '[Gmail]/All Mail', specialUse: '\\All' },
    ];
    expect(resolveMailboxes(descriptors, ['INBOX', '\\All']).map((m) => m.path)).toEqual([
      'INBOX',
      '[Gmail]/All Mail',
    ]);
  });

  it('skips selectors that match nothing rather than failing', () => {
    const descriptors = [{ path: 'INBOX', specialUse: '\\Inbox' }];
    expect(
      resolveMailboxes(descriptors, DEFAULT_MAILBOX_SELECTORS).map((m) => m.path)
    ).toEqual(['INBOX']);
  });

  it('deduplicates when two selectors resolve to the same path', () => {
    const descriptors = [{ path: 'INBOX', specialUse: '\\Inbox' }];
    expect(resolveMailboxes(descriptors, ['INBOX', '\\Inbox']).map((m) => m.path)).toEqual([
      'INBOX',
    ]);
  });
});

describe('backfill', () => {
  it('ingests every message and marks the mailbox complete', () => {
    const provider = new FakeSyncProvider([
      mailbox('INBOX', [message(1), message(2), message(3)]),
    ]);

    return syncMailbox(db, opts(provider), 'INBOX').then((result) => {
      expect(result.mode).toBe('backfill');
      expect(result.ingested).toBe(3);
      expect(result.backfillComplete).toBe(true);
      expect(uidsInCache()).toEqual([1, 2, 3]);
    });
  });

  it('walks newest-first so recent mail is usable before the tail lands', async () => {
    const provider = new FakeSyncProvider([
      mailbox('INBOX', [message(1), message(2), message(3), message(4)]),
    ]);

    await syncMailbox(db, opts(provider, { batchSize: 2, maxBatches: 1 }), 'INBOX');

    expect(uidsInCache()).toEqual([3, 4]);
    const state = getMailboxState(db, 'work', 'INBOX')!;
    expect(state.backfill_cursor).toBe(3);
    expect(state.backfill_complete).toBe(0);
  });

  it('resumes from the cursor after an interruption', async () => {
    const provider = new FakeSyncProvider([
      mailbox('INBOX', [message(1), message(2), message(3), message(4)]),
    ]);

    await syncMailbox(db, opts(provider, { batchSize: 2, maxBatches: 1 }), 'INBOX');
    await syncMailbox(db, opts(provider, { batchSize: 2, maxBatches: 1 }), 'INBOX');

    expect(uidsInCache()).toEqual([1, 2, 3, 4]);
    // One more run to observe completion.
    await syncMailbox(db, opts(provider, { batchSize: 2 }), 'INBOX');
    expect(getMailboxState(db, 'work', 'INBOX')!.backfill_complete).toBe(1);
  });

  it('respects the backfill window (design D4)', async () => {
    const old = message(1, { date: new Date(Date.UTC(2020, 0, 1)).toISOString() });
    const recent = message(2, { date: new Date(Date.UTC(2026, 6, 1)).toISOString() });
    const provider = new FakeSyncProvider([mailbox('INBOX', [old, recent])]);

    await syncMailbox(db, opts(provider, { backfillDays: 730 }), 'INBOX');

    expect(uidsInCache()).toEqual([2]);
  });

  it('captures HIGHESTMODSEQ at the start so mid-backfill changes are not lost', async () => {
    const provider = new FakeSyncProvider([
      mailbox('INBOX', [message(1), message(2)]),
    ]);

    // Interrupt after one batch, then a message arrives before backfill finishes.
    await syncMailbox(db, opts(provider, { batchSize: 1, maxBatches: 1 }), 'INBOX');
    const capturedModseq = getMailboxState(db, 'work', 'INBOX')!.highestmodseq;
    provider.arrive('INBOX', message(3));

    await syncMailbox(db, opts(provider, { batchSize: 10 }), 'INBOX');
    await syncMailbox(db, opts(provider), 'INBOX');

    expect(capturedModseq).toBe(2);
    expect(uidsInCache()).toContain(3);
  });

  it('is idempotent across repeated full runs', async () => {
    const provider = new FakeSyncProvider([
      mailbox('INBOX', [message(1), message(2)]),
    ]);

    await syncMailbox(db, opts(provider), 'INBOX');
    await syncMailbox(db, opts(provider), 'INBOX');
    await syncMailbox(db, opts(provider), 'INBOX');

    expect(cachedCount()).toBe(2);
  });
});

describe('delta sync', () => {
  async function backfilled() {
    const provider = new FakeSyncProvider([
      mailbox('INBOX', [message(1), message(2)]),
    ]);
    await syncMailbox(db, opts(provider), 'INBOX');
    return provider;
  }

  it('ingests new arrivals', async () => {
    const provider = await backfilled();
    provider.arrive('INBOX', message(3, { subject: 'Fresh' }));

    const result = await syncMailbox(db, opts(provider), 'INBOX');

    expect(result.mode).toBe('delta');
    expect(uidsInCache()).toEqual([1, 2, 3]);
  });

  it('applies flag changes from the delta response alone', async () => {
    const provider = await backfilled();
    const beforeFetches = provider.calls.fetchEnvelopes;
    const beforeListings = provider.calls.listUids;
    provider.setFlags('INBOX', 1, ['\\Seen', '\\Flagged']);

    await syncMailbox(db, opts(provider), 'INBOX');

    const row = db
      .prepare(`SELECT seen, flagged FROM messages WHERE uid = 1`)
      .get() as { seen: number; flagged: number };
    expect(row.seen).toBe(1);
    expect(row.flagged).toBe(1);
    // The QRESYNC response carries the changed envelopes, so a flag change
    // costs no extra fetch and no UID listing at all — that round trip is the
    // entire point of CONDSTORE over a rescan.
    expect(provider.calls.fetchEnvelopes).toBe(beforeFetches);
    expect(provider.calls.listUids).toBe(beforeListings);
  });

  it('removes messages the server reports as VANISHED', async () => {
    const provider = await backfilled();
    provider.expunge('INBOX', 1);

    const result = await syncMailbox(db, opts(provider), 'INBOX');

    expect(result.vanished).toBe(1);
    expect(uidsInCache()).toEqual([2]);
  });

  it('reconciles deletions on a CONDSTORE-only server, where vanished is empty', async () => {
    // Regression: the ImapFlow client was originally constructed without
    // qresync, so EXPUNGE carried sequence numbers and `vanished` was always
    // empty. Deleted mail would have lingered in the cache forever, surfacing
    // in searches long after it was gone from the server.
    const provider = new FakeSyncProvider([
      mailbox('INBOX', [message(1), message(2)]),
    ]);
    provider.supportsQresync = false;
    await syncMailbox(db, opts(provider), 'INBOX');
    expect(uidsInCache()).toEqual([1, 2]);

    provider.expunge('INBOX', 1);
    const result = await syncMailbox(db, opts(provider), 'INBOX');

    expect(result.vanished).toBe(1);
    expect(uidsInCache()).toEqual([2]);
  });

  it('trusts vanished and skips the extra UID listing when QRESYNC is available', async () => {
    const provider = new FakeSyncProvider([
      mailbox('INBOX', [message(1), message(2)]),
    ]);
    await syncMailbox(db, opts(provider), 'INBOX');
    const before = provider.calls.listUids;

    provider.expunge('INBOX', 1);
    await syncMailbox(db, opts(provider), 'INBOX');

    expect(uidsInCache()).toEqual([2]);
    // No reconciliation scan needed — that's what QRESYNC buys.
    expect(provider.calls.listUids).toBe(before);
  });

  it('does not re-ingest unchanged messages', async () => {
    const provider = await backfilled();
    const before = provider.calls.fetchEnvelopes;

    const result = await syncMailbox(db, opts(provider), 'INBOX');

    expect(result.ingested).toBe(0);
    expect(provider.calls.fetchEnvelopes).toBe(before);
  });
});

describe('UIDVALIDITY change', () => {
  it('purges the mailbox and re-backfills', async () => {
    const provider = new FakeSyncProvider([
      mailbox('INBOX', [message(1), message(2)]),
    ]);
    await syncMailbox(db, opts(provider), 'INBOX');
    expect(cachedCount()).toBe(2);

    // Server reassigns UIDs: same UID numbers, different messages.
    provider.bumpUidValidity('INBOX', 99);
    provider.mailboxes[0].messages = [
      message(1, { messageId: '<different@example.com>', subject: 'Different' }),
    ];

    const result = await syncMailbox(db, opts(provider), 'INBOX');

    expect(result.purged).toBe(true);
    expect(cachedCount()).toBe(1);
    const row = db.prepare(`SELECT subject, uidvalidity FROM messages`).get() as {
      subject: string;
      uidvalidity: number;
    };
    expect(row.subject).toBe('Different');
    expect(row.uidvalidity).toBe(99);
  });

  it('clears the stale HIGHESTMODSEQ so the next delta is not run against it', async () => {
    const provider = new FakeSyncProvider([mailbox('INBOX', [message(1)])]);
    await syncMailbox(db, opts(provider), 'INBOX');

    provider.bumpUidValidity('INBOX', 42);
    await syncMailbox(db, opts(provider), 'INBOX');

    const state = getMailboxState(db, 'work', 'INBOX')!;
    expect(state.uidvalidity).toBe(42);
    expect(state.backfill_complete).toBe(1);
  });

  it('leaves no orphaned FTS rows behind after a purge', async () => {
    const provider = new FakeSyncProvider([
      mailbox('INBOX', [message(1), message(2)]),
    ]);
    await syncMailbox(db, opts(provider), 'INBOX');

    provider.bumpUidValidity('INBOX', 7);
    provider.mailboxes[0].messages = [];
    await syncMailbox(db, opts(provider), 'INBOX');

    const fts = db.prepare(`SELECT COUNT(*) c FROM messages_fts`).get() as { c: number };
    expect(fts.c).toBe(0);
  });
});

describe('no-CONDSTORE fallback', () => {
  it('picks up arrivals and expunges without a modseq', async () => {
    const provider = new FakeSyncProvider([
      mailbox('INBOX', [message(1), message(2)], { highestModseq: null }),
    ]);
    provider.supportsCondstore = false;

    await syncMailbox(db, opts(provider), 'INBOX');
    expect(uidsInCache()).toEqual([1, 2]);

    provider.arrive('INBOX', message(3));
    provider.mailboxes[0].messages = provider.mailboxes[0].messages.filter(
      (m) => m.uid !== 1
    );

    const result = await syncMailbox(db, opts(provider), 'INBOX');

    expect(result.mode).toBe('fallback');
    expect(uidsInCache()).toEqual([2, 3]);
  });

  it('still catches flag changes on recent mail', async () => {
    const provider = new FakeSyncProvider([
      mailbox('INBOX', [message(1)], { highestModseq: null }),
    ]);
    provider.supportsCondstore = false;

    await syncMailbox(db, opts(provider), 'INBOX');
    provider.setFlags('INBOX', 1, ['\\Seen']);

    // The flag resync is throttled: without CONDSTORE the only way to notice a
    // flag change is to re-read envelopes, and doing that every tick is a cost
    // that never converges. It still lands, just on an interval.
    await syncMailbox(db, opts(provider, { now: () => NOW + 31 * 60_000 }), 'INBOX');

    const row = db.prepare(`SELECT seen FROM messages WHERE uid = 1`).get() as {
      seen: number;
    };
    expect(row.seen).toBe(1);
  });

  it('converges to the same cache contents as the CONDSTORE path', async () => {
    const messages = [message(1), message(2), message(3)];

    const modern = new FakeSyncProvider([mailbox('INBOX', [...messages])]);
    await syncMailbox(db, opts(modern), 'INBOX');
    const withCondstore = uidsInCache();

    const legacyDb = openCache(':memory:');
    const legacy = new FakeSyncProvider([
      mailbox('INBOX', [...messages], { highestModseq: null }),
    ]);
    legacy.supportsCondstore = false;
    await syncMailbox(legacyDb, opts(legacy), 'INBOX');
    const withoutCondstore = (
      legacyDb.prepare(`SELECT uid FROM messages ORDER BY uid`).all() as Array<{
        uid: number;
      }>
    ).map((r) => r.uid);

    expect(withoutCondstore).toEqual(withCondstore);
  });
});

describe('body drain', () => {
  it('fetches bodies and makes them searchable', async () => {
    const provider = new FakeSyncProvider([
      mailbox('INBOX', [message(1, { body: 'the indemnity clause is unchanged' })]),
    ]);

    const result = await syncAndDrain(db, opts(provider), 'INBOX');

    expect(result.bodiesFetched).toBe(1);
    const hits = db
      .prepare(
        `SELECT m.uid FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
         WHERE messages_fts MATCH '"indemnity"'`
      )
      .all() as Array<{ uid: number }>;
    expect(hits).toEqual([{ uid: 1 }]);
  });

  it('is bounded by bodyBatchSize per run', async () => {
    const provider = new FakeSyncProvider([
      mailbox('INBOX', [message(1), message(2), message(3)]),
    ]);

    const result = await syncAndDrain(db, opts(provider, { bodyBatchSize: 2 }), 'INBOX');

    expect(result.bodiesFetched).toBe(2);
    const pending = db
      .prepare(`SELECT COUNT(*) c FROM messages WHERE body_state = 'pending'`)
      .get() as { c: number };
    expect(pending.c).toBe(1);
  });

  it('marks a body the server never returned as failed rather than retrying forever', async () => {
    const provider = new FakeSyncProvider([
      mailbox('INBOX', [message(1, { body: undefined, html: undefined })]),
    ]);

    await syncAndDrain(db, opts(provider), 'INBOX');

    const row = db.prepare(`SELECT body_state FROM messages WHERE uid = 1`).get() as {
      body_state: string;
    };
    expect(row.body_state).toBe('failed');
  });

  it('does not refetch bodies already stored', async () => {
    const provider = new FakeSyncProvider([mailbox('INBOX', [message(1)])]);
    await syncMailbox(db, opts(provider), 'INBOX');
    const after = provider.calls.fetchBodies;

    const result = await syncMailbox(db, opts(provider), 'INBOX');

    expect(result.bodiesFetched).toBe(0);
    expect(provider.calls.fetchBodies).toBe(after);
  });
});

describe('error isolation', () => {
  it('records the error and keeps other mailboxes syncing', async () => {
    const provider = new FakeSyncProvider([
      mailbox('INBOX', [message(1)], { specialUse: '\\Inbox' }),
      mailbox('Sent', [message(1)], { specialUse: '\\Sent' }),
    ]);
    // Make INBOX fail on snapshot.
    const originalSnapshot = provider.snapshot.bind(provider);
    provider.snapshot = async (mb: string) => {
      if (mb === 'INBOX') throw new Error('connection reset');
      return originalSnapshot(mb);
    };

    const results = await syncAccount(db, opts(provider));

    const inbox = results.find((r) => r.mailbox === 'INBOX')!;
    const sent = results.find((r) => r.mailbox === 'Sent')!;
    expect(inbox.mode).toBe('error');
    expect(inbox.error).toContain('connection reset');
    expect(sent.mode).toBe('backfill');
    expect(sent.ingested).toBe(1);

    expect(getMailboxState(db, 'work', 'INBOX')?.last_error).toContain('connection reset');
  });

  it('clears last_error once a mailbox recovers', async () => {
    const provider = new FakeSyncProvider([
      mailbox('INBOX', [message(1)], { specialUse: '\\Inbox' }),
    ]);
    provider.failOn.fetchBodies = true;
    await syncAndDrain(db, opts(provider), 'INBOX');
    expect(getMailboxState(db, 'work', 'INBOX')?.last_error).toBeTruthy();

    provider.failOn.fetchBodies = false;
    await syncAndDrain(db, opts(provider), 'INBOX');
    expect(getMailboxState(db, 'work', 'INBOX')?.last_error).toBeNull();
  });
});

describe('coverage reporting', () => {
  it('records the oldest cached date per mailbox', async () => {
    const provider = new FakeSyncProvider([
      mailbox('INBOX', [
        message(1, { date: new Date(Date.UTC(2026, 0, 15)).toISOString() }),
        message(2, { date: new Date(Date.UTC(2026, 5, 1)).toISOString() }),
      ]),
    ]);

    await syncMailbox(db, opts(provider), 'INBOX');

    const state = getMailboxState(db, 'work', 'INBOX')!;
    expect(state.oldest_date).toBe(Date.UTC(2026, 0, 15));
    expect(state.last_delta_at).toBe(NOW);
  });
});

describe('cross-mailbox threading during sync', () => {
  it('joins a Sent reply to its INBOX parent', async () => {
    const provider = new FakeSyncProvider([
      mailbox('INBOX', [message(1, { messageId: '<root@x>' })], {
        specialUse: '\\Inbox',
      }),
      mailbox(
        'Sent',
        [
          message(1, {
            messageId: '<reply@x>',
            inReplyTo: '<root@x>',
            references: ['<root@x>'],
          }),
        ],
        { specialUse: '\\Sent' }
      ),
    ]);

    await syncAccount(db, opts(provider));

    const threads = db
      .prepare(`SELECT DISTINCT thread_id FROM messages`)
      .all() as Array<{ thread_id: string }>;
    expect(threads).toHaveLength(1);
  });
});

describe('resolveMailboxes and Sent folders', () => {
  it('syncs an unflagged sent folder alongside the flagged one', () => {
    const descriptors = [
      { path: 'INBOX', specialUse: '\\Inbox', delimiter: '.' },
      { path: 'INBOX.Sent', specialUse: '\\Sent', delimiter: '.' },
      { path: 'INBOX.Sent Messages', specialUse: null, delimiter: '.' },
    ];
    expect(resolveMailboxes(descriptors, ['\\Sent'])).toEqual([
      { path: 'INBOX.Sent', storeAs: 'INBOX.Sent' },
      { path: 'INBOX.Sent Messages', storeAs: 'INBOX.Sent Messages' },
    ]);
    expect(unresolvedSelectors(descriptors, ['\\Sent'])).toEqual([]);
  });
});
