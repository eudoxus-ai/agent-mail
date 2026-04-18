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

  it('returns empty array when search returns false', async () => {
    const provider = makeProvider();
    const lock = { release: vi.fn() };
    (provider as any).client = {
      async getMailboxLock() { return lock; },
      async search() { return false; },
    };
    const uids = await provider.listMessageUids('some-mailbox');
    expect(uids).toEqual([]);
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
