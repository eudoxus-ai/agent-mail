import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Database } from '../ledger/sqlite.js';
import type { Logger } from '../logger.js';
import type { Executor } from '../executor/executor.js';
import type { Intent } from '../types.js';
import { claimNext, heartbeat, reclaimExpired } from '../ledger/queue.js';
import { updateIntentStatus } from '../ledger/intents.js';
import {
  recordWorkerHeartbeat,
  clearWorkerHeartbeat,
  HEARTBEAT_INTERVAL_MS,
} from '../ledger/worker-heartbeat.js';

export interface QueueWorkerDeps {
  db: Database;
  executor: Executor;
  logger: Logger;
  /** How long a claim is good for before reclaim may take it back. */
  leaseMs?: number;
  /** The pool's per-operation ceiling. The lease has to be longer than this. */
  operationTimeoutMs: number;
  /** How often to look for work. */
  tickMs?: number;
  /** Ceiling on jobs in flight at once. Accounts already cap this in practice. */
  maxConcurrent?: number;
  /** Identifies this worker in the ledger. Defaults to host + pid + a uuid. */
  workerId?: string;
  /** How often to record liveness for other processes to read. */
  heartbeatIntervalMs?: number;
}

/** Long enough to outlive the pool's 5-minute default with room to spare. */
const DEFAULT_LEASE_MS = 15 * 60_000;

/**
 * A lease that safely covers the given operation timeout.
 *
 * Derived rather than constant: `AGENT_MAIL_IMAP_TIMEOUT_MS` exists so a
 * legitimately huge sweep can be given longer, and a fixed lease would either
 * stop the daemon booting once the timeout passed it, or — worse — invite
 * someone to weaken the constructor's assertion to match.
 */
export function leaseForTimeout(operationTimeoutMs: number): number {
  return Math.max(DEFAULT_LEASE_MS, operationTimeoutMs * 3);
}
const DEFAULT_TICK_MS = 1_000;
/**
 * Per-account serialization is the real limit — this only bounds how many
 * accounts can be mid-sweep at once, so a wide fan-out cannot open every
 * connection the provider allows at the same moment.
 */
const DEFAULT_MAX_CONCURRENT = 8;

/**
 * Drains queued intents from the ledger.
 *
 * The queue is the ledger, so this is the whole of "accepted work gets done":
 * claim a job, run it, settle it, and hold the lease open for as long as it
 * takes. Nothing here may throw into the event loop — an unhandled rejection
 * kills the daemon, and the daemon dying with work queued is the exact failure
 * this design exists to survive.
 */
export class QueueWorker {
  private readonly db: Database;
  private readonly executor: Executor;
  private readonly logger: Logger;
  readonly leaseMs: number;
  private readonly operationTimeoutMs: number;
  private readonly tickMs: number;
  private readonly maxConcurrent: number;
  readonly workerId: string;

  private readonly heartbeatIntervalMs: number;

  private timer: NodeJS.Timeout | null = null;
  private liveness: NodeJS.Timeout | null = null;
  private stopped = false;
  private ticking = false;
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(deps: QueueWorkerDeps) {
    this.db = deps.db;
    this.executor = deps.executor;
    this.logger = deps.logger;
    this.leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
    this.operationTimeoutMs = deps.operationTimeoutMs;
    this.tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
    this.maxConcurrent = deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.workerId = deps.workerId ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;

    if (this.leaseMs <= this.operationTimeoutMs) {
      // Not clamped, not warned about — thrown. A lease that can expire while
      // an operation is still legitimately running means reclaim requeues the
      // job and a second worker starts it while the first is still going: two
      // processes mutating the same mailbox, and nothing in the logs saying so.
      // Equal counts as too short, because then the reclaim sweep and the
      // timeout race and millisecond scheduling decides the outcome.
      throw new Error(
        `Queue worker lease (${this.leaseMs}ms) must be longer than the IMAP ` +
          `operation timeout (${this.operationTimeoutMs}ms), or a slow-but-healthy ` +
          'operation will be reclaimed and re-run underneath the worker still ' +
          'performing it. Raise the lease or lower AGENT_MAIL_IMAP_TIMEOUT_MS.'
      );
    }
  }

