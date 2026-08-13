import { existsSync } from 'node:fs';
import { openDatabase } from '../ledger/db.js';
import { loadAccounts } from '../provider/accounts.js';
import { ImapConnectionPool } from '../provider/imap-pool.js';
import { Executor } from '../executor/executor.js';
import { createReviewerApp } from './app.js';
import { IntentWatcher } from './watcher.js';
import { notifyIntent } from './notify.js';
import { shouldNotify } from './notification-policy.js';
import { createLogger } from '../logger.js';
import { ACCOUNTS_YAML_PATH, LEDGER_DB_PATH, DEFAULT_REVIEWER_PORT } from '../config.js';
import { openCache, CacheUnsupportedError } from '../cache/db.js';
import { loadCacheConfig } from '../cache/config.js';
import { SyncLoop } from '../cache/sync-loop.js';
import { checkNodeRuntime } from '../lib/node-runtime.js';
import { QueueWorker, leaseForTimeout } from '../daemon/worker.js';
import type { Database } from '../ledger/sqlite.js';
import type { Intent } from '../types.js';
import type { Logger } from '../logger.js';

export interface NotifierDeps {
  logger: Logger;
  port: number;
  notify?: (intent: Intent, port: number) => void;
}

/**
 * Build the queue worker against the pool it will actually borrow from.
 *
 * The lease is derived from that pool's operation timeout rather than fixed, so
 * raising `AGENT_MAIL_IMAP_TIMEOUT_MS` cannot leave the two inconsistent — the
 * worker's constructor refuses a lease it could outlive, and a hardcoded value
 * would eventually trip it.
 */
export function createQueueWorker(deps: {
  db: Database;
  executor: Executor;
  pool: ImapConnectionPool;
  logger: Logger;
}): QueueWorker {
  const operationTimeoutMs = deps.pool.getOperationTimeoutMs();
  return new QueueWorker({
    db: deps.db,
    executor: deps.executor,
    logger: deps.logger,
    operationTimeoutMs,
    leaseMs: leaseForTimeout(operationTimeoutMs),
  });
}

export interface ShutdownDeps {
  logger: Logger;
  watcher: { stop(): void };
  syncLoop: { stop(): void } | null;
  worker: { stop(): Promise<void> } | null;
  pool: { closeAll(): Promise<void> };
  exit: (code: number) => void;
}

/**
 * Ordered shutdown: stop taking on work, let the job in hand finish, then drop
 * the connections it was using.
 *
 * The order matters. `worker.stop()` waits for the in-flight job rather than
 * aborting it, so closing the pool first would pull the connections out from
 * under a mutation already in progress. Every step is best-effort — a shutdown
 * that hangs on a stuck worker leaves an orphaned process holding the ledger,
 * which is worse than an untidy exit.
 */
export function createShutdown(deps: ShutdownDeps): (code?: number) => Promise<void> {
  return async (code = 0) => {
    try {
      deps.watcher.stop();
    } catch {
      // best-effort
    }
    try {
      deps.syncLoop?.stop();
    } catch {
      // best-effort
    }
    if (deps.worker) {
      try {
        await deps.worker.stop();
      } catch (error) {
        deps.logger.warn('Queue worker did not stop cleanly', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      await deps.pool.closeAll();
    } catch {
      // best-effort
    }
    deps.exit(code);
  };
}

export function createIntentNotifier(deps: NotifierDeps): (intent: Intent) => void {
  const notify = deps.notify ?? notifyIntent;
  return (intent) => {
    deps.logger.info(`New pending intent: ${intent.id} (${intent.tool}, risk=${intent.risk})`);
    if (shouldNotify(intent)) {
      notify(intent, deps.port);
    } else {
      deps.logger.debug(`Suppressed notification for low-priority intent ${intent.id}`);
    }
  };
}

export async function startDaemon(port: number = DEFAULT_REVIEWER_PORT): Promise<void> {
  const logger = createLogger('cli');
  const host = '127.0.0.1';

  // Stamp the runtime on every start. launchd runs with a stripped PATH and
  // none of the shell's environment, so the daemon can silently end up on a
  // different Node than the CLI — which matters because node:sqlite is
  // experimental and its feature set (FTS5 in particular) varies by major.
  logger.info(`agent-mail daemon starting on Node ${process.version}`, {
    exec_path: process.execPath,
    pid: process.pid,
  });

  const runtime = checkNodeRuntime();
  if (runtime.warning) logger.warn(runtime.warning);

  if (!existsSync(ACCOUNTS_YAML_PATH)) {
    logger.error("No accounts configured. Run 'npx agent-mail add-account' first.");
    process.exit(1);
  }

  if (!existsSync(LEDGER_DB_PATH)) {
    logger.error("No database found. Run 'npx agent-mail add-account' first.");
    process.exit(1);
  }

  const db = openDatabase();
  const accounts = loadAccounts();
  const pool = new ImapConnectionPool({ accounts, logger });

  // The daemon is the single writer to the cache. A cache that can't be
  // opened is logged and skipped — mail operations do not depend on it.
  const cacheConfig = loadCacheConfig();
  let cache = null;
  let syncLoop: SyncLoop | null = null;
  try {
    cache = openCache();
    syncLoop = new SyncLoop({ cache, accounts, pool, logger, config: cacheConfig });
  } catch (error) {
    if (error instanceof CacheUnsupportedError) {
      logger.warn(`Local cache unavailable: ${error.message}`);
    } else {
      logger.warn(
        `Local cache could not be opened: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  const executor = new Executor({
    db,
    accounts,
    pool,
    logger,
    cache: cache ?? undefined,
    cacheConfig,
  });
  const app = createReviewerApp({ db, executor, logger });

  const watcher = new IntentWatcher({
    db,
    pollingIntervalMs: 3000,
    onNewIntent: createIntentNotifier({ logger, port }),
  });
  watcher.start();

  // The daemon is the only process that executes queued mutations. Nothing
  // else drains the queue, so if this fails to start, accepted work simply
  // sits — which is why Phase 4 makes its absence loud everywhere.
  const worker = createQueueWorker({ db, executor, pool, logger });

  const shutdown = createShutdown({
    logger,
    watcher,
    syncLoop,
    worker,
    pool,
    exit: (code) => process.exit(code),
  });
  process.once('SIGINT', () => void shutdown(0));
  process.once('SIGTERM', () => void shutdown(0));

  app.listen(port, host, () => {
    logger.info(`agent-mail daemon running at http://${host}:${port}`);
    logger.info(`Watching for pending intents (polling every 3s)`);
    logger.info(`${accounts.length} account(s) configured`);

    worker.start();
    logger.info(`Queue worker ${worker.workerId} draining accepted work`, {
      lease_ms: worker.leaseMs,
    });

    // Only sync when the cache is actually in use.
    //
    // Syncing while mode is `off` was meant to warm the cache ahead of time,
    // but it makes the daemon a second heavy IMAP consumer on every account —
    // competing with the MCP server for the provider's per-account connection
    // and throughput budget — to populate a database nothing reads. On a large
    // iCloud mailbox that is hours of continuous SEARCH and FETCH. Opt in with
    // `mode: shadow` when you want the cache warmed.
    if (syncLoop && cacheConfig.mode !== 'off') {
      syncLoop.start();
      logger.info(
        `Local cache sync every ${cacheConfig.syncIntervalSeconds}s (mode: ${cacheConfig.mode})`
      );
    } else if (syncLoop) {
      logger.info('Local cache sync disabled (cache.mode is off)');
    }
  });
}
