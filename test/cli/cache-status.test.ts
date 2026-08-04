import { describe, it, expect, beforeEach } from 'vitest';
import { openCache, type Database } from '../../src/cache/db.js';
import { upsertMailboxState } from '../../src/cache/state.js';
import { buildCacheStatusLines } from '../../src/cli/cache-status.js';
import { DEFAULT_CACHE_CONFIG } from '../../src/cache/config.js';

/**
 * `agent-mail status` has to answer one question: is this up to date?
 *
 * The previous output could not. It printed "backfill complete" and a raw
 * second count per mailbox, which reads as healthy — while the account it
 * described was `unavailable` to every search, because two of its mailboxes had
 * never had a delta sync. A reader had to know that `synced pending` on any one
 * mailbox disqualifies the whole account to spot it, and nothing said so.
 */

let db: Database;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

beforeEach(() => {
  db = openCache(':memory:');
});

function mailbox(
  account: string,
  name: string,
  patch: Record<string, unknown> = {}
): void {
  upsertMailboxState(db, account, name, {
    backfill_complete: 1,
    oldest_date: Date.now() - 365 * 24 * HOUR,
    last_delta_at: Date.now() - 20_000,
    ...patch,
  } as never);
}

function lines(mode: 'off' | 'shadow' | 'on' = 'shadow'): string {
  return buildCacheStatusLines(db, { ...DEFAULT_CACHE_CONFIG, mode }).join('\n');
}

describe('cache status', () => {
  it('calls an account unusable when a mailbox has never synced', () => {
    mailbox('icloud', 'Archive', { last_delta_at: Date.now() - 28 * HOUR });
    mailbox('icloud', 'INBOX', { backfill_complete: 0, last_delta_at: null });

    const out = lines();

    // The verdict a reader needs, on the account line, not inferable from four
    // mailbox lines.
    expect(out).toMatch(/icloud.*NOT USABLE/i);
    expect(out).toMatch(/never synced/i);
    // And why it matters: searches silently go to IMAP instead.
    expect(out).toMatch(/IMAP/i);
  });

  it('agrees with what searches actually do', () => {
    // The verdict comes from the same coverage check the search path uses. Two
    // independent judgements of "is the cache usable" is how status ends up
    // reassuring while every search bypasses the cache.
    mailbox('fresh-acct', 'INBOX');
    mailbox('stale-acct', 'INBOX', { last_delta_at: Date.now() - 3 * HOUR });

    const out = lines();
    expect(out).toMatch(/fresh-acct.*\bfresh\b/i);
    expect(out).toMatch(/stale-acct.*\bstale\b/i);
  });

  it('writes ages a person can read', () => {
    mailbox('icloud', 'Archive', { last_delta_at: Date.now() - 102454_000 });

    const out = lines();

    // 102454s is a number you have to do arithmetic on before it means
    // anything, and the arithmetic is the whole point of reading this.
    expect(out).toMatch(/28h/);
    expect(out).not.toMatch(/102454s/);
  });

  it('surfaces a recorded sync error', () => {
    mailbox('icloud', 'INBOX', {
      last_delta_at: null,
      last_error: 'connection reset while fetching UID 4821',
    });

    // The sync loop records this and nothing has ever displayed it, so the
    // explanation for a stalled account sat unread in the database.
    expect(lines()).toContain('connection reset while fetching UID 4821');
  });

  it('says when nothing is answering searches because the mode says so', () => {
    mailbox('theaboutbox', 'INBOX');

    // A fresh, complete, fully synced cache still serves nothing in shadow.
    // Reporting "fresh" without that context invites "so why are my searches
    // still slow?".
    expect(lines('shadow')).toMatch(/shadow/i);
    expect(lines('on')).not.toMatch(/not answering|measuring only/i);
  });

  it('separates body backfill from searchability', () => {
    mailbox('theaboutbox', 'INBOX');
    db.prepare(
      `INSERT INTO messages (account_id, mailbox, uid, uidvalidity, date, body_state)
       VALUES ('theaboutbox', 'INBOX', 1, 1, ?, 'pending')`
    ).run(Date.now());

    const out = lines();

    // "2963 bodies queued" looks alarming next to a message count. Envelopes
    // are what sender sweeps and header searches use; bodies only affect
    // full-text.
    expect(out).toMatch(/bod(y|ies)/i);
    expect(out).toMatch(/full-text|body text|full text/i);
  });

  it('says so plainly when nothing has synced at all', () => {
    expect(lines()).toMatch(/no mailboxes/i);
  });

  it('does not claim a verdict it cannot support when the cache is off', () => {
    mailbox('theaboutbox', 'INBOX');
    expect(lines('off')).toMatch(/off/i);
  });
});
