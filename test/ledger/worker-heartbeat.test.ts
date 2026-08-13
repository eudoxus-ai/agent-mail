import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import type { Database } from '../../src/ledger/sqlite.js';
import {
  recordWorkerHeartbeat,
  isWorkerAlive,
  getWorkerHeartbeat,
} from '../../src/ledger/worker-heartbeat.js';

/**
 * Liveness has to be readable from outside the daemon's process.
 *
 * The worker runs in the daemon; the MCP server and the CLI are separate
 * processes that can see nothing of it. The one thing all three share is the
 * ledger file, so that is where "I am alive" gets written. Without it, a
 * stopped daemon is indistinguishable from a busy one, and accepted work sits
 * in the queue with nobody saying so.
 */

let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:');
});

describe('worker heartbeat', () => {
  it('reports no worker when none has ever run', () => {
    expect(getWorkerHeartbeat(db)).toBeNull();
    // Not "alive until proven otherwise": a ledger that has never seen a
    // worker is the single most likely reason work is not moving.
    expect(isWorkerAlive(db, 60_000)).toBe(false);
  });

  it('records who is running and where', () => {
    recordWorkerHeartbeat(db, { workerId: 'worker-1', pid: 4242 });

    const beat = getWorkerHeartbeat(db)!;
    expect(beat.worker_id).toBe('worker-1');
    // The pid is what turns "something claims to be running" into something
    // the user can actually check or kill.
    expect(beat.pid).toBe(4242);
    expect(Date.parse(beat.last_seen_at)).not.toBeNaN();
  });

  it('is alive immediately after a beat', () => {
    recordWorkerHeartbeat(db, { workerId: 'worker-1', pid: 1 });
    expect(isWorkerAlive(db, 60_000)).toBe(true);
  });

  it('goes stale once the beats stop', () => {
    recordWorkerHeartbeat(db, {
      workerId: 'worker-1',
      pid: 1,
      now: new Date(Date.now() - 61_000),
    });
    expect(isWorkerAlive(db, 60_000)).toBe(false);
  });

  it('still counts a beat right at the edge of the window', () => {
    // The window is four missed beats wide precisely so a momentarily busy
    // event loop is not reported as a dead daemon. Being strict at the
    // boundary would undo that.
    recordWorkerHeartbeat(db, {
      workerId: 'worker-1',
      pid: 1,
      now: new Date(Date.now() - 59_000),
    });
    expect(isWorkerAlive(db, 60_000)).toBe(true);
  });

  it('keeps one row, not a log', () => {
    recordWorkerHeartbeat(db, { workerId: 'worker-1', pid: 1 });
    recordWorkerHeartbeat(db, { workerId: 'worker-1', pid: 1 });
    recordWorkerHeartbeat(db, { workerId: 'worker-2', pid: 2 });

    const rows = db.prepare(`SELECT * FROM worker_heartbeat`).all();
    // This table answers one question. Letting it grow unbounded would make a
    // long-running daemon pay to write history nobody reads.
    expect(rows).toHaveLength(1);
    expect(getWorkerHeartbeat(db)!.worker_id).toBe('worker-2');
  });

  it('advances the timestamp on every beat', () => {
    recordWorkerHeartbeat(db, { workerId: 'worker-1', pid: 1 });
    const first = getWorkerHeartbeat(db)!.last_seen_at;

    recordWorkerHeartbeat(db, {
      workerId: 'worker-1',
      pid: 1,
      now: new Date(Date.parse(first) + 5_000),
    });

    expect(Date.parse(getWorkerHeartbeat(db)!.last_seen_at)).toBeGreaterThan(
      Date.parse(first)
    );
  });

  it('measures staleness from the beat, not from process start', () => {
    const longAgo = new Date(Date.now() - 10 * 60_000);
    recordWorkerHeartbeat(db, { workerId: 'worker-1', pid: 1, now: longAgo });

    expect(isWorkerAlive(db, 60_000)).toBe(false);

    recordWorkerHeartbeat(db, { workerId: 'worker-1', pid: 1 });
    expect(isWorkerAlive(db, 60_000)).toBe(true);
  });
});
