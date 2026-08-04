import { describe, it, expect } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import { createLogger } from '../../src/logger.js';
import { QueueWorker } from '../../src/daemon/worker.js';

/**
 * A lease shorter than the longest an operation can take means a legitimately
 * slow sweep gets reclaimed and re-run underneath its own worker: two
 * processes mutating the same mailbox, with nothing in the logs saying so.
 *
 * There is no safe default for that, so it fails at startup instead.
 */

const logger = createLogger('cli', { minLevel: 'error' });

function makeWorker(leaseMs: number, operationTimeoutMs: number) {
  return new QueueWorker({
    db: openDatabase(':memory:'),
    executor: {} as never,
    logger,
    leaseMs,
    operationTimeoutMs,
  });
}

describe('QueueWorker lease validation', () => {
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
