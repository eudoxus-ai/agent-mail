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

describe('label_thread with targets', () => {
  it('groups targets by account and applies labels per account', async () => {
    const calls: Array<{ accountId: string; uids: number[]; mailbox: string }> = [];
    const pool = {
      withConnection: vi.fn(async (accountId: string, fn: any) => {
        return fn({
          setFlags: async (uids: number[], _labels: string[], mailbox: string) => {
            calls.push({ accountId, uids, mailbox });
          },
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
      tool: 'label_thread',
      toolParams: {
        targets: [
          { account_id: 'a@x.com', uid: 1 },
          { account_id: 'a@x.com', uid: 2 },
          { account_id: 'b@y.com', uid: 5, mailbox: 'Archive' },
        ],
        action: 'add',
        label: 'Important',
      },
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'low',
    });

    expect(calls).toHaveLength(2);
    expect(calls.find((c) => c.accountId === 'a@x.com')?.uids).toEqual([1, 2]);
    expect(calls.find((c) => c.accountId === 'a@x.com')?.mailbox).toBe('INBOX');
    expect(calls.find((c) => c.accountId === 'b@y.com')?.uids).toEqual([5]);
    expect(calls.find((c) => c.accountId === 'b@y.com')?.mailbox).toBe('Archive');

    const payload = JSON.parse(result[0].text);
    expect(payload.accounts_searched.sort()).toEqual(['a@x.com', 'b@y.com']);
    expect(payload.action).toBe('add');
    expect(payload.label).toBe('Important');
  });

  it('rejects targets with unknown account_id', async () => {
    const pool = { withConnection: vi.fn() };
    const executor = new Executor({
      db: openDatabase(':memory:'),
      accounts: makeAccounts(),
      pool: pool as any,
      logger,
    });

    await expect(
      executor.executeImmediate({
        tool: 'label_thread',
        toolParams: {
          targets: [{ account_id: 'unknown@z.com', uid: 1 }],
          action: 'add',
          label: 'Important',
        },
        accountId: 'a@x.com',
        agentId: 'test',
        risk: 'low',
      })
    ).rejects.toThrow(/unknown.*account/i);
  });
});
