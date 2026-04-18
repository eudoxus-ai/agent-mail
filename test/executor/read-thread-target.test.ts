import { describe, it, expect, vi } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { createLogger } from '../../src/logger.js';
import type { AccountConfig } from '../../src/types.js';

const logger = createLogger('cli', { minLevel: 'error' });

function makeAccounts(): AccountConfig[] {
  return [
    {
      id: 'a@x.com',
      email: 'a@x.com',
      imap: { host: 'h', port: 993, tls: true },
      smtp: { host: 'h', port: 465, tls: true },
    },
    {
      id: 'b@y.com',
      email: 'b@y.com',
      imap: { host: 'h', port: 993, tls: true },
      smtp: { host: 'h', port: 465, tls: true },
    },
  ];
}

describe('read_thread with target', () => {
  it('reads from the account specified in target.account_id, not intent.account_id', async () => {
    const fetchedFrom: string[] = [];
    const pool = {
      withConnection: vi.fn(async (id: string, fn: any) => {
        fetchedFrom.push(id);
        return fn({
          fetchMessage: async () => ({ uid: 99, subject: `from ${id}` }),
        });
      }),
    };

    const executor = new Executor({
      db: openDatabase(':memory:'),
      accounts: makeAccounts(),
      pool: pool as any,
      logger,
    });

    const { result } = await executor.executeImmediate({
      tool: 'read_thread',
      toolParams: { target: { account_id: 'b@y.com', uid: 99 } },
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'none',
    });

    expect(fetchedFrom).toEqual(['b@y.com']);
    expect(JSON.parse(result[0].text)).toMatchObject({ uid: 99, subject: 'from b@y.com' });
  });

  it('rejects target with unknown account_id', async () => {
    const pool = { withConnection: vi.fn() };
    const executor = new Executor({
      db: openDatabase(':memory:'),
      accounts: [
        {
          id: 'a@x.com',
          email: 'a@x.com',
          imap: { host: 'h', port: 993, tls: true },
          smtp: { host: 'h', port: 465, tls: true },
        },
      ],
      pool: pool as any,
      logger,
    });

    await expect(
      executor.executeImmediate({
        tool: 'read_thread',
        toolParams: { target: { account_id: 'unknown@z.com', uid: 1 } },
        accountId: 'a@x.com',
        agentId: 'test',
        risk: 'none',
      })
    ).rejects.toThrow(/unknown.*account/i);
  });
});
