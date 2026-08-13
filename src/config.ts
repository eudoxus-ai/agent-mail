import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';

export const AGENT_MAIL_DIR = join(homedir(), '.agent-mail');
export const ACCOUNTS_YAML_PATH = join(AGENT_MAIL_DIR, 'accounts.yaml');
export const LEDGER_DB_PATH = join(AGENT_MAIL_DIR, 'ledger.db');
/**
 * Local message cache. Deliberately a separate file from the ledger: the
 * ledger is the durable record of what happened, the cache is a derived
 * artifact that can be deleted and rebuilt from IMAP at any time.
 */
export const CACHE_DB_PATH = join(AGENT_MAIL_DIR, 'cache.db');
/** Staging area for on-demand attachment fetches. GC'd by the daemon. */
export const ATTACHMENTS_DIR = join(AGENT_MAIL_DIR, 'attachments');
export const POLICY_YAML_PATH = join(AGENT_MAIL_DIR, 'policy.yaml');
export const LOG_FILE_PATH = join(AGENT_MAIL_DIR, 'agent-mail.log');

export const DEFAULT_REVIEWER_PORT = 4242;

export function ensureAgentMailDir(): void {
  if (!existsSync(AGENT_MAIL_DIR)) {
    mkdirSync(AGENT_MAIL_DIR, { recursive: true, mode: 0o700 });
  }
}
