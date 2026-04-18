import { describe, it, expect, beforeEach, vi } from 'vitest';
import { wrapToolHandler } from '../../src/server/middleware.js';
import { holdMessagesTool } from '../../src/tools/hold-messages.js';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import type { AccountConfig, PolicyConfig } from '../../src/types.js';
import { ImapConnectionPool } from '../../src/provider/imap-pool.js';

const accounts: AccountConfig[] = [
  {
    id: 'a@x.com',
    email: 'a@x.com',
    imap: { host: 'h', port: 993, tls: true },
    smtp: { host: 'h', port: 465, tls: true },
  },
];

const policy: PolicyConfig = {
  tools: {
    hold_messages: {
      risk: 'medium',
      gate: 'configurable',
      default: 'ungated',
      override: { when_thread_has_replies: 'approval_required' },
    } as any,
  },
};

function makeExecutor(opts: { threadHasReplies: boolean }) {
  const db = openDatabase(':memory:');
  const pool = new ImapConnectionPool({
    accounts,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
  });
  const executor = new Executor({
    db,
    accounts,
    pool,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
  });
  vi.spyOn(executor, 'threadHasReplies').mockResolvedValue(opts.threadHasReplies);
  return { executor, db };
}

describe('hold_messages policy gating with targets', () => {
  it('inspects thread reply state from targets and gates when replies exist', async () => {
    const { executor, db } = makeExecutor({ threadHasReplies: true });
    const handler = wrapToolHandler(holdMessagesTool, {
      db,
      executor,
      policy,
      accounts,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      agentId: 'test-agent',
    });

    const performSpy = vi.spyOn(executor, 'executeImmediate');

    const result = await handler({
      targets: [{ account_id: 'a@x.com', uid: 1 }],
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe('pending');
    expect(payload.intent_id).toBeDefined();
    expect(performSpy).not.toHaveBeenCalled();
    expect(executor.threadHasReplies).toHaveBeenCalledWith(
      'a@x.com',
      'INBOX',
      [1]
    );
  });

  it('executes immediately when thread has no replies', async () => {
    const { executor, db } = makeExecutor({ threadHasReplies: false });
    const handler = wrapToolHandler(holdMessagesTool, {
      db,
      executor,
      policy,
      accounts,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      agentId: 'test-agent',
    });

    vi.spyOn(executor, 'executeImmediate').mockResolvedValue({
      intent: {} as any,
      result: [{ type: 'text', text: '{}' }],
    });

    const result = await handler({
      targets: [{ account_id: 'a@x.com', uid: 1 }],
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).not.toBe('pending');
    expect(executor.executeImmediate).toHaveBeenCalled();
  });

  it('checks every account/mailbox group when targets span multiple', async () => {
    const { executor, db } = makeExecutor({ threadHasReplies: false });
    const handler = wrapToolHandler(holdMessagesTool, {
      db,
      executor,
      policy,
      accounts: [
        ...accounts,
        {
          id: 'b@y.com',
          email: 'b@y.com',
          imap: { host: 'h', port: 993, tls: true },
          smtp: { host: 'h', port: 465, tls: true },
        },
      ],
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      agentId: 'test-agent',
    });

    vi.spyOn(executor, 'executeImmediate').mockResolvedValue({
      intent: {} as any,
      result: [{ type: 'text', text: '{}' }],
    });

    await handler({
      targets: [
        { account_id: 'a@x.com', uid: 1 },
        { account_id: 'a@x.com', uid: 2, mailbox: 'Archive' },
        { account_id: 'b@y.com', uid: 5 },
      ],
    });

    const calls = (executor.threadHasReplies as any).mock.calls as unknown[][];
    const seen = calls.map((c) => `${c[0]}/${c[1]}`).sort();
    expect(seen).toEqual(['a@x.com/Archive', 'a@x.com/INBOX', 'b@y.com/INBOX']);
  });
});
