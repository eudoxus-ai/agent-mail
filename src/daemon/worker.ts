import type { Database } from '../ledger/sqlite.js';
import type { Logger } from '../logger.js';
import type { Executor } from '../executor/executor.js';

export interface QueueWorkerDeps {
  db: Database;
  executor: Executor;
  logger: Logger;
  /** How long a claim is good for before reclaim may take it back. */
  leaseMs?: number;
  /** The pool's per-operation ceiling. The lease has to be longer than this. */
  operationTimeoutMs: number;
}

/** Long enough to outlive the pool's 5-minute default with room to spare. */
const DEFAULT_LEASE_MS = 15 * 60_000;

/**
 * Drains queued intents from the ledger.
 *
 * Construction validates the lease against the pool's operation timeout, and
 * throws if it is too short — see the message below for why that is not
 * something to paper over with a clamp.
 */
export class QueueWorker {
  private readonly db: Database;
  private readonly executor: Executor;
  private readonly logger: Logger;
  private readonly leaseMs: number;
  private readonly operationTimeoutMs: number;

  constructor(deps: QueueWorkerDeps) {
    this.db = deps.db;
    this.executor = deps.executor;
    this.logger = deps.logger;
    this.leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
    this.operationTimeoutMs = deps.operationTimeoutMs;

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
}
