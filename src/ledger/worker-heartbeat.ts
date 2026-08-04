import type { Database } from './sqlite.js';

/**
 * Is anything actually draining the queue?
 *
 * The worker lives in the daemon. The MCP server and the CLI are separate
 * processes with no view into it, and the ledger file is the only thing all
 * three share — so the worker writes its liveness there and everyone else
 * reads it. Without this, a stopped daemon looks exactly like a busy one, and
 * fifty accepted holds sit in the queue with nothing saying why.
 */

/** How often the daemon beats. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * How long a beat stays believable. Four missed beats: long enough that a
 * momentarily busy event loop is not reported as a dead daemon, short enough
 * that a user who just stopped it finds out on their next command.
 */
export const HEARTBEAT_STALE_AFTER_MS = 60_000;

export interface WorkerHeartbeat {
  worker_id: string;
  /** The process to look for — or kill — if it turns out to be wedged. */
  pid: number;
  last_seen_at: string;
}

export function recordWorkerHeartbeat(
  db: Database,
  args: { workerId: string; pid: number; now?: Date }
): void {
  const now = (args.now ?? new Date()).toISOString();
  db.prepare(
    `INSERT INTO worker_heartbeat (id, worker_id, pid, last_seen_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       worker_id = excluded.worker_id,
       pid = excluded.pid,
       last_seen_at = excluded.last_seen_at`
  ).run(args.workerId, args.pid, now);
}

export function getWorkerHeartbeat(db: Database): WorkerHeartbeat | null {
  const row = db
    .prepare(`SELECT worker_id, pid, last_seen_at FROM worker_heartbeat WHERE id = 1`)
    .get() as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    worker_id: row.worker_id as string,
    pid: Number(row.pid),
    last_seen_at: row.last_seen_at as string,
  };
}

/**
 * Drop the record on a clean shutdown.
 *
 * Leaving the last beat behind would report a deliberately stopped daemon as
 * alive for another minute — the exact window in which a user runs a command,
 * sees nothing wrong, and walks away. A crashed daemon leaves its row in place,
 * which is the informative case: pid and time of death.
 */
export function clearWorkerHeartbeat(db: Database): void {
  db.prepare(`DELETE FROM worker_heartbeat WHERE id = 1`).run();
}

/**
 * False when no worker has ever run, not just when one has gone quiet. A
 * ledger that has never seen a worker is the most likely reason work is not
 * moving — treating "unknown" as "probably fine" is how the last outage stayed
 * invisible for a week.
 */
export function isWorkerAlive(
  db: Database,
  staleAfterMs: number = HEARTBEAT_STALE_AFTER_MS
): boolean {
  const beat = getWorkerHeartbeat(db);
  if (!beat) return false;
  const age = Date.now() - Date.parse(beat.last_seen_at);
  return age <= staleAfterMs;
}