  /** Jobs currently running. Exposed for tests and diagnostics. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Begin looking for work on an interval. */
  start(): void {
    if (this.timer) return;
    this.stopped = false;

    // Announce before the first tick, not after it. Everything that answers
    // "is anything draining the queue?" reads this row, and a daemon that has
    // started but not yet beaten would be reported as down.
    this.beat();
    this.liveness = setInterval(() => this.beat(), this.heartbeatIntervalMs);
    this.liveness.unref?.();

    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
    // Don't hold the process open on our account; the daemon decides that.
    this.timer.unref?.();
    void this.tick();
  }

  private beat(): void {
    try {
      recordWorkerHeartbeat(this.db, { workerId: this.workerId, pid: process.pid });
    } catch (error) {
      // Liveness reporting must never be the reason the queue stops draining.
      this.logger.warn('Could not record worker liveness', { error: describe(error) });
    }
  }

  /**
   * Stop claiming and wait for whatever is already running.
   *
   * Deliberately not an abort: a half-finished mailbox sweep killed at shutdown
   * leaves mail in a state nobody recorded. Finishing the job in hand costs a
   * few seconds at shutdown and keeps the ledger honest.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.liveness) {
      clearInterval(this.liveness);
      this.liveness = null;
    }
    await this.drain();

    // Withdraw the announcement last, after the final job has settled: until
    // then this process really is still working, and reporting otherwise would
    // invite a second daemon to start beside it.
    try {
      clearWorkerHeartbeat(this.db);
    } catch (error) {
      this.logger.warn('Could not clear worker liveness', { error: describe(error) });
    }
  }

  /** Wait for in-flight jobs without stopping the loop. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight.values()]);
    }
  }

  /**
   * One pass: return abandoned work to the queue, then claim what will fit.
   *
   * Reclaim runs first so a job whose worker died is available to this pass
   * rather than the next one.
   */
  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      this.reclaim();

      while (!this.stopped && this.inFlight.size < this.maxConcurrent) {
        let intent: Intent | null;
        try {
          intent = claimNext(this.db, this.workerId, this.leaseMs);
        } catch (error) {
          // A claim failing is a database problem, not a job problem. Log it
          // and let the next tick try again rather than killing the loop.
          this.logger.error('Queue claim failed', { error: describe(error) });
          return;
        }
        if (!intent) break;
        this.launch(intent);
      }
    } finally {
      this.ticking = false;
    }
  }

  private reclaim(): void {
    try {
      const { requeued, failed } = reclaimExpired(this.db);
      if (requeued.length > 0) {
        this.logger.warn('Requeued work from a worker that stopped responding', {
          intent_ids: requeued,
        });
      }
      if (failed.length > 0) {
        this.logger.error('Gave up on work after repeated worker deaths', {
          intent_ids: failed,
        });
      }
    } catch (error) {
      this.logger.error('Reclaim sweep failed', { error: describe(error) });
    }
  }

  /** Start a job and track it. Never rejects. */
  private launch(intent: Intent): void {
    const beat = setInterval(() => {
      try {
        const held = heartbeat(this.db, intent.id, this.workerId, this.leaseMs);
        if (!held) {
          // Someone else owns this now — most likely reclaim decided we were
          // dead. We cannot abort an IMAP operation mid-flight, so the honest
          // move is to say so loudly and let the duplicate be visible.
          this.logger.error('Lost the claim on a job still running here', {
            intent_id: intent.id,
            worker_id: this.workerId,
          });
        }
      } catch (error) {
        this.logger.warn('Heartbeat failed', {
          intent_id: intent.id,
          error: describe(error),
        });
      }
      // A third of the lease: two consecutive misses still leave time to
      // recover before reclaim takes the job.
    }, Math.max(1, Math.floor(this.leaseMs / 3)));
    beat.unref?.();

    const running = (async () => {
      try {
        await this.executor.performQueued(intent);
      } catch (error) {
        // performQueued settles its own failures, so reaching here means
        // something unexpected. Settle it anyway: an intent left at
        // `executing` with no explanation is the state that made the last
        // outage unreadable, and it would sit there until its lease expired.
        const message = describe(error);
        this.logger.error('Queued job threw', { intent_id: intent.id, error: message });
        try {
          updateIntentStatus(this.db, intent.id, 'failed', {
            error_detail: { message, code: 'worker_unhandled_error' },
          });
        } catch (settleError) {
          this.logger.error('Could not record a failed job', {
            intent_id: intent.id,
            error: describe(settleError),
          });
        }
      } finally {
        clearInterval(beat);
        this.inFlight.delete(intent.id);
      }
    })();

    this.inFlight.set(intent.id, running);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
