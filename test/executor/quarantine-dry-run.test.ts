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

describe('quarantine_thread', () => {
  it('dry_run returns blast radius without moving messages', async () => {
    const moveCalls: string[] = [];
    const pool = {
      withConnection: vi.fn(async (accountId: string, fn: any) =>
        fn({
          getMailboxPath: async () => 'agent-mail-quarantine',
          moveMessages: async () => {
            moveCalls.push(accountId);
          },
        })
      ),
    };

    const executor = new Executor({
      db: openDatabase(':memory:'),
      accounts: makeAccounts(),
      pool: pool as any,
      logger,
    });

    const { intent, result } = await executor.executeImmediate({
      tool: 'quarantine_thread',
      toolParams: {
        targets: [
          { account_id: 'a@x.com', uid: 1 },
          { account_id: 'b@y.com', uid: 5 },
        ],
        dry_run: true,
      },
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'medium',
    });

    expect(moveCalls).toEqual([]);
    const payload = JSON.parse(result[0].text);
    expect(payload.dry_run).toBe(true);
    expect(payload.accounts_searched.sort()).toEqual(['a@x.com', 'b@y.com']);
    expect(payload.total_messages).toBeGreaterThanOrEqual(2);
    expect(payload.per_account).toHaveLength(2);

    // Dry-run does not register an undo token.
    expect(intent.undo_token).toBeNull();
    expect(intent.undo_expires_at).toBeNull();
  });

  it('actual run moves messages and returns the same report shape', async () => {
    const moveCalls: Array<{ accountId: string; uids: number[] }> = [];
    const pool = {
      withConnection: vi.fn(async (accountId: string, fn: any) =>
        fn({
          getMailboxPath: async () => 'agent-mail-quarantine',
          moveMessages: async (uids: number[]) => {
            moveCalls.push({ accountId, uids });
          },
        })
      ),
    };

    const executor = new Executor({
      db: openDatabase(':memory:'),
      accounts: makeAccounts(),
      pool: pool as any,
      logger,
    });

    const { intent, result } = await executor.executeImmediate({
      tool: 'quarantine_thread',
      toolParams: {
        targets: [
          { account_id: 'a@x.com', uid: 1 },
          { account_id: 'b@y.com', uid: 5 },
        ],
      },
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'medium',
    });

    expect(moveCalls).toHaveLength(2);
    const payload = JSON.parse(result[0].text);
    expect(payload.dry_run).toBe(false);
    expect(payload.total_messages).toBe(2);
    expect(payload.per_account).toHaveLength(2);

    // Real run registers an undo token.
    expect(intent.undo_token).not.toBeNull();
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
        tool: 'quarantine_thread',
        toolParams: {
          targets: [{ account_id: 'unknown@z.com', uid: 1 }],
        },
        accountId: 'a@x.com',
        agentId: 'test',
        risk: 'medium',
      })
    ).rejects.toThrow(/unknown.*account/i);
    expect(pool.withConnection).not.toHaveBeenCalled();
  });
});
