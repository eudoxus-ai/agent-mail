import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { wrapToolHandler } from '../../src/server/middleware.js';
import { openDatabase } from '../../src/ledger/db.js';
import type { Database } from '../../src/ledger/sqlite.js';
import { createLogger } from '../../src/logger.js';
import { holdBySenderTool } from '../../src/tools/hold-by-sender.js';
import { BackgroundQueueFullError } from '../../src/executor/executor.js';
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
      backgroundLoad: () => ({ in_flight: 1, limit: 8 }),
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
      backgroundLoad: () => ({ in_flight: 1, limit: 8 }),
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
      backgroundLoad: () => ({ in_flight: 1, limit: 8 }),
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

describe('background queue cap', () => {
  /**
   * Queued background work is not durable — the pool queue is a promise chain
   * in process memory and nothing records "waiting to run". A restart
   * vaporizes everything queued while leaving each intent marked `executing`
   * forever. The cap bounds how much can be lost that way.
   *
   * It is not a throughput control: per-account serialization means the queue
   * drains at the same rate however fast it is filled.
   */
  const savedLimit = process.env.AGENT_MAIL_MAX_BACKGROUND;
  afterEach(() => {
    // Restore rather than delete: leaking this into later tests would change
    // the cap out from under them and fail somewhere unrelated.
    if (savedLimit === undefined) delete process.env.AGENT_MAIL_MAX_BACKGROUND;
    else process.env.AGENT_MAIL_MAX_BACKGROUND = savedLimit;
  });

  it('refuses once too much is outstanding, without creating an intent', async () => {
    process.env.AGENT_MAIL_MAX_BACKGROUND = '2';

    let inFlight = 0;
    const executor = {
      backgroundLoad: () => ({ in_flight: inFlight, limit: 2 }),
      executeInBackground: vi.fn().mockImplementation(async () => {
        if (inFlight >= 2) throw new BackgroundQueueFullError(inFlight, 2);
        inFlight += 1;
        return { id: `intent-${inFlight}` };
      }),
      threadHasReplies: vi.fn().mockResolvedValue(false),
    };

    const handler = handlerFor(holdBySenderTool, executor);
    const params = () => holdBySenderTool.inputSchema.parse({ from: 'news@example.com' });

    expect(parse(await handler(params())).status).toBe('executing');
    expect(parse(await handler(params())).status).toBe('executing');

    const refused = parse(await handler(params()));
    expect(refused.status).toBe('queue_full');
    expect(refused.limit).toBe(2);
    // Critical: a refusal must leave nothing behind to reconcile or undo.
    expect(refused.nothing_happened).toBe(true);
    expect(refused.intent_id).toBeUndefined();
  });

  it('tells the caller to poll and retry rather than to queue harder', async () => {
    const executor = {
      backgroundLoad: () => ({ in_flight: 8, limit: 8 }),
      executeInBackground: vi.fn().mockRejectedValue(new BackgroundQueueFullError(8, 8)),
      threadHasReplies: vi.fn().mockResolvedValue(false),
    };

    const refused = parse(
      await handlerFor(holdBySenderTool, executor)(
        holdBySenderTool.inputSchema.parse({ from: 'news@example.com' })
      )
    );

    expect(refused.what_to_do).toContain('get_intent');
    expect(refused.what_to_do).toContain('serialized');
  });

  it('reports queue load on an accepted job so the caller can pace itself', async () => {
    const executor = {
      backgroundLoad: () => ({ in_flight: 3, limit: 8 }),
      executeInBackground: vi.fn().mockResolvedValue({ id: 'intent-x' }),
      threadHasReplies: vi.fn().mockResolvedValue(false),
    };

    const payload = parse(
      await handlerFor(holdBySenderTool, executor)(
        holdBySenderTool.inputSchema.parse({ from: 'news@example.com' })
      )
    );

    expect(payload.queue).toEqual({ in_flight: 3, limit: 8 });
  });
});
