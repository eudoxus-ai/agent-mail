import { describe, it, expect, vi } from 'vitest';
import { wrapToolHandler } from '../../src/server/middleware.js';
import { queueSendTool } from '../../src/tools/queue-send.js';
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
    queue_send: {
      risk: 'high',
      gate: 'always_gated',
    } as any,
  },
};

function makeExecutor() {
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
  return { executor, db };
}

describe('wrapToolHandler pending response payload', () => {
  it('includes approval_url and human_summary on gated calls', async () => {
    const { executor, db } = makeExecutor();
    const handler = wrapToolHandler(queueSendTool, {
      db,
      executor,
      policy,
      accounts,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      agentId: 'test-agent',
    });

    const result = await handler({
      to: 'friend@example.com',
      subject: 'hello',
      body: 'hi there',
      account_id: 'a@x.com',
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe('pending');
    expect(payload.intent_id).toBeDefined();
    expect(payload.approval_url).toMatch(
      /^http:\/\/127\.0\.0\.1:4242\/intents\/[0-9a-f-]{36}$/
    );
    expect(payload.approval_url).toBe(
      `http://127.0.0.1:4242/intents/${payload.intent_id}`
    );
    expect(typeof payload.human_summary).toBe('string');
    expect(payload.human_summary.length).toBeGreaterThan(0);
    expect(payload.human_summary).toContain('friend@example.com');
  });

  it('honors a custom reviewerPort in approval_url', async () => {
    const { executor, db } = makeExecutor();
    const handler = wrapToolHandler(queueSendTool, {
      db,
      executor,
      policy,
      accounts,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      agentId: 'test-agent',
      reviewerPort: 5555,
    });

    const result = await handler({
      to: 'friend@example.com',
      subject: 'hello',
      body: 'hi there',
      account_id: 'a@x.com',
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.approval_url).toBe(
      `http://127.0.0.1:5555/intents/${payload.intent_id}`
    );
  });
});
