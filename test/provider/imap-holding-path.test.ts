import { describe, it, expect } from 'vitest';
import { ImapProvider } from '../../src/provider/imap.js';

function fakeClient() {
  return {
    async getMailboxLock() {
      return { release() {} };
    },
    async mailboxCreate(_name: string) {
      // no-op — mailbox "created" successfully
    },
    async list() {
      return [];
    },
  };
}

describe('ImapProvider.getMailboxPath holding', () => {
  it('returns agent-mail-holding for "holding"', async () => {
    const provider = new ImapProvider({
      id: 'a@x.com',
      email: 'a@x.com',
      imap: { host: 'h', port: 993, tls: true },
      smtp: { host: 'h', port: 465, tls: true },
      auth: { user: 'u', pass: 'p' },
    });
    (provider as any).client = fakeClient();

    const path = await provider.getMailboxPath('holding');
    expect(path).toBe('agent-mail-holding');
  });
});
