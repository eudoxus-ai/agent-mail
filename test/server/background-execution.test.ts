import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { wrapToolHandler } from '../../src/server/middleware.js';
import { openDatabase } from '../../src/ledger/db.js';
import type { Database } from '../../src/ledger/sqlite.js';
import { createLogger } from '../../src/logger.js';
import { holdBySenderTool } from '../../src/tools/hold-by-sender.js';
import { searchThreadsTool } from '../../src/tools/search-threads.js';
import { recordWorkerHeartbeat } from '../../src/ledger/worker-heartbeat.js';
import type { AccountConfig, PolicyConfig } from '../../src/types.js';

/**
 * A bulk sweep is written to the queue and an intent id comes back at once.
 *
 * A client-side timeout on a synchronous bulk hold says nothing about what
 * happened server-side — the same timeout has meant both "finished, response
 * lost" and "never ran" — and left the caller no intent id to undo with.
 *
 * Until now the id came back but the work ran in this process, so a restart
 * vaporized it while leaving the intent reading `executing` forever. The work
 * now lives in the ledger, and the daemon performs it.
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

describe('enqueueing a bulk sweep', () => {
  it('returns an intent_id without doing the work here', async () => {
    const executor = {
      enqueue: vi.fn().mockResolvedValue({ id: 'intent-123' }),
      executeImmediate: vi.fn(),
      threadHasReplies: vi.fn().mockResolvedValue(false),
    };

    const result = await handlerFor(holdBySenderTool, executor)({
      from: 'news@example.com',
      background: true,
    });

    const payload = parse(result);
    // `queued`, not `executing`: nothing is running it yet, and saying
    // otherwise is what made a stopped daemon look like a slow provider.
    expect(payload.status).toBe('queued');
    expect(payload.intent_id).toBe('intent-123');
    expect(executor.enqueue).toHaveBeenCalledTimes(1);
    expect(executor.executeImmediate).not.toHaveBeenCalled();
  });

  it('tells the caller how to check the outcome and how to undo it', async () => {
    const executor = {
      enqueue: vi.fn().mockResolvedValue({ id: 'intent-abc' }),
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

  it('warns when nothing is running the queue', async () => {
    const executor = {
      enqueue: vi.fn().mockResolvedValue({ id: 'intent-1' }),
      threadHasReplies: vi.fn().mockResolvedValue(false),
    };

    const payload = parse(
      await handlerFor(holdBySenderTool, executor)({
        from: 'news@example.com',
        background: true,
      })
    );

    // The whole point of Phase 4, on the surface that matters most: this
    // response is the moment a user believes their work has been filed.
    expect(payload.daemon_running).toBe(false);
    expect(payload.warning).toContain('install-daemon');
  });

  it('says nothing extra when the daemon is running', async () => {
    recordWorkerHeartbeat(db, { workerId: 'w', pid: 1 });
    const executor = {
      enqueue: vi.fn().mockResolvedValue({ id: 'intent-1' }),
      threadHasReplies: vi.fn().mockResolvedValue(false),
    };

    const payload = parse(
      await handlerFor(holdBySenderTool, executor)({
        from: 'news@example.com',
        background: true,
      })
    );

    expect(payload.daemon_running).toBe(true);
    expect(payload.warning).toBeUndefined();
  });

  it('queues a sender sweep by default', async () => {
    const executor = {
      enqueue: vi.fn().mockResolvedValue({ id: 'intent-default' }),
      executeImmediate: vi.fn(),
      threadHasReplies: vi.fn().mockResolvedValue(false),
    };

    // Parsed params, as the server passes them after inputSchema.parse().
    const params = holdBySenderTool.inputSchema.parse({ from: 'news@example.com' });
    await handlerFor(holdBySenderTool, executor)(params);

    // A sender sweep has no upper bound on size, and relying on the tool
    // description to get background requested did not work in practice.
    expect(executor.enqueue).toHaveBeenCalledTimes(1);
    expect(executor.executeImmediate).not.toHaveBeenCalled();
  });

  it('still runs synchronously when explicitly asked to', async () => {
    const executor = {
      enqueue: vi.fn(),
      executeImmediate: vi.fn().mockResolvedValue({ result: [{ type: 'text', text: '{}' }] }),
      threadHasReplies: vi.fn().mockResolvedValue(false),
    };

    const params = holdBySenderTool.inputSchema.parse({
      from: 'news@example.com',
      background: false,
    });
    await handlerFor(holdBySenderTool, executor)(params);

    expect(executor.executeImmediate).toHaveBeenCalledTimes(1);
    expect(executor.enqueue).not.toHaveBeenCalled();
  });

  it('ignores background on tools that do not support it', async () => {
    const executor = {
      enqueue: vi.fn(),
      executeImmediate: vi.fn().mockResolvedValue({ result: [{ type: 'text', text: '{}' }] }),
      threadHasReplies: vi.fn().mockResolvedValue(false),
    };

    // search_threads is bounded and cheap; silently queueing it would change
    // its contract for no benefit.
    await handlerFor(searchThreadsTool as never, executor)({ query: 'x', background: true });

    expect(executor.executeImmediate).toHaveBeenCalledTimes(1);
    expect(executor.enqueue).not.toHaveBeenCalled();
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

describe('runaway bound', () => {
  /**
   * The old cap existed because queued background work was not durable: it was
   * a promise chain in process memory, so a restart vaporized it while leaving
   * every intent marked `executing` forever. Bounding the depth bounded the
   * loss. Queued work is now on disk and survives a restart, so that reason is
   * gone and the cap with it — fifty holds can be filed in one go.
   *
   * What remains is a much higher bound whose only job is to stop a runaway
   * loop filling the ledger. Hitting it means a bug, not backpressure.
   */
  it('accepts far more than the old cap allowed', async () => {
    const executor = {
      enqueue: vi.fn().mockImplementation(async () => ({ id: 'intent-x' })),
      threadHasReplies: vi.fn().mockResolvedValue(false),
    };
    const handler = handlerFor(holdBySenderTool, executor);

    for (let i = 0; i < 50; i++) {
      const payload = parse(
        await handler(holdBySenderTool.inputSchema.parse({ from: `s${i}@example.com` }))
      );
      expect(payload.status, `job ${i}`).toBe('queued');
    }
    expect(executor.enqueue).toHaveBeenCalledTimes(50);
  });

  it('surfaces the runaway bound as a refusal that left nothing behind', async () => {
    const { QueueOverflowError } = await import('../../src/executor/executor.js');
    const executor = {
      enqueue: vi.fn().mockRejectedValue(new QueueOverflowError(1000, 1000)),
      threadHasReplies: vi.fn().mockResolvedValue(false),
    };

    const refused = parse(
      await handlerFor(holdBySenderTool, executor)(
        holdBySenderTool.inputSchema.parse({ from: 'news@example.com' })
      )
    );

    expect(refused.status).toBe('queue_overflow');
    // A refusal must leave nothing to reconcile or undo.
    expect(refused.nothing_happened).toBe(true);
    expect(refused.intent_id).toBeUndefined();
    expect(refused.what_to_do).toContain('get_diagnostics');
  });
});
