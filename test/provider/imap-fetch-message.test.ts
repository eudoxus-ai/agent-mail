import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'stream';
import { ImapProvider } from '../../src/provider/imap.js';

/** A fake that serves decoded parts the way imapflow's `download` does. */
function provider(structure: unknown, parts: Record<string, string>, headers = '') {
  const imap = new ImapProvider({
    id: 'a',
    email: 'me@example.com',
    imap: { host: 'h', port: 993, tls: true },
    smtp: { host: 'h', port: 587, tls: true },
    auth: { user: 'u', pass: 'p' },
  });
  const fetchOne = vi.fn(async () => ({
    uid: 7,
    envelope: {
      messageId: '<m@example.com>',
      subject: 'Alert',
      from: [{ address: 'a@example.com', name: 'A' }],
      to: [{ address: 'b@example.com', name: 'B' }],
      cc: [],
      date: new Date('2026-01-01T00:00:00Z'),
    },
    flags: new Set<string>(),
    bodyStructure: structure,
    headers: Buffer.from(headers),
  }));
  (imap as any).client = {
    getMailboxLock: async () => ({ release: vi.fn() }),
    fetchOne,
    download: async (_uid: string, part: string) => ({
      meta: {},
      content: Readable.from([parts[part] ?? '']),
    }),
  };
  return { imap, fetchOne };
}

const alternative = {
  type: 'multipart/alternative',
  childNodes: [
    { type: 'text/plain', part: '1' },
    { type: 'text/html', part: '2' },
  ],
};

describe('fetchMessage body', () => {
  it('returns the decoded text part, not raw MIME', async () => {
    const { imap } = provider(alternative, { '1': 'Plain body.', '2': '<p>Html body.</p>' });
    const m = await imap.fetchMessage('INBOX', 7);
    expect(m.bodyText).toBe('Plain body.');
  });

  it('falls back to HTML converted to text', async () => {
    const { imap } = provider({ type: 'text/html', part: '1' }, { '1': '<p>Only <b>html</b></p>' });
    const m = await imap.fetchMessage('INBOX', 7);
    expect(m.bodyText.trim()).toBe('Only html');
  });

  it('falls back to HTML when the text part is blank', async () => {
    const { imap } = provider(alternative, { '1': ' \r\n', '2': '<p>Html body.</p>' });
    const m = await imap.fetchMessage('INBOX', 7);
    expect(m.bodyText.trim()).toBe('Html body.');
  });

  it('does not cut a long body short', async () => {
    const long = 'x'.repeat(20_000);
    const { imap } = provider({ type: 'text/plain', part: '1' }, { '1': long });
    const m = await imap.fetchMessage('INBOX', 7);
    expect(m.bodyText).toHaveLength(20_000);
  });

  it('does not download the whole message source', async () => {
    const { imap, fetchOne } = provider({ type: 'text/plain', part: '1' }, { '1': 'x' });
    await imap.fetchMessage('INBOX', 7);
    expect((fetchOne.mock.calls[0] as unknown[])[1]).not.toHaveProperty('source');
  });

  it('still reads threading and list headers', async () => {
    const { imap } = provider(
      { type: 'text/plain', part: '1' },
      { '1': 'x' },
      'In-Reply-To: <p@example.com>\r\nReferences: <r@example.com>\r\n <p@example.com>\r\n' +
        'List-Unsubscribe: <https://example.com/u>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n\r\n'
    );
    const m = await imap.fetchMessage('INBOX', 7);
    expect(m.inReplyTo).toBe('<p@example.com>');
    expect(m.references).toEqual(['<r@example.com>', '<p@example.com>']);
    expect(m.listUnsubscribe?.http_url).toBe('https://example.com/u');
    expect(m.listUnsubscribe?.one_click).toBe(true);
  });
});
