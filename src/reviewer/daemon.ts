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
import type { Intent } from '../types.js';
import type { Logger } from '../logger.js';

export interface NotifierDeps {
  logger: Logger;
  port: number;
  notify?: (intent: Intent, port: number) => void;
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

  const shutdown = async (code = 0) => {
    watcher.stop();
    syncLoop?.stop();
    try {
      await pool.closeAll();
    } catch {
      // best-effort
    }
    process.exit(code);
  };
  process.once('SIGINT', () => void shutdown(0));
  process.once('SIGTERM', () => void shutdown(0));

  app.listen(port, host, () => {
    logger.info(`agent-mail daemon running at http://${host}:${port}`);
    logger.info(`Watching for pending intents (polling every 3s)`);
    logger.info(`${accounts.length} account(s) configured`);

    if (syncLoop) {
      syncLoop.start();
      logger.info(
        `Local cache sync every ${cacheConfig.syncIntervalSeconds}s (mode: ${cacheConfig.mode})`
      );
    }
  });
}
