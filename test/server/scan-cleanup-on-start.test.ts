import { describe, it, expect } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import { runStartupScanCleanup } from '../../src/server/startup.js';
import { createScanJob, completeScanJob, getScanJob } from '../../src/ledger/scan-jobs.js';

describe('runStartupScanCleanup', () => {
  it('marks running scan jobs as failed on boot and leaves settled jobs alone', () => {
    const db = openDatabase(':memory:');
    const orphan = createScanJob(db, { tool: 'get_overview', params: {} });
    const done = createScanJob(db, { tool: 'list_senders', params: {} });
    completeScanJob(db, done.id, { ok: true });

    const reaped = runStartupScanCleanup(db);
    expect(reaped).toBe(1);

    expect(getScanJob(db, orphan.id)!.status).toBe('failed');
    expect(getScanJob(db, done.id)!.status).toBe('done');
  });

  it('returns 0 when there are no running jobs', () => {
    const db = openDatabase(':memory:');
    expect(runStartupScanCleanup(db)).toBe(0);
  });
});
