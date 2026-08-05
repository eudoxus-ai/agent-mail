import { describe, it, expect, beforeEach } from 'vitest';
import { openCache, type Database } from '../../src/cache/db.js';
import { resolveMailboxes, syncMailbox, HOLDING_MAILBOX } from '../../src/cache/sync.js';
import { getMailboxState } from '../../src/cache/state.js';
import { searchCache } from '../../src/cache/query.js';
import { FakeSyncProvider, mailbox, message } from './fake-provider.js';

/**
 * The holding folder has to sync — and be searchable — whatever the server's
 * namespace calls it.
 *
 * Observed on a real account: a Dovecot-style server prefixes every personal
 * mailbox with `INBOX.` (INBOX.Archive, INBOX.Sent), so the holding folder is
 * `INBOX.agent-mail-holding`. The sync selector matched paths literally, so on
 * that account holding never synced at all — it simply did not appear in the
 * status output, and every search of held mail went to IMAP.
 *
 * Two rules fall out. Selection: a literal selector also matches a path whose
 * last segment equals it, so the namespaced folder is found. Storage: rows are
 * cached under the CANONICAL name, not the server path — the executor and
 * every tool ask for 'agent-mail-holding', and an account that cached its held
 * mail under 'INBOX.agent-mail-holding' would answer those queries with
 * nothing, which is the same bug moved one layer up.
 */

let db: Database;

beforeEach(() => {
  db = openCache(':memory:');
});

describe('resolveMailboxes on a namespaced server', () => {
  const dovecot = [
    { path: 'INBOX', specialUse: null, delimiter: '.' },
    { path: 'INBOX.Archive', specialUse: '\\Archive', delimiter: '.' },
    { path: 'INBOX.Sent', specialUse: '\\Sent', delimiter: '.' },
    { path: 'INBOX.agent-mail-holding', specialUse: null, delimiter: '.' },
  ];

  it('finds the holding folder behind the INBOX. prefix', () => {
    const resolved = resolveMailboxes(dovecot);

    expect(resolved).toContainEqual({
      path: 'INBOX.agent-mail-holding',
      storeAs: HOLDING_MAILBOX,
    });
  });

  it('stores special-use mailboxes under their server path, as before', () => {
    const resolved = resolveMailboxes(dovecot);

    // Special-use folders keep their real names — nothing queries them by a
    // canonical alias, and renaming them in the cache would orphan every row
    // already stored for existing accounts.
    expect(resolved).toContainEqual({ path: 'INBOX.Sent', storeAs: 'INBOX.Sent' });
    expect(resolved).toContainEqual({ path: 'INBOX', storeAs: 'INBOX' });
  });

  it('prefers an exact path match over a suffix match', () => {
    const both = [
      { path: 'agent-mail-holding', specialUse: null, delimiter: '/' },
      { path: 'Old.agent-mail-holding', specialUse: null, delimiter: '.' },
    ];

    const resolved = resolveMailboxes(both, [HOLDING_MAILBOX]);

    expect(resolved).toEqual([{ path: 'agent-mail-holding', storeAs: HOLDING_MAILBOX }]);
  });

  it('does not match a partial segment', () => {
    // "holding" is a substring of the segment but not the segment. Matching it
    // would sync somebody's unrelated folder into the canonical name.
    const descriptors = [
      { path: 'INBOX.agent-mail-holding', specialUse: null, delimiter: '.' },
    ];

    expect(resolveMailboxes(descriptors, ['holding'])).toEqual([]);
  });

  it('works with slash-delimited namespaces too', () => {
    const descriptors = [
      { path: 'Mail/agent-mail-holding', specialUse: null, delimiter: '/' },
    ];

    expect(resolveMailboxes(descriptors, [HOLDING_MAILBOX])).toEqual([
      { path: 'Mail/agent-mail-holding', storeAs: HOLDING_MAILBOX },
    ]);
  });

  it('leaves a flat-namespace server exactly as it was', () => {
    const icloud = [
      { path: 'INBOX', specialUse: null, delimiter: '/' },
      { path: 'Sent Messages', specialUse: '\\Sent', delimiter: '/' },
      { path: 'agent-mail-holding', specialUse: null, delimiter: '/' },
    ];

    expect(resolveMailboxes(icloud)).toEqual([
      { path: 'INBOX', storeAs: 'INBOX' },
      { path: 'Sent Messages', storeAs: 'Sent Messages' },
      { path: 'agent-mail-holding', storeAs: HOLDING_MAILBOX },
    ]);
  });
});

describe('syncing a namespaced holding folder', () => {
  it('fetches from the server path but stores under the canonical name', async () => {
    const provider = new FakeSyncProvider([
      mailbox('INBOX.agent-mail-holding', [message(1), message(2)]),
    ]);

    await syncMailbox(
      db,
      { accountId: 'work', provider, backfillDays: null },
      { path: 'INBOX.agent-mail-holding', storeAs: HOLDING_MAILBOX }
    );

    // The rows answer to the name every tool asks by...
    const rows = searchCache(db, {
      accountIds: ['work'],
      mailbox: HOLDING_MAILBOX,
      limit: 10,
    });
    expect(rows).toHaveLength(2);

    // ...and so does the sync state, which is what status and coverage read.
    expect(getMailboxState(db, 'work', HOLDING_MAILBOX)).toBeTruthy();
    expect(getMailboxState(db, 'work', 'INBOX.agent-mail-holding')).toBeFalsy();
  });

  it('keeps plain-string calls working unchanged', async () => {
    const provider = new FakeSyncProvider([mailbox('INBOX', [message(1)])]);

    const result = await syncMailbox(
      db,
      { accountId: 'work', provider, backfillDays: null },
      'INBOX'
    );

    expect(result.ingested).toBe(1);
    expect(getMailboxState(db, 'work', 'INBOX')).toBeTruthy();
  });
});
