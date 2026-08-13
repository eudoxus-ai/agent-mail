import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openCache, type Database } from '../../src/cache/db.js';
import { unresolvedSelectors } from '../../src/cache/sync.js';

/**
 * A configured mailbox that matches nothing must say so.
 *
 * `cache.yaml`'s `mailboxes:` list is how extra folders get synced — and a
 * selector that matched no folder was silently skipped. That is exactly how
 * the holding folder went unsynced for days on a namespaced server: nothing
 * failed, nothing warned, the folder simply never appeared in status. A typo
 * in a user-added folder name would disappear the same way, and the user
 * would believe the folder was searchable when it was not.
 */

describe('unresolvedSelectors', () => {
  const dovecot = [
    { path: 'INBOX', specialUse: null, delimiter: '.' },
    { path: 'INBOX.Sent', specialUse: '\\Sent', delimiter: '.' },
    { path: 'INBOX.Receipts', specialUse: null, delimiter: '.' },
  ];

  it('reports a literal selector that matches no folder', () => {
    // The typo case: the user wrote "Reciepts" and the folder is "Receipts".
    expect(unresolvedSelectors(dovecot, ['INBOX', 'Reciepts'])).toEqual(['Reciepts']);
  });

  it('reports a special-use selector the server does not advertise', () => {
    expect(unresolvedSelectors(dovecot, ['\\Archive'])).toEqual(['\\Archive']);
  });

  it('is empty when everything matched', () => {
    // Receipts matches by last segment behind the namespace prefix, the same
    // rule the sync itself uses — the two must never disagree about what
    // counts as matched.
    expect(unresolvedSelectors(dovecot, ['INBOX', '\\Sent', 'Receipts'])).toEqual([]);
  });
});

describe('the sync loop says which selectors matched nothing', () => {
  let db: Database;

  beforeEach(() => {
    db = openCache(':memory:');
  });

  async function tickWith(selectors: string[], warn: ReturnType<typeof vi.fn>) {
    const { SyncLoop } = await import('../../src/cache/sync-loop.js');
    const loop = new SyncLoop({
      cache: db,
      accounts: [{ id: 'work', email: 'a@b.c', imap: {} as never, smtp: {} as never }],
      pool: {
        withConnection: vi.fn(async (_a: string, fn: (i: unknown) => Promise<unknown>) =>
          fn({
            listMailboxes: async () => [{ path: 'INBOX', specialUse: null, delimiter: '/' }],
            mailboxSnapshot: async () => {
              throw new Error('stop here — only selector reporting is under test');
            },
          })
        ),
      } as never,
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as never,
      config: { mailboxes: selectors, syncIntervalSeconds: 60 } as never,
    });
    await loop.tick();
    return loop;
  }

  it('warns, naming the selector and the folders that do exist', async () => {
    const warn = vi.fn();
    await tickWith(['INBOX', 'Reciepts'], warn);

    const call = warn.mock.calls.find(([msg]) => /matched no mailbox/i.test(String(msg)));
    expect(call).toBeTruthy();
    expect(call![1]).toMatchObject({ account_id: 'work', selector: 'Reciepts' });
    // Without the real folder list the user is left guessing at the spelling.
    expect(JSON.stringify(call![1].available)).toContain('INBOX');
  });

  it('says it once per account per run, not every tick', async () => {
    const warn = vi.fn();
    const loop = await tickWith(['Reciepts'], warn);
    await loop.tick();

    const complaints = warn.mock.calls.filter(([msg]) =>
      /matched no mailbox/i.test(String(msg))
    );
    expect(complaints).toHaveLength(1);
  });

  it('stays silent when every selector matched', async () => {
    const warn = vi.fn();
    await tickWith(['INBOX'], warn);

    expect(
      warn.mock.calls.filter(([msg]) => /matched no mailbox/i.test(String(msg)))
    ).toEqual([]);
  });
});
