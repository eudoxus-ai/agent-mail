import { describe, it, expect, vi } from 'vitest';
import { ImapProvider, extractListHeadersFromSource } from '../../src/provider/imap.js';
import { extractSnippet } from '../../src/provider/mime.js';
import type { ResolvedAccount } from '../../src/types.js';

/**
 * Real mail carries 4-9 KB of Received/ARC/DKIM headers ahead of the ones we
 * read: on a sample of live inboxes no List-Unsubscribe started before byte
 * 3051, and every References and In-Reply-To started past byte 2048. A fetch
 * that reads a fixed prefix of the source therefore sees none of them, so this
 * fake serves a message shaped that way and honors byte ranges like a server.
 */

const TRANSPORT_HEADERS = Array.from(
  { length: 60 },
  (_, i) => `Received: from relay${i}.example.net by mx.example.net; Thu, 1 Jan 2026 00:00:00 +0000`
).join('\r\n');

const INTERESTING_HEADERS = [
  'In-Reply-To: <parent@example.com>',
  'References: <root@example.com>',
  ' <parent@example.com>',
  'List-Id: Weekly News <news.example.com>',
  'List-Unsubscribe: <mailto:unsub@example.com>,',
  ' <https://example.com/unsubscribe?id=1>',
  'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
  'Content-Type: multipart/alternative;',
  ' boundary="b1"',
].join('\r\n');

const BODY = [
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hello from the body.',
  '--b1--',
  '',
].join('\r\n');

const RAW = `${TRANSPORT_HEADERS}\r\n${INTERESTING_HEADERS}\r\n\r\n${BODY}`;

function selectHeaders(names: string[]): string {
  const lines = `${TRANSPORT_HEADERS}\r\n${INTERESTING_HEADERS}`.split('\r\n');
  const kept: string[] = [];
  let keeping = false;
  for (const line of lines) {
    if (/^[ \t]/.test(line)) {
      if (keeping) kept.push(line);
      continue;
    }
    keeping = names.includes(line.split(':')[0].toLowerCase());
    if (keeping) kept.push(line);
  }
  return `${kept.join('\r\n')}\r\n\r\n`;
}

function fakeMessage(query: any) {
  const message: Record<string, unknown> = {
    uid: 7,
    envelope: {
      messageId: '<child@example.com>',
      subject: 'Weekly',
      from: [{ address: 'news@example.com', name: 'News' }],
      to: [],
      cc: [],
      date: new Date('2026-01-01T00:00:00Z'),
    },
    flags: new Set<string>(),
    internalDate: new Date('2026-01-01T00:00:00Z'),
    size: RAW.length,
  };
  if (query.source) {
    const { start = 0, maxLength = RAW.length } = query.source;
    message.source = Buffer.from(RAW.slice(start, start + maxLength));
  }
  if (Array.isArray(query.headers)) {
    message.headers = Buffer.from(selectHeaders(query.headers));
  }
  if (query.bodyParts) {
    const { maxLength } = query.bodyParts[0];
    message.bodyParts = new Map([['text', Buffer.from(BODY.slice(0, maxLength))]]);
  }
  return message;
}

function provider(): ImapProvider {
  const account: ResolvedAccount = {
    id: 'a',
    email: 'me@example.com',
    imap: { host: 'h', port: 993, tls: true },
    smtp: { host: 'h', port: 587, tls: true },
    auth: { user: 'u', pass: 'p' },
  };
  const imap = new ImapProvider(account);
  (imap as any).client = {
    getMailboxLock: async () => ({ release: vi.fn() }),
    search: async () => [7],
    async *fetch(_range: string, query: unknown) {
      yield fakeMessage(query);
    },
  };
  return imap;
}

describe('headers beyond the first 2 KB of a message', () => {
  it('fixture really does put them past 2 KB', () => {
    expect(RAW.indexOf('List-Unsubscribe:')).toBeGreaterThan(2048);
    expect(RAW.indexOf('In-Reply-To:')).toBeGreaterThan(2048);
  });

  it('fetchEnvelopes reads list and threading headers', async () => {
    const [m] = await provider().fetchEnvelopes('INBOX', [7]);
    expect(m.inReplyTo).toBe('<parent@example.com>');
    expect(m.references).toEqual(['<root@example.com>', '<parent@example.com>']);
    expect(m.listUnsubscribe?.http_url).toBe('https://example.com/unsubscribe?id=1');
    expect(m.listUnsubscribe?.mailto).toBe('mailto:unsub@example.com');
    expect(m.listUnsubscribe?.one_click).toBe(true);
  });

  it('fetchEnvelopes produces a snippet', async () => {
    const [m] = await provider().fetchEnvelopes('INBOX', [7]);
    expect(m.snippet).toBe('Hello from the body.');
  });

  it('fetchThreadContext reads the headers the replies gate depends on', async () => {
    const [m] = await provider().fetchThreadContext('INBOX', ['<parent@example.com>']);
    expect(m.inReplyTo).toBe('<parent@example.com>');
    expect(m.references).toContain('<parent@example.com>');
    expect(m.snippet).toBe('Hello from the body.');
  });

  it('fetchSyncEnvelopes gives the cache list and threading headers', async () => {
    const [e] = await provider().fetchSyncEnvelopes('INBOX', [7]);
    expect(e.listId).toBe('Weekly News <news.example.com>');
    expect(e.message.listUnsubscribe?.http_url).toBe('https://example.com/unsubscribe?id=1');
    expect(e.message.listUnsubscribe?.one_click).toBe(true);
    expect(e.message.inReplyTo).toBe('<parent@example.com>');
    expect(e.message.references).toHaveLength(2);
    expect(e.snippet).toBe('Hello from the body.');
  });

  it('search returns list headers and a snippet', async () => {
    const [r] = await provider().search('INBOX', {}, 10);
    expect(r.list_id).toBe('Weekly News <news.example.com>');
    expect(r.list_unsubscribe).toContain('https://example.com/unsubscribe?id=1');
    expect(r.snippet).toBe('Hello from the body.');
  });
});

describe('folded headers', () => {
  it('keeps every continuation line', () => {
    const { listUnsubscribe } = extractListHeadersFromSource(
      'List-Unsubscribe: <mailto:u@example.com>,\r\n <https://example.com/u>\r\nSubject: x\r\n\r\nbody'
    );
    expect(listUnsubscribe).toBe('<mailto:u@example.com>, <https://example.com/u>');
  });

  it('handles a value that starts on the continuation line', () => {
    const { listId } = extractListHeadersFromSource(
      'List-Id:\r\n\tNews <news.example.com>\r\nSubject: x\r\n\r\nbody'
    );
    expect(listId).toBe('News <news.example.com>');
  });

  it('does not take a header-shaped line from the body', () => {
    const { listUnsubscribe } = extractListHeadersFromSource(
      'Subject: x\r\n\r\nList-Unsubscribe: <https://attacker.example/u>\r\n'
    );
    expect(listUnsubscribe).toBeNull();
  });

  it('finds the boundary of a folded Content-Type', () => {
    const snippet = extractSnippet(
      'Content-Type: multipart/alternative;\r\n boundary="b1"\r\n\r\n' +
        '--b1\r\nContent-Type: text/plain\r\n\r\nHello there.\r\n--b1--\r\n'
    );
    expect(snippet).toBe('Hello there.');
  });
});
