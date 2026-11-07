import { describe, it, expect, vi } from 'vitest';
import { ImapProvider } from '../../src/provider/imap.js';

function makeProvider() {
  return new ImapProvider({
    id: 'a@x.com',
    email: 'a@x.com',
    imap: { host: 'h', port: 993, tls: true },
    smtp: { host: 'h', port: 465, tls: true },
    auth: { user: 'u', pass: 'p' },
  });
}

describe('ImapProvider.mailboxExists', () => {
  it('returns true when the path is in the list result', async () => {
    const provider = makeProvider();
    (provider as any).client = {
      async list() {
        return [{ path: 'agent-mail-quarantine' }, { path: 'INBOX' }];
      },
    };
    expect(await provider.mailboxExists('agent-mail-quarantine')).toBe(true);
  });

  it('returns false when the path is not in the list result', async () => {
    const provider = makeProvider();
    (provider as any).client = {
      async list() {
        return [{ path: 'INBOX' }];
      },
    };
    expect(await provider.mailboxExists('agent-mail-quarantine')).toBe(false);
  });
});

describe('ImapProvider.renameMailbox', () => {
  it('calls client.mailboxRename with from/to', async () => {
    const provider = makeProvider();
    const mailboxRename = vi.fn().mockResolvedValue(undefined);
    (provider as any).client = { mailboxRename };
    await provider.renameMailbox('old-name', 'new-name');
    expect(mailboxRename).toHaveBeenCalledWith('old-name', 'new-name');
  });
});

describe('ImapProvider.listMessageUids', () => {
  it('returns all UIDs from the mailbox', async () => {
    const provider = makeProvider();
    const lock = { release: vi.fn() };
    const search = vi.fn().mockResolvedValue([1, 2, 3]);
    (provider as any).client = {
      async getMailboxLock() { return lock; },
      search,
    };
    const uids = await provider.listMessageUids('some-mailbox');
    expect(uids).toEqual([1, 2, 3]);
    expect(lock.release).toHaveBeenCalled();
  });

  it('throws when the search fails, so a folder is never read as empty', async () => {
    const provider = makeProvider();
    const lock = { release: vi.fn() };
    (provider as any).client = {
      async getMailboxLock() { return lock; },
      async search() { return false; },
    };
    await expect(provider.listMessageUids('some-mailbox')).rejects.toThrow(
      'Could not list messages in some-mailbox'
    );
    expect(lock.release).toHaveBeenCalled();
  });
});

describe('ImapProvider.deleteMailbox', () => {
  it('calls client.mailboxDelete with the name', async () => {
    const provider = makeProvider();
    const mailboxDelete = vi.fn().mockResolvedValue(undefined);
    (provider as any).client = { mailboxDelete };
    await provider.deleteMailbox('agent-mail-quarantine');
    expect(mailboxDelete).toHaveBeenCalledWith('agent-mail-quarantine');
  });
});

describe('ImapProvider.fetchSnippet', () => {
  it('calls download and pipes result through extractSnippetFromPart', async () => {
    const provider = makeProvider();
    const lock = { release: vi.fn() };

    // Simulate a Node.js Readable stream containing plain text
    const { Readable } = await import('stream');
    const contentStream = Readable.from(['Hello world, this is the snippet content.']);

    (provider as any).client = {
      async getMailboxLock() { return lock; },
      async fetchOne(_uid: string, _query: object, _opts: object) {
        return {
          uid: 1,
          bodyStructure: {
            type: 'text/plain',
            part: '1',
            childNodes: undefined,
          },
        };
      },
      async download(_uid: string, _part: string, _opts: object) {
        return {
          meta: { contentType: 'text/plain', charset: 'utf-8' },
          content: contentStream,
        };
      },
    };

    const snippet = await provider.fetchSnippet('INBOX', 1);
    expect(snippet).toBe('Hello world, this is the snippet content.');
    expect(lock.release).toHaveBeenCalled();
  });

  it('returns empty string when fetchOne returns null', async () => {
    const provider = makeProvider();
    const lock = { release: vi.fn() };
    (provider as any).client = {
      async getMailboxLock() { return lock; },
      async fetchOne() { return null; },
    };
    const snippet = await provider.fetchSnippet('INBOX', 99);
    expect(snippet).toBe('');
    expect(lock.release).toHaveBeenCalled();
  });

  it('strips HTML tags when downloading a text/html part', async () => {
    const provider = makeProvider();
    const lock = { release: vi.fn() };
    const { Readable } = await import('stream');
    const contentStream = Readable.from(['<p>Hello <b>world</b></p>']);
    (provider as any).client = {
      async getMailboxLock() { return lock; },
      async fetchOne() {
        return {
          uid: 2,
          bodyStructure: { type: 'text/html', part: '1', childNodes: undefined },
        };
      },
      async download() {
        return { meta: { contentType: 'text/html' }, content: contentStream };
      },
    };
    const snippet = await provider.fetchSnippet('INBOX', 2);
    expect(snippet).toBe('Hello world');
  });
});

