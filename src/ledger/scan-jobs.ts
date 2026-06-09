import type { Database } from './sqlite.js';
import { v4 as uuidv4 } from 'uuid';

export type ScanJobStatus = 'running' | 'done' | 'failed';

export interface ScanJob {
  id: string;
  tool: string;
  params: Record<string, unknown>;
  status: ScanJobStatus;
  result: unknown | null;
  error_detail: Record<string, unknown> | null;
  agent_id: string | null;
  created_at: string;
  completed_at: string | null;
}

function rowToScanJob(row: Record<string, unknown>): ScanJob {
  return {
    id: row.id as string,
    tool: row.tool as string,
    params: JSON.parse(row.params as string),
    status: row.status as ScanJobStatus,
    result: row.result != null ? JSON.parse(row.result as string) : null,
    error_detail:
      row.error_detail != null ? JSON.parse(row.error_detail as string) : null,
    agent_id: (row.agent_id as string) ?? null,
    created_at: row.created_at as string,
    completed_at: (row.completed_at as string) ?? null,
  };
}

export function createScanJob(
  db: Database,
  p: { tool: string; params: Record<string, unknown>; agent_id?: string | null }
): ScanJob {
  const id = uuidv4();
  db.prepare(
    `INSERT INTO scan_jobs (id, tool, params, status, agent_id)
     VALUES (?, ?, ?, 'running', ?)`
  ).run(id, p.tool, JSON.stringify(p.params), p.agent_id ?? null);
  return getScanJob(db, id)!;
}

export function completeScanJob(
  db: Database,
  id: string,
  result: unknown
): void {
  db.prepare(
    `UPDATE scan_jobs
       SET status = 'done',
           result = ?,
           completed_at = ?
     WHERE id = ? AND status = 'running'`
  ).run(JSON.stringify(result), new Date().toISOString(), id);
}

export function failScanJob(
  db: Database,
  id: string,
  errorDetail: Record<string, unknown>
): void {
  db.prepare(
    `UPDATE scan_jobs
       SET status = 'failed',
           error_detail = ?,
           completed_at = ?
     WHERE id = ? AND status = 'running'`
  ).run(JSON.stringify(errorDetail), new Date().toISOString(), id);
}

export function getScanJob(db: Database, id: string): ScanJob | null {
  const row = db
    .prepare('SELECT * FROM scan_jobs WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToScanJob(row) : null;
}

/**
 * Mark every `running` scan job as `failed` — called at server boot. A job
 * left `running` means the process died mid-scan: the background promise that
 * would have settled the row is gone, so the row is a permanent zombie unless
 * we reap it. Returns the number of jobs reaped.
 */
export function failStaleRunningJobs(db: Database): number {
  const result = db
    .prepare(
      `UPDATE scan_jobs
         SET status = 'failed',
             error_detail = ?,
             completed_at = ?
       WHERE status = 'running'`
    )
    .run(
      JSON.stringify({ message: 'server restarted while scan was running' }),
      new Date().toISOString()
    ) as { changes?: number | bigint };
  return Number(result.changes ?? 0);
}

/**
 * Delete terminal (`done`/`failed`) scan-job rows older than `maxAgeDays`,
 * keyed off `completed_at`. Scan-job rows carry result blobs and are inserted
 * per async scan but never otherwise deleted, so without pruning the table
 * grows unbounded. `running` rows are left untouched — they settle (or get
 * reaped by `failStaleRunningJobs` at boot) on their own. Called at startup
 * alongside the stale-reap. Returns the number of rows deleted.
 *
 * `completed_at` is stored as an ISO8601 string; `datetime()` normalises it so
 * the comparison against `datetime('now', '-N days')` is reliable across the
 * `T`/`Z` vs space-separated formats.
 */
export function pruneScanJobs(db: Database, maxAgeDays = 7): number {
  const result = db
    .prepare(
      `DELETE FROM scan_jobs
        WHERE status IN ('done', 'failed')
          AND completed_at IS NOT NULL
          AND datetime(completed_at) < datetime('now', ?)`
    )
    .run(`-${maxAgeDays} days`) as { changes?: number | bigint };
  return Number(result.changes ?? 0);
}
