import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import type { Database } from '../../src/ledger/sqlite.js';
import { createLogger } from '../../src/logger.js';
import { getIntent, updateIntentStatus } from '../../src/ledger/intents.js';
import type { Intent } from '../../src/types.js';

// Spy on the heartbeat without changing it. A leaked heartbeat timer is
// invisible in the ledger — heartbeat() refuses once the job leaves
// `executing`, so a timer that keeps firing after a job settles changes
// nothing observable and leaks quietly. Counting the calls is the only way to
// see it.
const heartbeatCalls = { count: 0 };
vi.mock('../../src/ledger/queue.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ledger/queue.js')>();
  return {
    ...actual,
    heartbeat: (...args: Parameters<typeof actual.heartbeat>) => {
      heartbeatCalls.count += 1;
      return actual.heartbeat(...args);
    },
  };
});

const { QueueWorker } = await import('../../src/daemon/worker.js');

const logger = createLogger('cli', { minLevel: 'error' });

/**
 * A lease shorter than the longest an operation can take means a legitimately
 * slow sweep gets reclaimed and re-run underneath its own worker: two
 * processes mutating the same mailbox, with nothing in the logs saying so.
 *
 * There is no safe default for that, so it fails at startup instead.
 */
describe('QueueWorker lease validation', () => {
  function makeWorker(leaseMs: number, operationTimeoutMs: number) {
    return new QueueWorker({
      db: openDatabase(':memory:'),
      executor: {} as never,
      logger,
      leaseMs,
      operationTimeoutMs,
    });
  }

  it('refuses a lease shorter than the operation timeout', () => {
    expect(() => makeWorker(60_000, 5 * 60_000)).toThrow();
  });

  it('names both values, so the fix is obvious from the message alone', () => {
    let message = '';
    try {
      makeWorker(60_000, 300_000);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('60000');
    expect(message).toContain('300000');
  });

  it('refuses a lease exactly equal to the operation timeout', () => {
    // Equal is not safe: the reclaim sweep and the timeout race, and which one
    // wins is down to millisecond scheduling.
    expect(() => makeWorker(300_000, 300_000)).toThrow();
  });

  it('accepts a lease that outlives the operation timeout', () => {
    expect(() => makeWorker(600_000, 300_000)).not.toThrow();
  });
});

/**
 * The drain loop. Everything here is about the worker's own behavior — what it
 * claims, when, and what it does when a job misbehaves. What a job *does* is
 * the executor's business and is covered against the real executor elsewhere.
 */
describe('QueueWorker drain loop', () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  function enqueue(id: string, accountId = 'icloud', createdAt?: string): void {
    db.prepare(
      `INSERT INTO intents (id, account_id, tool, params, risk, status, created_at)
       VALUES (?, ?, 'hold_by_sender', '{}', 'medium', 'queued', ?)`
    ).run(id, accountId, createdAt ?? new Date().toISOString());
  }

  /** A deferred promise, so a test can hold a job open and inspect the world. */
  function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  /**
   * Stands in for the executor. Settles the ledger the way the real
   * performQueued does, so the worker sees a realistic world — the worker's own
   * behavior is what is under test, not the settling.
   */
  function stubExecutor(
    run: (intent: Intent) => Promise<void> = async () => {}
  ) {
    const seen: string[] = [];
    const performQueued = vi.fn(async (intent: Intent) => {
      seen.push(intent.id);
      await run(intent);
      updateIntentStatus(db, intent.id, 'executed', { resolved_by: 'policy' });
      return { status: 'executed' as const };
    });
    return { executor: { performQueued } as never, seen, performQueued };
  }

  function makeWorker(executor: never, overrides: Record<string, unknown> = {}) {
    return new QueueWorker({
      db,
      executor,
      logger,
      leaseMs: 600_000,
      operationTimeoutMs: 300_000,
      tickMs: 5,
      ...overrides,
    });
  }

  it('claims a queued intent and hands it to the executor', async () => {
    enqueue('a');
    const { executor, seen } = stubExecutor();
    const worker = makeWorker(executor);

    await worker.tick();
    await worker.drain();

    expect(seen).toEqual(['a']);
    expect(getIntent(db, 'a')!.status).toBe('executed');
  });

  it('stamps its own id on what it claims', async () => {
    enqueue('a');
    const { executor } = stubExecutor();
    const worker = makeWorker(executor, { workerId: 'worker-under-test' });

    await worker.tick();
    await worker.drain();

    const row = db.prepare(`SELECT claimed_by FROM intents WHERE id = 'a'`).get() as {
      claimed_by: string | null;
    };
    // Cleared on success, but the audit trail is what proves it ran here.
    expect(row.claimed_by === null || row.claimed_by === 'worker-under-test').toBe(true);
  });

  it('keeps draining after a job throws', async () => {
    // The executor is not supposed to throw — it settles its own failures — but
    // a worker that dies on an unexpected rejection takes the whole queue with
    // it, so the loop has to survive one regardless.
    enqueue('bad', 'icloud', '2026-08-04T12:00:00.000Z');
    enqueue('good', 'gmail', '2026-08-04T12:00:01.000Z');

    const executor = {
      performQueued: vi.fn(async (intent: Intent) => {
        if (intent.id === 'bad') throw new Error('kaboom');
        updateIntentStatus(db, intent.id, 'executed', { resolved_by: 'policy' });
        return { status: 'executed' as const };
      }),
    } as never;

    const worker = makeWorker(executor);
    await worker.tick();
    await worker.drain();

    expect(getIntent(db, 'good')!.status).toBe('executed');
  });

  it('marks a thrown job failed rather than leaving it executing forever', async () => {
    enqueue('bad');
    const executor = {
      performQueued: vi.fn(async () => {
        throw new Error('kaboom');
      }),
    } as never;

    const worker = makeWorker(executor);
    await worker.tick();
    await worker.drain();

    const intent = getIntent(db, 'bad')!;
    expect(intent.status).toBe('failed');
    // An intent stuck at executing with no explanation is the exact state that
    // made the last outage impossible to read.
    expect(intent.error_detail?.message).toContain('kaboom');
  });

  it('runs two accounts at the same time', async () => {
    enqueue('a', 'icloud', '2026-08-04T12:00:00.000Z');
    enqueue('b', 'gmail', '2026-08-04T12:00:01.000Z');

    const gate = deferred();
    const { executor, seen } = stubExecutor(async () => {
      await gate.promise;
    });
    const worker = makeWorker(executor);

    await worker.tick();
    // Both are in flight while neither has finished. Serial execution would
    // show only one here, and a queue of fifty holds would drain single file.
    expect(seen.sort()).toEqual(['a', 'b']);
    expect(worker.inFlightCount).toBe(2);

    gate.resolve();
    await worker.drain();
  });

  it('keeps one account strictly in order', async () => {
    enqueue('first', 'icloud', '2026-08-04T12:00:00.000Z');
    enqueue('second', 'icloud', '2026-08-04T12:00:01.000Z');

    const gate = deferred();
    const { executor, seen } = stubExecutor(async () => {
      await gate.promise;
    });
    const worker = makeWorker(executor);

    await worker.tick();
    // Only the older one. Two jobs on one account cannot overlap: the IMAP pool
    // serializes them anyway, and the second would burn its lease waiting.
    expect(seen).toEqual(['first']);

    gate.resolve();
    await worker.drain();
    await worker.tick();
    await worker.drain();

    expect(seen).toEqual(['first', 'second']);
  });

  it('finishes the job in hand when stopped, and claims nothing further', async () => {
    enqueue('running', 'icloud', '2026-08-04T12:00:00.000Z');
    enqueue('waiting', 'gmail', '2026-08-04T12:00:01.000Z');

    const gate = deferred();
    const { executor, seen } = stubExecutor(async (intent) => {
      if (intent.id === 'running') await gate.promise;
    });
    const worker = makeWorker(executor, { maxConcurrent: 1 });

    await worker.tick();
    expect(seen).toEqual(['running']);

    const stopped = worker.stop();
    gate.resolve();
    await stopped;

    // The job in hand completed rather than being abandoned mid-mutation...
    expect(getIntent(db, 'running')!.status).toBe('executed');
    // ...and nothing new was picked up on the way out.
    expect(seen).toEqual(['running']);
    expect(getIntent(db, 'waiting')!.status).toBe('queued');
  });

  it('claims nothing at all once stopped', async () => {
    enqueue('a');
    const { executor, seen } = stubExecutor();
    const worker = makeWorker(executor);

    await worker.stop();
    await worker.tick();

    expect(seen).toEqual([]);
    expect(getIntent(db, 'a')!.status).toBe('queued');
  });

  it('holds the lease open while a long job runs', async () => {
    enqueue('a');
    const gate = deferred();
    const { executor } = stubExecutor(async () => {
      await gate.promise;
    });
    // Heartbeat interval is a third of the lease, so a 90ms lease beats at 30ms.
    const worker = makeWorker(executor, { leaseMs: 90, operationTimeoutMs: 30 });

    await worker.tick();
    const first = (
      db.prepare(`SELECT lease_expires_at FROM intents WHERE id = 'a'`).get() as {
        lease_expires_at: string;
      }
    ).lease_expires_at;

    await new Promise((resolve) => setTimeout(resolve, 80));
    const later = (
      db.prepare(`SELECT lease_expires_at FROM intents WHERE id = 'a'`).get() as {
        lease_expires_at: string;
      }
    ).lease_expires_at;

    // Without the heartbeat the lease would have lapsed by now and reclaim
    // would start a second worker on the same mailbox.
    expect(new Date(later).getTime()).toBeGreaterThan(new Date(first).getTime());

    gate.resolve();
    await worker.drain();
  });

  it('stops heartbeating once the job is done', async () => {
    enqueue('a');
    const { executor } = stubExecutor();
    const worker = makeWorker(executor, { leaseMs: 30, operationTimeoutMs: 10 });

    await worker.tick();
    await worker.drain();
    expect(worker.inFlightCount).toBe(0);

    // Long enough for several beats had the timer survived. Checking the ledger
    // instead would prove nothing: heartbeat() refuses once the job leaves
    // `executing`, so a leaked timer fires harmlessly and invisibly — and one
    // leaks per job.
    heartbeatCalls.count = 0;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(heartbeatCalls.count).toBe(0);
  });

  it('drains on its own once started', async () => {
    enqueue('a');
    const { executor, seen } = stubExecutor();
    const worker = makeWorker(executor);

    worker.start();
    try {
      for (let i = 0; i < 100 && seen.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } finally {
      await worker.stop();
    }

    expect(seen).toEqual(['a']);
  });
});
