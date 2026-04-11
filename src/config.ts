import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';

export const AGENT_MAIL_DIR = join(homedir(), '.agent-mail');
export const ACCOUNTS_YAML_PATH = join(AGENT_MAIL_DIR, 'accounts.yaml');
export const LEDGER_DB_PATH = join(AGENT_MAIL_DIR, 'ledger.db');
export const POLICY_YAML_PATH = join(AGENT_MAIL_DIR, 'policy.yaml');
export const REVIEWER_TOKEN_PATH = join(AGENT_MAIL_DIR, 'reviewer-token');
export const LOG_FILE_PATH = join(AGENT_MAIL_DIR, 'agent-mail.log');

export function ensureAgentMailDir(): void {
  if (!existsSync(AGENT_MAIL_DIR)) {
    mkdirSync(AGENT_MAIL_DIR, { recursive: true, mode: 0o700 });
  }
}
