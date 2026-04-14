import { existsSync } from 'node:fs';
import { openDatabase } from '../ledger/db.js';
import { loadAccounts } from '../provider/accounts.js';
import { ImapConnectionPool } from '../provider/imap-pool.js';
import { Executor } from '../executor/executor.js';
import { createReviewerApp } from '../reviewer/app.js';
import { createLogger } from '../logger.js';
import { loadReviewerToken } from '../reviewer/auth.js';
import { ACCOUNTS_YAML_PATH, LEDGER_DB_PATH } from '../config.js';

export async function startReviewer(port: number = 4242): Promise<void> {
  const logger = createLogger('cli');

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
  const executor = new Executor({ db, accounts, pool, logger });
  const app = createReviewerApp({ db, executor, logger });

  const token = loadReviewerToken();

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

  app.listen(port, () => {
    logger.info(`agent-mail reviewer running at http://localhost:${port}`);
    logger.info(`Bearer token: ${token.substring(0, 8)}...`);
    logger.info(`${accounts.length} account(s) configured`);
  });
}
