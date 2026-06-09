import { describe, it, expect } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import {
  createScanJob,
  completeScanJob,
  failScanJob,
  getScanJob,
  failStaleRunningJobs,
  pruneScanJobs,
} from '../../src/ledger/scan-jobs.js';

describe('scan_jobs DAO', () => {
  it('creates a running job and reads it back', () => {
    const db = openDatabase(':memory:');
    const job = createScanJob(db, {
      tool: 'get_overview',
      params: { account_ids: ['a@x.com'] },
      agent_id: 'agent-1',
    });
    expect(job.status).toBe('running');
    expect(job.tool).toBe('get_overview');
    expect(job.params).toEqual({ account_ids: ['a@x.com'] });
    expect(job.agent_id).toBe('agent-1');
    expect(job.result).toBeNull();
    expect(job.error_detail).toBeNull();
    expect(job.completed_at).toBeNull();

    const fetched = getScanJob(db, job.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(job.id);
  });

  it('returns null for an unknown job id', () => {
    const db = openDatabase(':memory:');
    expect(getScanJob(db, 'nope')).toBeNull();
  });

  it('completes a running job with a result payload', () => {
    const db = openDatabase(':memory:');
    const job = createScanJob(db, { tool: 'list_senders', params: {} });
    completeScanJob(db, job.id, { senders: [{ from: 'x@y', count: 3 }] });
    const done = getScanJob(db, job.id)!;
    expect(done.status).toBe('done');
    expect(done.result).toEqual({ senders: [{ from: 'x@y', count: 3 }] });
    expect(done.error_detail).toBeNull();
    expect(done.completed_at).not.toBeNull();
  });

  it('fails a running job with an error detail', () => {
    const db = openDatabase(':memory:');
    const job = createScanJob(db, { tool: 'search_threads', params: {} });
    failScanJob(db, job.id, { message: 'boom' });
    const failed = getScanJob(db, job.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.error_detail).toEqual({ message: 'boom' });
    expect(failed.result).toBeNull();
    expect(failed.completed_at).not.toBeNull();
  });

  it('does not overwrite a settled job', () => {
    const db = openDatabase(':memory:');
    const job = createScanJob(db, { tool: 'list_senders', params: {} });
    completeScanJob(db, job.id, { ok: true });
    // A late failure (e.g. race) must not clobber the done result.
    failScanJob(db, job.id, { message: 'late' });
    const final = getScanJob(db, job.id)!;
    expect(final.status).toBe('done');
    expect(final.result).toEqual({ ok: true });
  });

  it('marks orphaned running jobs as failed on cleanup', () => {
    const db = openDatabase(':memory:');
    const running = createScanJob(db, { tool: 'get_overview', params: {} });
    const settled = createScanJob(db, { tool: 'list_senders', params: {} });
    completeScanJob(db, settled.id, { ok: true });

    const reaped = failStaleRunningJobs(db);
    expect(reaped).toBe(1);

    const reapedJob = getScanJob(db, running.id)!;
    expect(reapedJob.status).toBe('failed');
    expect(reapedJob.error_detail).toMatchObject({
      message: 'server restarted while scan was running',
    });

    // The already-done job is untouched.
    expect(getScanJob(db, settled.id)!.status).toBe('done');
  });

  it('prunes only old terminal jobs, never recent or running ones', () => {
    const db = openDatabase(':memory:');

    // An old `done` job (completed 30 days ago) — should be pruned.
    const oldDone = createScanJob(db, { tool: 'get_overview', params: {} });
    completeScanJob(db, oldDone.id, { ok: true });
    db.prepare(
      `UPDATE scan_jobs SET completed_at = datetime('now', '-30 days') WHERE id = ?`
    ).run(oldDone.id);

    // An old `failed` job — should also be pruned.
    const oldFailed = createScanJob(db, { tool: 'search_threads', params: {} });
    failScanJob(db, oldFailed.id, { message: 'boom' });
    db.prepare(
      `UPDATE scan_jobs SET completed_at = datetime('now', '-14 days') WHERE id = ?`
    ).run(oldFailed.id);

    // A recent `done` job — should survive.
    const recentDone = createScanJob(db, { tool: 'list_senders', params: {} });
    completeScanJob(db, recentDone.id, { ok: true });

    // A long-running job with an (artificially) old created time but no
    // completed_at — must NEVER be pruned regardless of age.
    const running = createScanJob(db, { tool: 'get_overview', params: {} });
    db.prepare(
      `UPDATE scan_jobs SET created_at = datetime('now', '-90 days') WHERE id = ?`
    ).run(running.id);

    const pruned = pruneScanJobs(db);
    expect(pruned).toBe(2);

    expect(getScanJob(db, oldDone.id)).toBeNull();
    expect(getScanJob(db, oldFailed.id)).toBeNull();
    expect(getScanJob(db, recentDone.id)!.status).toBe('done');
    expect(getScanJob(db, running.id)!.status).toBe('running');
  });
});
