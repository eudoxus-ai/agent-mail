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

export interface WorkerState {
  alive: boolean;
  worker_id: string | null;
  pid: number | null;
  last_heartbeat: string | null;
  last_heartbeat_age_seconds: number | null;
  queued_count: number;
  oldest_queued_age_seconds: number | null;
  /** Present only when nothing is draining the queue. */
  warning?: string;
}

/** The one place this is worded, so the wording cannot drift between surfaces. */
export const INSTALL_HINT =
  "Start it with 'agent-mail install-daemon' (or 'agent-mail daemon' to run it in the foreground).";

/**
 * One description of "is anything going to do this work", for every surface
 * that has to answer it.
 *
 * Shared deliberately. Three places report this — the tool response, the
 * diagnostics dump, and the CLI — and three independently worded versions of
 * the same warning is how one of them ends up subtly reassuring.
 */
export function describeWorkerState(
  db: Database,
  staleAfterMs: number = HEARTBEAT_STALE_AFTER_MS
): WorkerState {
  const beat = getWorkerHeartbeat(db);
  const alive = beat != null && Date.now() - Date.parse(beat.last_seen_at) <= staleAfterMs;

  // Ages computed here rather than with SQL MIN, because `created_at` is text
  // in two shapes — SQLite's `YYYY-MM-DD HH:MM:SS` from the column default and
  // ISO strings from anything that sets it explicitly — and a string MIN sorts
  // the space before the `T`. That makes format, not time, pick the winner, and
  // the oldest job reads as brand new. Production rows happen to be uniform
  // today; this stops that from being load-bearing.
  const rows = db
    .prepare(`SELECT created_at FROM intents WHERE status = 'queued'`)
    .all() as Array<{ created_at: string }>;

  const queuedCount = rows.length;
  const now = Date.now();
  const oldestAge =
    queuedCount === 0
      ? null
      : Math.max(
          0,
          Math.round(
            Math.max(...rows.map((r) => now - parseLedgerTime(r.created_at))) / 1000
          )
        );

  const state: WorkerState = {
    alive,
    worker_id: beat?.worker_id ?? null,
    pid: beat?.pid ?? null,
    last_heartbeat: beat?.last_seen_at ?? null,
    last_heartbeat_age_seconds: beat
      ? Math.max(0, Math.round((Date.now() - Date.parse(beat.last_seen_at)) / 1000))
      : null,
    queued_count: queuedCount,
    oldest_queued_age_seconds: oldestAge,
  };

  if (!alive) {
    state.warning =
      queuedCount > 0
        ? `The agent-mail daemon is not running, so ${queuedCount} accepted ` +
          `action(s) are queued and nothing is performing them. ${INSTALL_HINT}`
        : `The agent-mail daemon is not running. Actions will be accepted and queued, ` +
          `but nothing will perform them until it is started. ${INSTALL_HINT}`;
  }

  return state;
}

/**
 * Ledger timestamps arrive in two shapes: ISO strings from application writes
 * and SQLite's own `YYYY-MM-DD HH:MM:SS` from `CURRENT_TIMESTAMP` defaults. The
 * latter has no zone and is UTC, so it needs the marker adding or every age
 * comes out wrong by the local offset.
 */
function parseLedgerTime(value: string): number {
  const normalized = value.includes('T') || value.endsWith('Z') ? value : `${value}Z`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}
