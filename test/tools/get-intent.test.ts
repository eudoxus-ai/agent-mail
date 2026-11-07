import { describe, it, expect, vi } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { insertIntentTargets } from '../../src/ledger/intent-targets.js';
import { linkReversal } from '../../src/ledger/intents.js';
import { createLogger } from '../../src/logger.js';
import type { AccountConfig } from '../../src/types.js';

const logger = createLogger('cli', { minLevel: 'error' });
const accounts: AccountConfig[] = [
  { id: 'a@x.com', email: 'a@x.com', imap: { host: 'h', port: 993, tls: true }, smtp: { host: 'h', port: 465, tls: true } },
];

describe('get_intent', () => {
  it('returns full intent record including targets and reversal links', async () => {
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO intents (id, account_id, tool, params, risk, status)
                VALUES ('hold-1', 'a@x.com', 'hold_messages', '{}', 'medium', 'executed')`).run();
    db.prepare(`INSERT INTO intents (id, account_id, tool, params, risk, status)
                VALUES ('restore-1', 'a@x.com', 'restore_messages', '{}', 'low', 'executed')`).run();
    insertIntentTargets(db, 'hold-1', [
      { account_id: 'a@x.com', uid: 10, mailbox: 'agent-mail-holding',
        envelope_snapshot: { subject: 'Test', from: 'b@y.com', original_mailbox: 'INBOX' } },
    ]);
    linkReversal(db, { restoreIntentId: 'restore-1', reverses: ['hold-1'] });

    const pool = { withConnection: vi.fn() };
    const executor = new Executor({ db, accounts, pool: pool as any, logger });
    const { result } = await executor.executeImmediate({
      tool: 'get_intent',
      toolParams: { intent_id: 'hold-1' },
      accountId: 'a@x.com', agentId: 'test', risk: 'none',
    });
    const payload = JSON.parse(result[0].text);
    expect(payload.id).toBe('hold-1');
    expect(payload.type).toBe('hold_messages');
    expect(payload.targets).toEqual([
      { uid: 10, account_id: 'a@x.com', mailbox: 'agent-mail-holding', subject: 'Test', from: 'b@y.com' },
    ]);
    expect(payload.reversed_by_intent_id).toBe('restore-1');
  });

  it('says why a queued action failed', async () => {
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO intents (id, account_id, tool, params, risk, status, error_detail)
                VALUES ('hold-1', 'a@x.com', 'hold_by_sender', '{}', 'medium', 'failed', ?)`)
      .run(JSON.stringify({ error: 'replies_present', matched_count: 3 }));
    const pool = { withConnection: vi.fn() };
    const executor = new Executor({ db, accounts, pool: pool as any, logger });
    const { result } = await executor.executeImmediate({
      tool: 'get_intent',
      toolParams: { intent_id: 'hold-1' },
      accountId: 'a@x.com', agentId: 'test', risk: 'none',
    });
    expect(JSON.parse(result[0].text).error_detail).toEqual({
      error: 'replies_present',
      matched_count: 3,
    });
  });

  it('leaves error_detail out when nothing went wrong', async () => {
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO intents (id, account_id, tool, params, risk, status)
                VALUES ('hold-1', 'a@x.com', 'hold_messages', '{}', 'medium', 'executed')`).run();
    const pool = { withConnection: vi.fn() };
    const executor = new Executor({ db, accounts, pool: pool as any, logger });
    const { result } = await executor.executeImmediate({
      tool: 'get_intent',
      toolParams: { intent_id: 'hold-1' },
      accountId: 'a@x.com', agentId: 'test', risk: 'none',
    });
    expect(JSON.parse(result[0].text)).not.toHaveProperty('error_detail');
  });

  it('reports unknown intent_id', async () => {
    const db = openDatabase(':memory:');
    const pool = { withConnection: vi.fn() };
    const executor = new Executor({ db, accounts, pool: pool as any, logger });
    const { result } = await executor.executeImmediate({
      tool: 'get_intent',
      toolParams: { intent_id: 'nope' },
      accountId: 'a@x.com', agentId: 'test', risk: 'none',
    });
    expect(JSON.parse(result[0].text)).toEqual({ error: 'intent not found', intent_id: 'nope' });
  });

  it('returns reverses_intent_id when called on a restore intent', async () => {
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO intents (id, account_id, tool, params, risk, status)
                VALUES ('hold-1', 'a@x.com', 'hold_messages', '{}', 'medium', 'executed')`).run();
    db.prepare(`INSERT INTO intents (id, account_id, tool, params, risk, status)
                VALUES ('restore-1', 'a@x.com', 'restore_messages', '{}', 'low', 'executed')`).run();
    linkReversal(db, { restoreIntentId: 'restore-1', reverses: ['hold-1'] });
    const pool = { withConnection: vi.fn() };
    const executor = new Executor({ db, accounts, pool: pool as any, logger });
    const { result } = await executor.executeImmediate({
      tool: 'get_intent',
      toolParams: { intent_id: 'restore-1' },
      accountId: 'a@x.com', agentId: 'test', risk: 'none',
    });
    const payload = JSON.parse(result[0].text);
    expect(payload.reverses_intent_id).toEqual(['hold-1']);
  });
});