describe('ImapProvider.fetchEnvelopes (slim fields)', () => {
  it('returns uid, subject, and from.address for each UID', async () => {
    const provider = makeProvider();
    const lock = { release: vi.fn() };
    const fakeMessages = [
      {
        uid: 42,
        envelope: {
          subject: 'Hello world',
          from: [{ address: 'sender@example.com', name: 'Sender' }],
          to: [],
          cc: [],
          messageId: '<abc@example.com>',
          date: new Date('2024-01-01T00:00:00Z'),
        },
        flags: new Set<string>(),
        source: Buffer.from(''),
      },
    ];
    async function* fakeAsyncIter() { yield* fakeMessages; }
    (provider as any).client = {
      async getMailboxLock() { return lock; },
      fetch: () => fakeAsyncIter(),
    };
    const results = await provider.fetchEnvelopes('INBOX', [42]);
    expect(results).toHaveLength(1);
    expect(results[0].uid).toBe(42);
    expect(results[0].subject).toBe('Hello world');
    // from is a Participant object; the address field should be normalised to lower-case
    expect(results[0].from.address).toBe('sender@example.com');
    expect(lock.release).toHaveBeenCalled();
  });
});

describe('ImapProvider.moveMessages', () => {
  function withMove(result: unknown) {
    const provider = makeProvider();
    (provider as any).client = {
      capabilities: new Map([['MOVE', true]]),
      getMailboxLock: async () => ({ release: vi.fn() }),
      messageMove: async () => result,
    };
    return provider;
  }

  /** A server without MOVE, which is what iCloud reports. */
  function withoutMove(copied: unknown, deleted: unknown = true) {
    const provider = makeProvider();
    const messageCopy = vi.fn(async () => copied);
    const messageDelete = vi.fn(async () => deleted);
    const messageMove = vi.fn();
    (provider as any).client = {
      capabilities: new Map(),
      getMailboxLock: async () => ({ release: vi.fn() }),
      messageCopy,
      messageDelete,
      messageMove,
    };
    return { provider, messageCopy, messageDelete, messageMove };
  }

  it('throws when the server refuses the move', async () => {
    await expect(withMove(false).moveMessages([1], 'INBOX', 'Held')).rejects.toThrow(
      'Could not move 1 message(s) from INBOX to Held'
    );
  });

  it('returns the mapping the server gave', async () => {
    const uidMap = new Map([[1, 77]]);
    await expect(withMove({ uidMap }).moveMessages([1], 'INBOX', 'Held')).resolves.toEqual({ uidMap });
  });

  it('does not delete the source when a copy is refused', async () => {
    const { provider, messageDelete } = withoutMove(false);
    await expect(provider.moveMessages([1, 2], 'INBOX', 'Held')).rejects.toThrow(
      'Could not move 2 message(s) from INBOX to Held'
    );
    expect(messageDelete).not.toHaveBeenCalled();
  });

  it('never uses the library move, whose fallback deletes regardless', async () => {
    const { provider, messageMove } = withoutMove({ uidMap: new Map([[1, 77]]) });
    await provider.moveMessages([1], 'INBOX', 'Held');
    expect(messageMove).not.toHaveBeenCalled();
  });

  it('deletes after a good copy and returns the mapping', async () => {
    const uidMap = new Map([[1, 77], [2, 78]]);
    const { provider, messageDelete } = withoutMove({ uidMap });
    await expect(provider.moveMessages([1, 2], 'INBOX', 'Held')).resolves.toEqual({ uidMap });
    expect(messageDelete).toHaveBeenCalledWith('1,2', { uid: true });
  });

  it('deletes only what the server says it copied', async () => {
    const { provider, messageDelete } = withoutMove({ uidMap: new Map([[2, 78]]) });
    await provider.moveMessages([1, 2], 'INBOX', 'Held');
    expect(messageDelete).toHaveBeenCalledWith('2', { uid: true });
  });

  it('deletes nothing when the server copied nothing', async () => {
    const { provider, messageDelete } = withoutMove({ uidMap: new Map() });
    await provider.moveMessages([1], 'INBOX', 'Held');
    expect(messageDelete).not.toHaveBeenCalled();
  });

  it('copes with a server that gives no mapping for a good copy', async () => {
    const { provider, messageDelete } = withoutMove({ path: 'INBOX' });
    const { uidMap } = await provider.moveMessages([1, 2], 'INBOX', 'Held');
    expect(uidMap.size).toBe(0);
    expect(messageDelete).toHaveBeenCalledWith('1,2', { uid: true });
  });

  it('says so when the copy landed but the source could not be removed', async () => {
    const { provider } = withoutMove({ uidMap: new Map([[1, 77]]) }, false);
    await expect(provider.moveMessages([1], 'INBOX', 'Held')).rejects.toThrow(
      'now in both INBOX and Held'
    );
  });

  it('leaves the mapping empty when the server gave none', async () => {
    const { uidMap } = await withMove({ path: 'INBOX' }).moveMessages([1], 'INBOX', 'Held');
    expect(uidMap.size).toBe(0);
  });
});

