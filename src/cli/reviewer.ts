import { existsSync } from 'node:fs';
import { openDatabase } from '../ledger/db.js';
import { loadAccounts } from '../provider/accounts.js';
import { ImapConnectionPool } from '../provider/imap-pool.js';
import { Executor } from '../executor/executor.js';
import { createReviewerApp } from '../reviewer/app.js';
import { createLogger } from '../logger.js';
import { ACCOUNTS_YAML_PATH, LEDGER_DB_PATH, DEFAULT_REVIEWER_PORT, CACHE_DB_PATH } from '../config.js';
import { openCache } from '../cache/db.js';
import { loadCacheConfig } from '../cache/config.js';

export async function startReviewer(port: number = DEFAULT_REVIEWER_PORT): Promise<void> {
  const logger = createLogger('cli');
  const host = '127.0.0.1';

  if (!existsSync(ACCOUNTS_YAML_PATH)) {
    logger.error(
      "No accounts configured. Run 'npx agent-mail add-account' first."
    );
    process.exit(1);
  }

  if (!existsSync(LEDGER_DB_PATH)) {
    logger.error(
      "No database found. Run 'npx agent-mail add-account' first."
    );
    process.exit(1);
  }

  const db = openDatabase();
  const accounts = loadAccounts();
  const pool = new ImapConnectionPool({ accounts, logger });
  // Approvals executed here mutate mail too, so the cache needs the same echo
  // the MCP path gets. This process doesn't sync — the daemon owns that — so
  // the cache is opened only if it already exists.
  const cacheConfig = loadCacheConfig();
  let cache;
  if (existsSync(CACHE_DB_PATH)) {
    try {
      cache = openCache(CACHE_DB_PATH);
    } catch (error) {
      logger.warn(
        `Local cache unavailable: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  const executor = new Executor({ db, accounts, pool, logger, cache, cacheConfig });
  const app = createReviewerApp({ db, executor, logger });

  const shutdown = async (code = 0) => {
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
    logger.info(`agent-mail reviewer running at http://${host}:${port}`);
    logger.info(`${accounts.length} account(s) configured`);
  });
}
