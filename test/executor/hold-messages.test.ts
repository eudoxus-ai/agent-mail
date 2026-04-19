import { describe, it, expect, vi } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { createLogger } from '../../src/logger.js';
import type { AccountConfig } from '../../src/types.js';

const logger = createLogger('cli', { minLevel: 'error' });

function makeAccounts(): AccountConfig[] {
  return [
    { id: 'a@x.com', email: 'a@x.com', imap: { host: 'h', port: 993, tls: true }, smtp: { host: 'h', port: 465, tls: true } },
    { id: 'b@y.com', email: 'b@y.com', imap: { host: 'h', port: 993, tls: true }, smtp: { host: 'h', port: 465, tls: true } },
  ];
}

describe('hold_messages', () => {
  it('dry_run returns blast radius without moving', async () => {
    const moveCalls: string[] = [];
    const pool = {
      withConnection: vi.fn(async (accountId: string, fn: any) =>
        fn({
          getMailboxPath: async () => 'agent-mail-holding',
          moveMessages: async (uids: number[]) => { moveCalls.push(accountId); return { uidMap: new Map(uids.map((u) => [u, u])) }; },
          fetchEnvelopes: async () => [],
        })
      ),
    };
    const executor = new Executor({ db: openDatabase(':memory:'), accounts: makeAccounts(), pool: pool as any, logger });
    const { intent, result } = await executor.executeImmediate({
      tool: 'hold_messages',
      toolParams: { targets: [{ account_id: 'a@x.com', uid: 1 }, { account_id: 'b@y.com', uid: 5 }], dry_run: true },
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'medium',
    });
    expect(moveCalls).toEqual([]);
    const payload = JSON.parse(result[0].text);
    expect(payload.dry_run).toBe(true);
    expect(payload.total_messages).toBeGreaterThanOrEqual(2);
    expect(intent.undo_token).toBeNull();
  });

  it('real run moves messages and registers undo', async () => {
    const moveCalls: Array<{ accountId: string; uids: number[] }> = [];
    const pool = {
      withConnection: vi.fn(async (accountId: string, fn: any) =>
        fn({
          getMailboxPath: async () => 'agent-mail-holding',
          moveMessages: async (uids: number[]) => { moveCalls.push({ accountId, uids }); return { uidMap: new Map(uids.map((u) => [u, u])) }; },
          fetchEnvelopes: async () => [],
        })
      ),
    };
    const executor = new Executor({ db: openDatabase(':memory:'), accounts: makeAccounts(), pool: pool as any, logger });
    const { intent, result } = await executor.executeImmediate({
      tool: 'hold_messages',
      toolParams: { targets: [{ account_id: 'a@x.com', uid: 1 }, { account_id: 'b@y.com', uid: 5 }] },
      accountId: 'a@x.com', agentId: 'test', risk: 'medium',
    });
    expect(moveCalls).toHaveLength(2);
    const payload = JSON.parse(result[0].text);
    expect(payload.total_messages).toBe(2);
    expect(intent.undo_token).not.toBeNull();
  });

  it('real run response includes reversible and undo_hint.method=undo_intent', async () => {
    const pool = {
      withConnection: vi.fn(async (_: string, fn: any) =>
        fn({
          getMailboxPath: async () => 'agent-mail-holding',
          moveMessages: async (uids: number[]) => ({ uidMap: new Map(uids.map((u) => [u, u])) }),
          fetchEnvelopes: async () => [],
        })
      ),
    };
    const executor = new Executor({ db: openDatabase(':memory:'), accounts: makeAccounts(), pool: pool as any, logger });
    const { intent, result } = await executor.executeImmediate({
      tool: 'hold_messages',
      toolParams: { targets: [{ account_id: 'a@x.com', uid: 1 }] },
      accountId: 'a@x.com', agentId: 'test', risk: 'medium',
    });
    const payload = JSON.parse(result[0].text);
    expect(payload.reversible).toBe(true);
    expect(payload.undo_hint.method).toBe('undo_intent');
    expect(payload.undo_hint.intent_id).toBe(intent.id);
    expect(typeof payload.undo_hint.window_expires_at).toBe('string');
    expect(payload.to_undo).toMatch(/undo_intent.*intent_id "[^"]+"/);
    expect(payload.to_undo).toContain(intent.id);
    expect(payload.to_undo).toContain(payload.undo_hint.window_expires_at);
  });

  it('dry_run response omits reversible/undo_hint', async () => {
    const pool = {
      withConnection: vi.fn(async (_: string, fn: any) =>
        fn({
          getMailboxPath: async () => 'agent-mail-holding',
          moveMessages: async (uids: number[]) => ({ uidMap: new Map(uids.map((u) => [u, u])) }),
          fetchEnvelopes: async () => [],
        })
      ),
    };
    const executor = new Executor({ db: openDatabase(':memory:'), accounts: makeAccounts(), pool: pool as any, logger });
    const { result } = await executor.executeImmediate({
      tool: 'hold_messages',
      toolParams: { targets: [{ account_id: 'a@x.com', uid: 1 }], dry_run: true },
      accountId: 'a@x.com', agentId: 'test', risk: 'medium',
    });
    const payload = JSON.parse(result[0].text);
    expect(payload.reversible).toBeUndefined();
    expect(payload.undo_hint).toBeUndefined();
    expect(payload.to_undo).toBeUndefined();
  });

  it('rejects unknown account_id in targets', async () => {
    const pool = { withConnection: vi.fn() };
    const executor = new Executor({ db: openDatabase(':memory:'), accounts: makeAccounts(), pool: pool as any, logger });
    await expect(
      executor.executeImmediate({
        tool: 'hold_messages',
        toolParams: { targets: [{ account_id: 'unknown@z.com', uid: 1 }] },
        accountId: 'a@x.com', agentId: 'test', risk: 'medium',
      })
    ).rejects.toThrow(/unknown.*account/i);
  });
});
