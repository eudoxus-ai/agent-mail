import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import { createIntent } from '../../src/ledger/intents.js';
import type { Database } from '../../src/ledger/sqlite.js';
import { IntentWatcher } from '../../src/reviewer/watcher.js';
import { createIntentNotifier, createQueueWorker, createShutdown } from '../../src/reviewer/daemon.js';
import { leaseForTimeout } from '../../src/daemon/worker.js';
import { ImapConnectionPool } from '../../src/provider/imap-pool.js';
import { createLogger } from '../../src/logger.js';

let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:');
});

const PORT = 4242;

function makeNotifier(notify: ReturnType<typeof vi.fn>) {
  return createIntentNotifier({
    logger: createLogger('test'),
    port: PORT,
    notify,
  });
}

describe('daemon notification wiring', () => {
  it('does not notify for low-risk pending intents', async () => {
    const notify = vi.fn();
    const watcher = new IntentWatcher({
      db,
      pollingIntervalMs: 50,
      onNewIntent: makeNotifier(notify),
    });

    createIntent(db, {
      account_id: 'test@gmail.com',
      tool: 'label_thread',
      params: { thread_id: 't1', label: 'done' },
      risk: 'low',
    });

    watcher.start();
    await new Promise((r) => setTimeout(r, 150));
    watcher.stop();

    expect(notify).not.toHaveBeenCalled();
  });

  it('notifies exactly once for high-risk pending intents', async () => {
    const notify = vi.fn();
    const watcher = new IntentWatcher({
      db,
      pollingIntervalMs: 50,
      onNewIntent: makeNotifier(notify),
    });

    const intent = createIntent(db, {
      account_id: 'test@gmail.com',
      tool: 'queue_send',
      params: { to: 'alice@example.com', subject: 'Test' },
      risk: 'high',
    });

    watcher.start();
    await new Promise((r) => setTimeout(r, 200));
    watcher.stop();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].id).toBe(intent.id);
    expect(notify.mock.calls[0][1]).toBe(PORT);
  });

  it('suppresses notifications tagged with __unknown_tool_fallback', async () => {
    const notify = vi.fn();
    const watcher = new IntentWatcher({
      db,
      pollingIntervalMs: 50,
      onNewIntent: makeNotifier(notify),
    });

    createIntent(db, {
      account_id: 'test@gmail.com',
      tool: 'mystery_tool',
      params: { foo: 'bar', __unknown_tool_fallback: true },
      risk: 'high',
    });

    watcher.start();
    await new Promise((r) => setTimeout(r, 150));
    watcher.stop();

    expect(notify).not.toHaveBeenCalled();
  });
});

describe('queue worker wiring', () => {
  const logger = createLogger('test', { minLevel: 'error' });

  function poolWithTimeout(operationTimeoutMs: number) {
    return new ImapConnectionPool({ accounts: [], logger, operationTimeoutMs });
  }

  it('takes its lease from the pool the worker will actually use', () => {
    // Hardcoding a lease is how this guard gets quietly defeated: raise
    // AGENT_MAIL_IMAP_TIMEOUT_MS past the constant and either the daemon
    // refuses to start or, worse, someone lowers the assertion to match.
    const pool = poolWithTimeout(20 * 60_000);
    const worker = createQueueWorker({
      db,
      executor: {} as never,
      pool,
      logger,
    });

    expect(worker.leaseMs).toBeGreaterThan(pool.getOperationTimeoutMs());
  });

  it('produces a usable lease for any timeout, however long', () => {
    // The constructor throws on a short lease, so the derived value has to
    // satisfy it for every configuration — otherwise a legitimate timeout
    // setting stops the daemon from booting at all.
    for (const timeout of [1_000, 5 * 60_000, 60 * 60_000]) {
      expect(leaseForTimeout(timeout)).toBeGreaterThan(timeout);
    }
  });

  it('stops the worker before closing the connections it is using', async () => {
    const order: string[] = [];
    const shutdown = createShutdown({
      logger,
      watcher: { stop: () => order.push('watcher') },
      syncLoop: { stop: () => order.push('sync') },
      worker: {
        // Takes a moment to settle, like a real drain. A stub that records
        // synchronously would look correctly ordered even if shutdown never
        // awaited it — the mutation that skips the await has to fail here.
        stop: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          order.push('worker drained');
        },
      },
      pool: {
        closeAll: async () => {
          order.push('pool');
        },
      },
      exit: (code) => order.push(`exit:${code}`),
    });

    await shutdown(0);

    // The worker finishes the job in hand on stop; closing the pool first
    // would pull the connections out from under it mid-mutation.
    expect(order).toEqual(['watcher', 'sync', 'worker drained', 'pool', 'exit:0']);
  });

  it('still closes the pool and exits when the worker fails to stop', async () => {
    const order: string[] = [];
    const shutdown = createShutdown({
      logger,
      watcher: { stop: () => order.push('watcher') },
      syncLoop: null,
      worker: {
        stop: async () => {
          throw new Error('stuck');
        },
      },
      pool: {
        closeAll: async () => {
          order.push('pool');
        },
      },
      exit: (code) => order.push(`exit:${code}`),
    });

    // A shutdown that hangs on a stuck worker leaves an orphaned process
    // holding the ledger; best-effort is the right posture on the way out.
    await shutdown(0);

    expect(order).toContain('pool');
    expect(order[order.length - 1]).toBe('exit:0');
  });

  it('works with no worker at all', async () => {
    const order: string[] = [];
    const shutdown = createShutdown({
      logger,
      watcher: { stop: () => order.push('watcher') },
      syncLoop: null,
      worker: null,
      pool: { closeAll: async () => order.push('pool') },
      exit: (code) => order.push(`exit:${code}`),
    });

    await shutdown(1);

    expect(order).toEqual(['watcher', 'pool', 'exit:1']);
  });
});
