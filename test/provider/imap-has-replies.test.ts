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

describe('hasRepliesTo', () => {
  it('searches many Message-Ids per round trip', async () => {
    const { imap, search } = provider({ search: () => [] });
    await imap.hasRepliesTo('INBOX', ids(40), []);
    expect(search.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('covers every id, across chunks', async () => {
    const { imap, search } = provider({ search: () => [] });
    await imap.hasRepliesTo('INBOX', ids(45), []);
    const searched = JSON.stringify(search.mock.calls);
    for (const id of ids(45)) expect(searched).toContain(id);
  });

  it('is true when another message references a selected id', async () => {
    const { imap } = provider({ search: () => [9], references: '<m1@x>' });
    await expect(imap.hasRepliesTo('INBOX', ids(3), [1, 2, 3])).resolves.toBe(true);
  });

  it('ignores the selected messages themselves', async () => {
    const { imap } = provider({ search: () => [1, 2], references: '<m1@x>' });
    await expect(imap.hasRepliesTo('INBOX', ids(3), [1, 2])).resolves.toBe(false);
  });

  it('does not trust a substring hit from the server', async () => {
    const { imap } = provider({ search: () => [9], references: '<other@x>' });
    await expect(imap.hasRepliesTo('INBOX', ids(3), [])).resolves.toBe(false);
  });

  it('throws rather than reporting no replies when a search fails', async () => {
    const { imap } = provider({ search: () => false });
    await expect(imap.hasRepliesTo('INBOX', ids(3), [])).rejects.toThrow(/search failed/i);
  });

  it('does no work for an empty selection', async () => {
    const { imap, search } = provider({ search: () => [] });
    await expect(imap.hasRepliesTo('INBOX', [], [])).resolves.toBe(false);
    expect(search).not.toHaveBeenCalled();
  });
});
