import { describe, it, expect, vi } from 'vitest';
import { ImapProvider } from '../../src/provider/imap.js';
import type { ResolvedAccount } from '../../src/types.js';

/**
 * The `when_thread_has_replies` gate runs on every sweep, so its cost is the
 * sweep's cost: measured on live mail it was ~95% of a large sender's runtime,
 * one full download and one header SEARCH per message. These pin the batched
 * search, and the rule that a search we can't complete never reads as "no
 * replies", because that would wave the sweep through the gate.
 */

function provider(opts: {
  search: (query: any) => number[] | false;
  references?: string;
}) {
  const account: ResolvedAccount = {
    id: 'a',
    email: 'me@example.com',
    imap: { host: 'h', port: 993, tls: true },
    smtp: { host: 'h', port: 587, tls: true },
    auth: { user: 'u', pass: 'p' },
  };
  const search = vi.fn(async (query: any) => opts.search(query));
  const imap = new ImapProvider(account);
  (imap as any).client = {
    getMailboxLock: async () => ({ release: vi.fn() }),
    search,
    async *fetch(range: string) {
      for (const uid of range.split(',').map(Number)) {
        yield {
          uid,
          envelope: { messageId: `<${uid}@x>`, from: [], to: [], cc: [] },
          flags: new Set<string>(),
          headers: Buffer.from(`References: ${opts.references ?? ''}\r\n\r\n`),
        };
      }
    },
  };
  return { imap, search };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `<m${i}@x>`);

describe('search', () => {
  it('throws rather than reporting no matches when the server refuses', async () => {
    const { imap } = provider({ search: () => false });
    await expect(imap.search('INBOX', { listId: 'x.io' }, 10)).rejects.toThrow(/search failed/i);
  });
});

describe('replyThreadIds', () => {
  it('searches many Message-Ids per round trip', async () => {
    const { imap, search } = provider({ search: () => [] });
    await imap.replyThreadIds('INBOX', ids(40), []);
    expect(search.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('covers every id, across chunks', async () => {
    const { imap, search } = provider({ search: () => [] });
    await imap.replyThreadIds('INBOX', ids(45), []);
    const searched = JSON.stringify(search.mock.calls);
    for (const id of ids(45)) expect(searched).toContain(id);
  });

  it('returns the thread of a message that references a selected id', async () => {
    const { imap } = provider({ search: () => [9], references: '<root@x> <m1@x>' });
    const thread = await imap.replyThreadIds('INBOX', ids(3), [1, 2, 3]);
    expect([...thread].sort()).toEqual(['<9@x>', '<m1@x>', '<root@x>']);
  });

  it('ignores the selected messages themselves', async () => {
    const { imap } = provider({ search: () => [1, 2], references: '<m1@x>' });
    expect((await imap.replyThreadIds('INBOX', ids(3), [1, 2])).size).toBe(0);
  });

  it('does not trust a substring hit from the server', async () => {
    const { imap } = provider({ search: () => [9], references: '<other@x>' });
    expect((await imap.replyThreadIds('INBOX', ids(3), [])).size).toBe(0);
  });

  it('throws rather than reporting no replies when a search fails', async () => {
    const { imap } = provider({ search: () => false });
    await expect(imap.replyThreadIds('INBOX', ids(3), [])).rejects.toThrow(/search failed/i);
  });

  it('does no work for an empty selection', async () => {
    const { imap, search } = provider({ search: () => [] });
    expect((await imap.replyThreadIds('INBOX', [], [])).size).toBe(0);
    expect(search).not.toHaveBeenCalled();
  });
});

describe('messageIdsIn', () => {
  it('returns only exact matches, not what the server matched as a substring', async () => {
    const { imap } = provider({ search: () => [1, 2] });
    const found = await imap.messageIdsIn('Sent', ['<1@x>', '<absent@x>']);
    expect([...found]).toEqual(['<1@x>']);
  });

  it('searches many Message-Ids per round trip', async () => {
    const { imap, search } = provider({ search: () => [] });
    await imap.messageIdsIn('Sent', ids(40));
    expect(search.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('throws rather than reporting nothing found when a search fails', async () => {
    const { imap } = provider({ search: () => false });
    await expect(imap.messageIdsIn('Sent', ids(3))).rejects.toThrow(/search failed/i);
  });

  it('does no work for an empty list', async () => {
    const { imap, search } = provider({ search: () => [] });
    expect((await imap.messageIdsIn('Sent', [])).size).toBe(0);
    expect(search).not.toHaveBeenCalled();
  });
});

describe('sentMailboxes', () => {
  function withMailboxes(list: unknown[]) {
    const imap = provider({ search: () => [] }).imap;
    (imap as any).client.list = async () => list;
    return imap;
  }

  it('finds a flagged folder and an unflagged one a mail client named', async () => {
    const imap = withMailboxes([
      { path: 'INBOX', name: 'INBOX', delimiter: '.', flags: new Set() },
      { path: 'INBOX.Sent', name: 'Sent', delimiter: '.', specialUse: '\\Sent', flags: new Set() },
      { path: 'INBOX.Sent Messages', name: 'Sent Messages', delimiter: '.', flags: new Set() },
      { path: 'INBOX.Sentinel', name: 'Sentinel', delimiter: '.', flags: new Set() },
    ]);
    await expect(imap.sentMailboxes()).resolves.toEqual(['INBOX.Sent', 'INBOX.Sent Messages']);
  });

  it('skips a folder that cannot be opened', async () => {
    const imap = withMailboxes([
      { path: 'Sent', name: 'Sent', delimiter: '/', flags: new Set(['\\Noselect']) },
      { path: 'Sent Items', name: 'Sent Items', delimiter: '/', flags: new Set() },
    ]);
    await expect(imap.sentMailboxes()).resolves.toEqual(['Sent Items']);
  });
});

describe('a References header separated by commas', () => {
  it('searches for clean ids, because iCloud refuses `<id>,`', async () => {
    const { imap, search } = provider({
      search: () => [5],
      references: '<root@x>, <parent@x>,',
    });
    await imap.messageIdsIn('Sent', ['<root@x>']);
    await imap.replyThreadIds('INBOX', ['<root@x>'], []);
    const terms = JSON.stringify(search.mock.calls);
    expect(terms).not.toContain('>,"');
    const ids = await imap.replyThreadIds('INBOX', ['<root@x>'], []);
    expect([...ids]).toEqual(expect.arrayContaining(['<5@x>', '<root@x>', '<parent@x>']));
  });
});
