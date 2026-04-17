import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import inquirer from 'inquirer';
import { ensureAgentMailDir, ACCOUNTS_YAML_PATH } from '../config.js';
import { detectImapSmtp } from '../provider/accounts.js';
import { ImapProvider } from '../provider/imap.js';
import { storePassword, KEYCHAIN_SERVICE } from '../provider/keychain.js';
import { writeDefaultPolicy } from '../policy/defaults.js';
import { openDatabase } from '../ledger/db.js';
import type { AccountConfig, ResolvedAccount } from '../types.js';

export async function addAccount(): Promise<void> {
  ensureAgentMailDir();

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'email',
      message: 'Email address:',
      validate: (v: string) =>
        v.includes('@') ? true : 'Enter a valid email address',
    },
  ]);

  const detected = detectImapSmtp(answers.email);

  const hostAnswers = await inquirer.prompt([
    {
      type: 'input',
      name: 'imapHost',
      message: 'IMAP host:',
      default: detected.imap.host,
    },
    {
      type: 'number',
      name: 'imapPort',
      message: 'IMAP port:',
      default: detected.imap.port,
    },
    {
      type: 'input',
      name: 'smtpHost',
      message: 'SMTP host:',
      default: detected.smtp.host,
    },
    {
      type: 'number',
      name: 'smtpPort',
      message: 'SMTP port:',
      default: detected.smtp.port,
    },
    {
      type: 'password',
      name: 'password',
      message: 'Password (app-specific password for Gmail/iCloud):',
      mask: '*',
    },
    {
      type: 'input',
      name: 'accountId',
      message: 'Account ID (short name):',
      default: answers.email.split('@')[1].split('.')[0],
    },
  ]);

  const account: AccountConfig = {
    id: hostAnswers.accountId,
    email: answers.email,
    imap: {
      host: hostAnswers.imapHost,
      port: hostAnswers.imapPort,
      tls: true,
    },
    smtp: {
      host: hostAnswers.smtpHost,
      port: hostAnswers.smtpPort,
      tls: true,
    },
  };

  // Test IMAP connection
  console.log('\nTesting IMAP connection...');
  const testResolved: ResolvedAccount = {
    ...account,
    auth: { user: answers.email, pass: hostAnswers.password },
  };
  const imap = new ImapProvider(testResolved);
  try {
    await imap.connect();
    await imap.disconnect();
    console.log('IMAP connection successful!\n');
  } catch (error) {
    console.error(
      `IMAP connection failed: ${error instanceof Error ? error.message : error}`
    );
    console.error(
      'Check your host, port, and credentials. For Gmail/iCloud, use an app-specific password.'
    );
    process.exit(1);
  }

  // Load or create accounts.yaml
  let accounts: AccountConfig[] = [];
  if (existsSync(ACCOUNTS_YAML_PATH)) {
    const existing = yaml.load(
      readFileSync(ACCOUNTS_YAML_PATH, 'utf-8')
    ) as { accounts: AccountConfig[] };
    accounts = existing?.accounts ?? [];
  }

  // Check for duplicate ID
  if (accounts.some((a) => a.id === account.id)) {
    console.error(`Account with ID "${account.id}" already exists.`);
    process.exit(1);
  }

  // Store password in Keychain
  storePassword(KEYCHAIN_SERVICE, account.id, hostAnswers.password);
  console.log(`Password stored in macOS Keychain (service: "${KEYCHAIN_SERVICE}", account: "${account.id}")`);

  accounts.push(account);
  writeFileSync(
    ACCOUNTS_YAML_PATH,
    yaml.dump({ accounts }, { lineWidth: -1 }),
    { mode: 0o600 }
  );

  console.log(`Account "${account.id}" added to ${ACCOUNTS_YAML_PATH}`);

  // First-run setup
  writeDefaultPolicy();
  openDatabase().close(); // Initialize DB

  const binPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'agent-mail.mjs');
  const absoluteBinPath = resolve(binPath);

  console.log('\nSetup complete! Add this to your Claude/ChatGPT MCP config:');
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          'agent-mail': { command: absoluteBinPath, args: ['serve'] },
        },
      },
      null,
      2
    )
  );
}
