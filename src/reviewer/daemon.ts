import { existsSync } from 'node:fs';
import { openDatabase } from '../ledger/db.js';
import { loadAccounts } from '../provider/accounts.js';
import { ImapConnectionPool } from '../provider/imap-pool.js';
import { Executor } from '../executor/executor.js';
import { createReviewerApp } from './app.js';
import { IntentWatcher } from './watcher.js';
import { notifyIntent } from './notify.js';
import { createLogger } from '../logger.js';
import { ACCOUNTS_YAML_PATH, LEDGER_DB_PATH } from '../config.js';

export async function startDaemon(port: number = 4242): Promise<void> {
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
  const executor = new Executor({ db, accounts, pool, logger });
  const app = createReviewerApp({ db, executor, logger });

  const watcher = new IntentWatcher({
    db,
    pollingIntervalMs: 3000,
    onNewIntent: (intent) => {
      logger.info(`New pending intent: ${intent.id} (${intent.tool})`);
      notifyIntent(intent);
    },
  });
  watcher.start();

  const shutdown = async (code = 0) => {
    watcher.stop();
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
  });
}
