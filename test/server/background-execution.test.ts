import { describe, it, expect, beforeEach, vi } from 'vitest';
import { wrapToolHandler } from '../../src/server/middleware.js';
import { openDatabase } from '../../src/ledger/db.js';
import type { Database } from '../../src/ledger/sqlite.js';
import { createLogger } from '../../src/logger.js';
import { holdBySenderTool } from '../../src/tools/hold-by-sender.js';
import { searchThreadsTool } from '../../src/tools/search-threads.js';
import type { AccountConfig, PolicyConfig } from '../../src/types.js';

/**
 * `background: true` returns an intent id before the work starts.
 *
 * A client-side timeout on a synchronous bulk hold says nothing about what
 * happened server-side — the same timeout has meant both "finished, response
 * lost" and "never ran" — and left the caller no intent id to undo with.
 */

let db: Database;

const accounts: AccountConfig[] = [
  {
    id: 'icloud',
    email: 'you@icloud.com',
    imap: { host: 'imap.mail.me.com', port: 993, tls: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, tls: true },
  },
];

const policy: PolicyConfig = {
  tools: {
    hold_by_sender: { risk: 'medium', gate: 'ungated' },
    search_threads: { risk: 'none', gate: 'ungated' },
  },
};

beforeEach(() => {
  db = openDatabase(':memory:');
});

function handlerFor(tool: typeof holdBySenderTool, executor: unknown) {
  return wrapToolHandler(tool, {
    db,
    executor: executor as never,
    policy,
    accounts,
    logger: createLogger('cli', { minLevel: 'error' }),
    agentId: 'test-agent',
  });
}

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('background execution', () => {
  it('returns an intent_id immediately without waiting for the work', async () => {
    const executor = {
      executeInBackground: vi.fn().mockResolvedValue({ id: 'intent-123' }),
      executeImmediate: vi.fn(),
      threadHasReplies: vi.fn().mockResolvedValue(false),
    };

    const result = await handlerFor(holdBySenderTool, executor)({
      from: 'news@example.com',
      background: true,
    });

    const payload = parse(result);
    expect(payload.status).toBe('executing');
    expect(payload.intent_id).toBe('intent-123');
    expect(executor.executeInBackground).toHaveBeenCalledTimes(1);
    expect(executor.executeImmediate).not.toHaveBeenCalled();
  });

  it('tells the caller how to check the outcome and how to undo it', async () => {
    const executor = {
      executeInBackground: vi.fn().mockResolvedValue({ id: 'intent-abc' }),
      threadHasReplies: vi.fn().mockResolvedValue(false),
    };

    const payload = parse(
      await handlerFor(holdBySenderTool, executor)({
        from: 'news@example.com',
        background: true,
      })
    );

    // Recovering from an ambiguous timeout previously required re-running and
    // comparing counts; the id plus these instructions replace that.
    expect(payload.how_to_check).toContain('get_intent');
    expect(payload.how_to_check).toContain('intent-abc');
    expect(payload.how_to_undo).toContain('undo_intent');
  });

  it('backgrounds a sender sweep by default', async () => {
    const executor = {
      executeInBackground: vi.fn().mockResolvedValue({ id: 'intent-default' }),
      executeImmediate: vi.fn(),
      threadHasReplies: vi.fn().mockResolvedValue(false),
    };

    // Parsed params, as the server passes them after inputSchema.parse().
    const params = holdBySenderTool.inputSchema.parse({ from: 'news@example.com' });
    await handlerFor(holdBySenderTool, executor)(params);

    // A sender sweep has no upper bound on size, and relying on the tool
    // description to get background requested did not work in practice.
    expect(executor.executeInBackground).toHaveBeenCalledTimes(1);
    expect(executor.executeImmediate).not.toHaveBeenCalled();
  });

  it('still runs synchronously when explicitly asked to', async () => {
    const executor = {
      executeInBackground: vi.fn(),
      executeImmediate: vi.fn().mockResolvedValue({ result: [{ type: 'text', text: '{}' }] }),
      threadHasReplies: vi.fn().mockResolvedValue(false),
    };

    const params = holdBySenderTool.inputSchema.parse({
      from: 'news@example.com',
      background: false,
    });
    await handlerFor(holdBySenderTool, executor)(params);

    expect(executor.executeImmediate).toHaveBeenCalledTimes(1);
    expect(executor.executeInBackground).not.toHaveBeenCalled();
  });

  it('ignores background on tools that do not support it', async () => {
    const executor = {
      executeInBackground: vi.fn(),
      executeImmediate: vi.fn().mockResolvedValue({ result: [{ type: 'text', text: '{}' }] }),
      threadHasReplies: vi.fn().mockResolvedValue(false),
    };

    // search_threads is bounded and cheap; silently backgrounding it would
    // change its contract for no benefit.
    await handlerFor(searchThreadsTool as never, executor)({ query: 'x', background: true });

    expect(executor.executeImmediate).toHaveBeenCalledTimes(1);
    expect(executor.executeInBackground).not.toHaveBeenCalled();
  });
});

describe('hold tool schemas', () => {
  it('accepts background on hold_by_sender', () => {
    const parsed = holdBySenderTool.inputSchema.parse({
      from: 'news@example.com',
      background: true,
    });
    expect(parsed.background).toBe(true);
  });

  it('defaults background to true when omitted', () => {
    const parsed = holdBySenderTool.inputSchema.parse({ from: 'news@example.com' });
    expect(parsed.background).toBe(true);
  });

  it('honors an explicit false', () => {
    const parsed = holdBySenderTool.inputSchema.parse({
      from: 'news@example.com',
      background: false,
    });
    expect(parsed.background).toBe(false);
  });
});
