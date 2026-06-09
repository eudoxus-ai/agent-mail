import { describe, it, expect, vi } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import { getScanJob } from '../../src/ledger/scan-jobs.js';
import { createLogger } from '../../src/logger.js';
import { ScanJobRunner, withTimeout } from '../../src/executor/scan-jobs-runner.js';

const logger = createLogger('cli', { minLevel: 'error' });

/** Resolve a deferred promise externally so we can control settle timing. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ScanJobRunner', () => {
  it('start() inserts a running row and returns a handle immediately', () => {
    const db = openDatabase(':memory:');
    const runner = new ScanJobRunner({ db, logger });
    const d = deferred<unknown>();

    const handle = runner.start('get_overview', { x: 1 }, 'agent-1', () => d.promise);

    expect(handle.status).toBe('running');
    expect(typeof handle.job_id).toBe('string');

    const job = getScanJob(db, handle.job_id)!;
    expect(job.status).toBe('running');
    expect(job.tool).toBe('get_overview');
    expect(job.agent_id).toBe('agent-1');
  });

  it('writes done + result when the work resolves', async () => {
    const db = openDatabase(':memory:');
    const runner = new ScanJobRunner({ db, logger });

    const handle = runner.start('list_senders', {}, null, async () => ({ senders: [] }));

    // Let the microtask chain settle the row.
    await new Promise((r) => setImmediate(r));

    const job = getScanJob(db, handle.job_id)!;
    expect(job.status).toBe('done');
    expect(job.result).toEqual({ senders: [] });
  });

  it('writes failed + error when the work rejects, and never rejects to the caller', async () => {
    const db = openDatabase(':memory:');
    const runner = new ScanJobRunner({ db, logger });

    // start() returns synchronously and must not throw even though work rejects.
    const handle = runner.start('search_threads', {}, null, async () => {
      throw new Error('scan exploded');
    });
    expect(handle.status).toBe('running');

    await new Promise((r) => setImmediate(r));

    const job = getScanJob(db, handle.job_id)!;
    expect(job.status).toBe('failed');
    expect(job.error_detail).toMatchObject({ message: 'scan exploded' });
  });

  it('never produces an unhandled rejection when a settle-write throws', async () => {
    // A DB whose write (prepare().run()) throws simulates completeScanJob /
    // failScanJob blowing up inside the detached settle chain. start() must
    // still return synchronously and the rejection must never escape.
    const real = openDatabase(':memory:');
    let writes = 0;
    const throwingDb: any = {
      prepare: (sql: string) => {
        const stmt = real.prepare(sql);
        return {
          run: (...args: unknown[]) => {
            // Let the initial INSERT (createScanJob) succeed; make the
            // settle UPDATE throw.
            if (/UPDATE scan_jobs/i.test(sql)) {
              writes++;
              throw new Error('disk full');
            }
            return (stmt as any).run(...args);
          },
          get: (...args: unknown[]) => (stmt as any).get(...args),
        };
      },
    };

    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const runner = new ScanJobRunner({ db: throwingDb, logger });

      // Work resolves → completeScanJob path throws.
      const okHandle = runner.start('get_overview', {}, null, async () => ({ ok: true }));
      expect(okHandle.status).toBe('running');

      // Work rejects → failScanJob path throws.
      const failHandle = runner.start('list_senders', {}, null, async () => {
        throw new Error('scan exploded');
      });
      expect(failHandle.status).toBe('running');

      // Let the detached chains settle, plus a macrotask for any late rejection.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 0));

      expect(writes).toBeGreaterThanOrEqual(2);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('poll reports running before the work settles', async () => {
    const db = openDatabase(':memory:');
    const runner = new ScanJobRunner({ db, logger });
    const d = deferred<unknown>();

    const handle = runner.start('get_overview', {}, null, () => d.promise);
    expect(getScanJob(db, handle.job_id)!.status).toBe('running');

    d.resolve({ done: true });
    await new Promise((r) => setImmediate(r));
    expect(getScanJob(db, handle.job_id)!.status).toBe('done');
  });
});

describe('withTimeout', () => {
  it('resolves when work finishes before the timeout', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, 'get_overview');
    expect(result).toBe(42);
  });

  it('rejects fast with an error naming async: true when work exceeds the timeout', async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve('late'), 1000));
    await expect(withTimeout(slow, 20, 'get_overview')).rejects.toThrow(/async: true/);
  });
});
