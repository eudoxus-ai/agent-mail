import type { Database } from '../ledger/sqlite.js';
import type { Logger } from '../logger.js';
import { createScanJob, completeScanJob, failScanJob } from '../ledger/scan-jobs.js';

/**
 * Default fail-fast timeout for synchronous heavy scans. imapflow cannot always
 * abort an in-flight fetch, so this is a guard that returns control to the
 * caller with an actionable error (advising `async: true`) rather than a hard
 * kill. Bounding the underlying fetch is the primary fix; this is the safety
 * net. Overridable per call.
 */
export const DEFAULT_SCAN_TIMEOUT_MS = 30_000;

/**
 * Wrap a promise with a fail-fast timeout. If `work` does not settle within
 * `timeoutMs`, the returned promise rejects with an error naming `async: true`.
 * The underlying `work` promise is NOT cancelled (imapflow can't always abort a
 * fetch) — but because heavy fetches are now bounded, it drains quickly and
 * frees its IMAP connection. This just returns control to the agent.
 */
export function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number = DEFAULT_SCAN_TIMEOUT_MS,
  label = 'scan'
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `${label} timed out after ${timeoutMs}ms. Retry with async: true to ` +
            `run it in the background and poll get_scan_result for the result.`
        )
      );
    }, timeoutMs);
    // Don't keep the event loop alive solely for this timer.
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Registers and settles background scan jobs. `start` inserts a `running` row,
 * fires `work()` as a detached promise, and writes `done`/`failed` back to the
 * row when it settles. It NEVER rejects to the caller — the caller gets the
 * job handle immediately and polls `get_scan_result` for the outcome.
 *
 * The detached promise holds refs to the shared `db` (and, via the closure
 * passed in, the `pool`); the stdio MCP process is long-lived and the pool's
 * keepalive timer is `unref()`'d, so the promise survives between tool calls
 * with no separate daemon or event loop.
 */
export class ScanJobRunner {
  private db: Database;
  private logger: Logger;

  constructor(deps: { db: Database; logger: Logger }) {
    this.db = deps.db;
    this.logger = deps.logger;
  }

  start(
    tool: string,
    params: Record<string, unknown>,
    agentId: string | null,
    work: () => Promise<unknown>
  ): { job_id: string; status: 'running' } {
    const job = createScanJob(this.db, { tool, params, agent_id: agentId });

    // Detached: do not await. The .then/.catch settle the row; the chain never
    // rejects to the caller. Both settle-writes are wrapped in their own
    // try/catch so a DB write that throws (e.g. disk error) is logged and can
    // NEVER escape as an unhandled promise rejection.
    void work()
      .then((result) => {
        try {
          completeScanJob(this.db, job.id, result);
        } catch (writeError: unknown) {
          const message =
            writeError instanceof Error ? writeError.message : String(writeError);
          this.logger.warn(
            `scan job ${job.id} (${tool}) failed to write completion: ${message}`
          );
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`scan job ${job.id} (${tool}) failed: ${message}`);
        try {
          failScanJob(this.db, job.id, { message });
        } catch (writeError: unknown) {
          const writeMessage =
            writeError instanceof Error ? writeError.message : String(writeError);
          this.logger.warn(
            `scan job ${job.id} (${tool}) failed to write failure: ${writeMessage}`
          );
        }
      });

    return { job_id: job.id, status: 'running' };
  }
}
