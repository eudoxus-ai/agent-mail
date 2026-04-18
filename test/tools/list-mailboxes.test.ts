import { describe, it, expect, vi } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { createLogger } from '../../src/logger.js';

const logger = createLogger('cli', { minLevel: 'error' });

describe('list_mailboxes', () => {
  it('returns mailboxes per account with flags and hierarchy', async () => {
    const pool = {
      withConnection: vi.fn(async (_id: string, fn: any) =>
        fn({
          listMailboxes: async () => [
            { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', delimiter: '/', flags: [] },
            { path: 'Rules/Household', name: 'Household', specialUse: null, delimiter: '/', flags: [] },
          ],
        })
      ),
    };

    const executor = new Executor({
      db: openDatabase(':memory:'),
      accounts: [{
        id: 'a@x.com', email: 'a@x.com',
        imap: { host: 'h', port: 993, tls: true },
        smtp: { host: 'h', port: 465, tls: true },
      }],
      pool: pool as any,
      logger,
    });

    const { result } = await executor.executeImmediate({
      tool: 'list_mailboxes',
      toolParams: {},
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'none',
    });

    const payload = JSON.parse(result[0].text);
    expect(payload.accounts_searched).toEqual(['a@x.com']);
    expect(payload.per_account['a@x.com'].mailboxes).toHaveLength(2);
    expect(payload.per_account['a@x.com'].mailboxes[0].path).toBe('INBOX');
    expect(payload.per_account['a@x.com'].mailboxes[1].path).toBe('Rules/Household');
  });
});
