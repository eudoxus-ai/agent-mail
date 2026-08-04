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
