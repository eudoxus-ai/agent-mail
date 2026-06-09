import { describe, it, expect } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import { createLogger } from '../../src/logger.js';
import { getScanResultTool } from '../../src/tools/get-scan-result.js';
import {
  createScanJob,
  completeScanJob,
  failScanJob,
} from '../../src/ledger/scan-jobs.js';
import type { ToolContext } from '../../src/types.js';

const logger = createLogger('cli', { minLevel: 'error' });

function ctx(db: ReturnType<typeof openDatabase>): ToolContext {
  return { accountId: '', agentId: 'agent', db, accounts: [], logger };
}

function parse(result: { content?: Array<{ text: string }> }) {
  return JSON.parse(result.content![0].text);
}

describe('get_scan_result tool', () => {
  it('is read-only', () => {
    expect(getScanResultTool.annotations).toMatchObject({ readOnlyHint: true });
  });

  it('returns { status: "running" } while the job is in flight', async () => {
    const db = openDatabase(':memory:');
    const job = createScanJob(db, { tool: 'get_overview', params: {} });
    const result = await getScanResultTool.execute({ job_id: job.id }, ctx(db));
    expect(parse(result)).toEqual({ status: 'running' });
  });

  it('returns { status: "done", result } once complete with the byte-identical payload', async () => {
    const db = openDatabase(':memory:');
    const job = createScanJob(db, { tool: 'list_senders', params: {} });
    const payload = { senders: [{ from: 'x@y', count: 3 }], accounts_searched: ['a'] };
    completeScanJob(db, job.id, payload);
    const result = await getScanResultTool.execute({ job_id: job.id }, ctx(db));
    expect(parse(result)).toEqual({ status: 'done', result: payload });
  });

  it('returns { status: "failed", error } when the scan threw', async () => {
    const db = openDatabase(':memory:');
    const job = createScanJob(db, { tool: 'search_threads', params: {} });
    failScanJob(db, job.id, { message: 'IMAP auth failed' });
    const result = await getScanResultTool.execute({ job_id: job.id }, ctx(db));
    expect(parse(result)).toEqual({ status: 'failed', error: 'IMAP auth failed' });
  });

  it('returns a clear error for an unknown job_id', async () => {
    const db = openDatabase(':memory:');
    const result = await getScanResultTool.execute({ job_id: 'does-not-exist' }, ctx(db));
    const payload = parse(result);
    expect(payload.error).toBe(true);
    expect(payload.message).toMatch(/not found/);
  });
});
