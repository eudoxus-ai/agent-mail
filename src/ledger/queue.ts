import type { Database } from './sqlite.js';
import { rowToIntent } from './db.js';
import type { Intent } from '../types.js';

/**
 * The ledger as a work queue.
 *
 * `queued` means accepted and durable but not yet started. A worker takes
 * ownership by claiming — which is the one operation in the system that has to
 * be exactly-once, because claiming twice means mutating a mailbox twice.
 */

/**
 * Take ownership of the oldest queued intent, or return null if there is
 * nothing to take.
 *
 * One statement, deliberately. Selecting a candidate and then updating it in a
 * separate statement opens a window where two workers both see the same row as
 * queued; doing both inside a single UPDATE closes it, because SQLite
 * serializes writers and re-evaluates the subquery against committed state.
 * The trailing `AND status = 'queued'` is the compare-and-swap guard: redundant
 * while this stays one statement, and the thing that keeps it correct if anyone
 * ever splits it.
 *
 * @param leaseMs how long the claim is good for. Must exceed the longest an
 *   operation can take, or reclaim will re-run a job underneath its own worker.
 */
export function claimNext(
  db: Database,
  workerId: string,
  leaseMs: number
): Intent | null {
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();

  const row = db
    .prepare(
      `UPDATE intents
          SET status = 'executing',
              claimed_by = ?,
              claimed_at = ?,
              lease_expires_at = ?,
              attempts = attempts + 1
        WHERE id = (
                SELECT id FROM intents
                 WHERE status = 'queued'
                   -- One in-flight job per account. The IMAP pool serializes
                   -- per account anyway, so a second claim could not make
                   -- progress — it would sit blocked behind the first while its
                   -- own lease ran down, and get reclaimed for being slow.
                   --
                   -- Scoped to live claims only: intents left executing by the
                   -- old in-process path have no claimed_by and no lease, and
                   -- treating those as running would wedge an account forever.
                   AND account_id NOT IN (
                         SELECT account_id FROM intents
                          WHERE status = 'executing'
                            AND claimed_by IS NOT NULL
                            AND lease_expires_at > ?
                       )
                 -- rowid breaks ties: CURRENT_TIMESTAMP has one-second
                 -- resolution, so a burst of holds shares a created_at and
                 -- would otherwise drain in an unspecified order.
                 ORDER BY created_at, rowid
                 LIMIT 1
              )
          AND status = 'queued'
      RETURNING *`
    )
    .get(workerId, nowIso, leaseExpiresAt, nowIso) as
    | Record<string, unknown>
    | undefined;

  return row ? rowToIntent(row) : null;
}

/**
 * Extend the lease on a job this worker is running.
 *
 * Returns false when the caller does not hold the claim, or the job is no
 * longer executing. Both are refusals rather than errors: a worker whose claim
 * was reclaimed out from under it should stop, not throw, and it learns that
 * from the return value.
 */
export function heartbeat(
  db: Database,
  intentId: string,
  workerId: string,
  leaseMs: number
): boolean {
  const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
  const result = db
    .prepare(
      `UPDATE intents
          SET lease_expires_at = ?
        WHERE id = ? AND claimed_by = ? AND status = 'executing'`
    )
    .run(leaseExpiresAt, intentId, workerId) as { changes?: number | bigint };

  return Number(result.changes ?? 0) > 0;
}

/** Give up on a job after this many claims rather than looping on it forever. */
export const MAX_ATTEMPTS = 3;

export interface ReclaimResult {
  /** Ids put back in the queue for another worker. */
  requeued: string[];
  /** Ids that ran out of attempts and were marked failed. */
  failed: string[];
}

/**
 * Return jobs whose worker stopped heartbeating to the queue.
 *
 * Scoped to claimed jobs only. Intents left `executing` by the old in-process
 * path have no claim and no lease, and requeuing those would re-run a mutation
 * that may well have completed.
 *
 * A job that has burned `MAX_ATTEMPTS` claims is failed rather than requeued.
 * Without that, a job that reliably kills its worker gets picked up forever, and
 * each pass mutates a little more mail before dying.
 */
export function reclaimExpired(
  db: Database,
  opts: { maxAttempts?: number } = {}
): ReclaimResult {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const nowIso = new Date().toISOString();

  const expired = db
    .prepare(
      `SELECT id, attempts, claimed_by FROM intents
        WHERE status = 'executing'
          AND claimed_by IS NOT NULL
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?
        ORDER BY created_at, rowid`
    )
    .all(nowIso) as Array<{ id: string; attempts: number; claimed_by: string }>;

  const requeue = db.prepare(
    `UPDATE intents
        SET status = 'queued',
            claimed_by = NULL,
            claimed_at = NULL,
            lease_expires_at = NULL
      WHERE id = ? AND status = 'executing'`
  );
  const giveUp = db.prepare(
    `UPDATE intents
        SET status = 'failed',
            claimed_by = NULL,
            lease_expires_at = NULL,
            resolved_at = ?,
            resolved_by = 'queue',
            error_detail = ?
      WHERE id = ? AND status = 'executing'`
  );

  const result: ReclaimResult = { requeued: [], failed: [] };

  for (const row of expired) {
    const attempts = Number(row.attempts);
    if (attempts >= maxAttempts) {
      const detail = {
        message:
          `Abandoned after ${attempts} attempts: the worker stopped responding each time. ` +
          'Nothing further will retry this automatically.',
        code: 'lease_expired_max_attempts',
        attempts,
        last_worker: row.claimed_by,
      };
      giveUp.run(nowIso, JSON.stringify(detail), row.id);
      result.failed.push(row.id);
    } else {
      requeue.run(row.id);
      result.requeued.push(row.id);
    }
  }

  return result;
}
