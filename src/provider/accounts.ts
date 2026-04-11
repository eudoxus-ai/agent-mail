import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { ACCOUNTS_YAML_PATH } from '../config.js';
import type { AccountConfig } from '../types.js';

interface AccountsFile {
  accounts: AccountConfig[];
}

export function loadAccounts(
  path: string = ACCOUNTS_YAML_PATH
): AccountConfig[] {
  const content = readFileSync(path, 'utf-8');
  const data = yaml.load(content) as AccountsFile;
  if (!data?.accounts || !Array.isArray(data.accounts)) {
    throw new Error('Invalid accounts.yaml: missing "accounts" array');
  }
  return data.accounts;
}

export function getAccount(
  accounts: AccountConfig[],
  accountId: string
): AccountConfig {
  const account = accounts.find((a) => a.id === accountId);
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }
  return account;
}

export function getDefaultAccount(accounts: AccountConfig[]): AccountConfig {
  if (accounts.length === 0) {
    throw new Error('No accounts configured');
  }
  return accounts[0];
}

const WELL_KNOWN_HOSTS: Record<
  string,
  { imap: { host: string; port: number }; smtp: { host: string; port: number } }
> = {
  'gmail.com': {
    imap: { host: 'imap.gmail.com', port: 993 },
    smtp: { host: 'smtp.gmail.com', port: 587 },
  },
  'googlemail.com': {
    imap: { host: 'imap.gmail.com', port: 993 },
    smtp: { host: 'smtp.gmail.com', port: 587 },
  },
  'icloud.com': {
    imap: { host: 'imap.mail.me.com', port: 993 },
    smtp: { host: 'smtp.mail.me.com', port: 587 },
  },
  'me.com': {
    imap: { host: 'imap.mail.me.com', port: 993 },
    smtp: { host: 'smtp.mail.me.com', port: 587 },
  },
  'mac.com': {
    imap: { host: 'imap.mail.me.com', port: 993 },
    smtp: { host: 'smtp.mail.me.com', port: 587 },
  },
  'outlook.com': {
    imap: { host: 'outlook.office365.com', port: 993 },
    smtp: { host: 'smtp-mail.outlook.com', port: 587 },
  },
  'hotmail.com': {
    imap: { host: 'outlook.office365.com', port: 993 },
    smtp: { host: 'smtp-mail.outlook.com', port: 587 },
  },
  'live.com': {
    imap: { host: 'outlook.office365.com', port: 993 },
    smtp: { host: 'smtp-mail.outlook.com', port: 587 },
  },
  'fastmail.com': {
    imap: { host: 'imap.fastmail.com', port: 993 },
    smtp: { host: 'smtp.fastmail.com', port: 587 },
  },
  'yahoo.com': {
    imap: { host: 'imap.mail.yahoo.com', port: 993 },
    smtp: { host: 'smtp.mail.yahoo.com', port: 587 },
  },
};

export function detectImapSmtp(email: string): {
  imap: { host: string; port: number; tls: boolean };
  smtp: { host: string; port: number; tls: boolean };
} {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) {
    throw new Error(`Invalid email address: ${email}`);
  }

  const known = WELL_KNOWN_HOSTS[domain];
  if (known) {
    return {
      imap: { ...known.imap, tls: true },
      smtp: { ...known.smtp, tls: true },
    };
  }

  // Generic fallback
  return {
    imap: { host: `imap.${domain}`, port: 993, tls: true },
    smtp: { host: `smtp.${domain}`, port: 587, tls: true },
  };
}
