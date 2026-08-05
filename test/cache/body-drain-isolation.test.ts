import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openCache, type Database } from '../../src/cache/db.js';
import { syncMailbox, type SyncOptions } from '../../src/cache/sync.js';
import { getMailboxState } from '../../src/cache/state.js';
import { FakeSyncProvider, mailbox, message } from './fake-provider.js';

/**
 * Fetching message bodies must not be able to invalidate an envelope sync.
 *
 * Observed on a real account: `drainBodies` ran before `last_delta_at` was
 * recorded, so when a body fetch hit the pool's five-minute timeout the whole
 * mailbox was marked failed and its timestamp never advanced. The envelopes had
 * synced perfectly. Status then reported the account stale and unusable, and
 * every tick repeated it — the mailbox could never look current again while any
 * body fetch was slow.
 *
 * Bodies are a best-effort enrichment: they only affect full-text body search.
 * Envelopes are what sender sweeps, header search and coverage all depend on.
 */

let db: Database;

beforeEach(() => {
  db = openCache(':memory:');
});

const NOW = Date.UTC(2026, 6, 31);

function opts(provider: FakeSyncProvider, extra: Partial<SyncOptions> = {}): SyncOptions {
  return { accountId: 'work', provider, now: () => NOW, backfillDays: null, ...extra };
}

function slowBodies(provider: FakeSyncProvider): FakeSyncProvider {
  // The reported failure, exactly: the borrow's timeout fires during a body
  // fetch and the pool destroys the connection underneath it.
  provider.fetchBodies = vi.fn(async () => {
    throw new Error(
      'IMAP operation on account "icloud" exceeded 300s and was abandoned.'
    );
  }) as never;
  return provider;
}

describe('a body-fetch failure', () => {
  it('still records the mailbox as synced', async () => {
    const provider = slowBodies(
      new FakeSyncProvider([mailbox('INBOX', [message(1), message(2)])])
    );

    await syncMailbox(db, opts(provider), 'INBOX');

    // Without this the mailbox reads stale forever and the whole account is
    // reported unusable, while its envelopes are perfectly up to date.
    expect(getMailboxState(db, 'work', 'INBOX')!.last_delta_at).toBe(NOW);
  });

  it('does not report the mailbox sync as failed', async () => {
    const provider = slowBodies(
      new FakeSyncProvider([mailbox('INBOX', [message(1), message(2)])])
    );

    const result = await syncMailbox(db, opts(provider), 'INBOX');

    expect(result.mode).not.toBe('error');
    // The envelopes did land, and that is what searches use.
    expect(result.ingested).toBe(2);
  });

  it('says what actually failed, rather than blaming the mailbox', async () => {
    const provider = slowBodies(new FakeSyncProvider([mailbox('INBOX', [message(1)])]));

    await syncMailbox(db, opts(provider), 'INBOX');

    const state = getMailboxState(db, 'work', 'INBOX')!;
    // "Connection not available" against a mailbox sent the last round of
    // debugging after the wrong thing entirely.
    expect(state.last_error).toMatch(/bod(y|ies)/i);
  });

  it('leaves the bodies queued for the next pass', async () => {
    const provider = slowBodies(new FakeSyncProvider([mailbox('INBOX', [message(1)])]));

    await syncMailbox(db, opts(provider), 'INBOX');

    const pending = db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE body_state = 'pending'`)
      .get() as { n: number };
    expect(Number(pending.n)).toBe(1);
  });
});

describe('an envelope-sync failure', () => {
  it('is still a real failure', async () => {
    const provider = new FakeSyncProvider([mailbox('INBOX', [message(1)])]);
    provider.snapshot = vi.fn(async () => {
      throw new Error('Connection not available');
    }) as never;

    const result = await syncMailbox(db, opts(provider), 'INBOX');

    // Only bodies are best-effort. If the envelopes did not sync, the mailbox
    // genuinely is not current and must not claim otherwise.
    expect(result.mode).toBe('error');
    expect(getMailboxState(db, 'work', 'INBOX')?.last_delta_at ?? null).toBeNull();
  });
});
