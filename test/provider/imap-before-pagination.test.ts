import { describe, it, expect, vi } from 'vitest';
import { ImapProvider } from '../../src/provider/imap.js';

function fakeClient(fetched: Array<{ uid: number; date: string }>) {
  const calls: { searchQuery: any } = { searchQuery: null };
  const client = {
    async getMailboxLock() {
      return { release() {} };
    },
    async search(query: any) {
      calls.searchQuery = query;
      return fetched.map((m) => m.uid);
    },
    async *fetch() {
      for (const m of fetched) {
        yield {
          uid: m.uid,
          envelope: {
            messageId: `m${m.uid}`,
            subject: 's',
            from: [{ address: 'x@y', name: null }],
            date: new Date(m.date),
          },
          source: Buffer.alloc(0),
          headers: Buffer.alloc(0),
          flags: new Set<string>(),
        };
      }
    },
  };
  return { client, calls };
}

describe('ImapProvider search `before` semantics', () => {
  it('widens IMAP BEFORE by one day but post-filters by exact timestamp', async () => {
    const cursor = new Date('2026-04-15T12:30:00Z');
    const { client, calls } = fakeClient([
      { uid: 1, date: '2026-04-15T15:00:00Z' }, // after cursor, same day — must be filtered out
      { uid: 2, date: '2026-04-15T11:00:00Z' }, // before cursor, same day — kept
      { uid: 3, date: '2026-04-14T09:00:00Z' }, // prior day — kept
    ]);

    const provider = new ImapProvider({
      id: 'a@x.com',
      email: 'a@x.com',
      imap: { host: 'h', port: 993, tls: true },
      smtp: { host: 'h', port: 465, tls: true },
      auth: { user: 'u', pass: 'p' },
    });
    (provider as any).client = client;

    const results = await provider.search('INBOX', { before: cursor }, 10);

    // IMAP query was widened by 1 day so the server returns all of April 15
    expect(calls.searchQuery.before).toBeInstanceOf(Date);
    expect((calls.searchQuery.before as Date).toISOString()).toBe(
      '2026-04-16T12:30:00.000Z'
    );

    // Post-filter dropped the same-day-after-cursor message
    const uids = results.map((r) => r.uid).sort();
    expect(uids).toEqual([2, 3]);
  });

  it('returns all results unchanged when `before` is absent', async () => {
    const { client, calls } = fakeClient([
      { uid: 1, date: '2026-04-15T15:00:00Z' },
      { uid: 2, date: '2026-04-14T09:00:00Z' },
    ]);
    const provider = new ImapProvider({
      id: 'a@x.com',
      email: 'a@x.com',
      imap: { host: 'h', port: 993, tls: true },
      smtp: { host: 'h', port: 465, tls: true },
      auth: { user: 'u', pass: 'p' },
    });
    (provider as any).client = client;

    const results = await provider.search('INBOX', {}, 10);
    expect(calls.searchQuery.before).toBeUndefined();
    expect(results).toHaveLength(2);
  });
});
