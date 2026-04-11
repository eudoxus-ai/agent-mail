import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAccounts, getAccount, getDefaultAccount, detectImapSmtp } from '../../src/provider/accounts.js';

describe('loadAccounts', () => {
  it('loads accounts from a valid yaml file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-mail-test-'));
    const path = join(dir, 'accounts.yaml');
    writeFileSync(
      path,
      `accounts:
  - id: gmail
    email: test@gmail.com
    imap: { host: imap.gmail.com, port: 993, tls: true }
    smtp: { host: smtp.gmail.com, port: 587, tls: true }
    auth: { user: test@gmail.com, pass: secret }
`
    );
    const accounts = loadAccounts(path);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe('gmail');
    expect(accounts[0].email).toBe('test@gmail.com');
  });

  it('throws on missing accounts array', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-mail-test-'));
    const path = join(dir, 'accounts.yaml');
    writeFileSync(path, 'foo: bar');
    expect(() => loadAccounts(path)).toThrow('missing "accounts" array');
  });
});

describe('getAccount', () => {
  const accounts = [
    { id: 'gmail', email: 'a@gmail.com', imap: { host: '', port: 993, tls: true }, smtp: { host: '', port: 587, tls: true }, auth: { user: '', pass: '' } },
    { id: 'icloud', email: 'b@icloud.com', imap: { host: '', port: 993, tls: true }, smtp: { host: '', port: 587, tls: true }, auth: { user: '', pass: '' } },
  ];

  it('finds account by id', () => {
    expect(getAccount(accounts, 'icloud').email).toBe('b@icloud.com');
  });

  it('throws for unknown id', () => {
    expect(() => getAccount(accounts, 'unknown')).toThrow('Account not found');
  });
});

describe('getDefaultAccount', () => {
  it('returns first account', () => {
    const accounts = [
      { id: 'first', email: 'a@test.com', imap: { host: '', port: 993, tls: true }, smtp: { host: '', port: 587, tls: true }, auth: { user: '', pass: '' } },
    ];
    expect(getDefaultAccount(accounts).id).toBe('first');
  });

  it('throws when empty', () => {
    expect(() => getDefaultAccount([])).toThrow('No accounts');
  });
});

describe('detectImapSmtp', () => {
  it('detects Gmail', () => {
    const result = detectImapSmtp('user@gmail.com');
    expect(result.imap.host).toBe('imap.gmail.com');
    expect(result.smtp.host).toBe('smtp.gmail.com');
  });

  it('detects iCloud', () => {
    const result = detectImapSmtp('user@icloud.com');
    expect(result.imap.host).toBe('imap.mail.me.com');
    expect(result.smtp.host).toBe('smtp.mail.me.com');
  });

  it('detects Outlook', () => {
    const result = detectImapSmtp('user@outlook.com');
    expect(result.imap.host).toBe('outlook.office365.com');
  });

  it('falls back to generic for unknown domains', () => {
    const result = detectImapSmtp('user@example.com');
    expect(result.imap.host).toBe('imap.example.com');
    expect(result.smtp.host).toBe('smtp.example.com');
  });

  it('throws for invalid email', () => {
    expect(() => detectImapSmtp('notanemail')).toThrow('Invalid email');
  });
});
