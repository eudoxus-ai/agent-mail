import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Database } from '../../src/ledger/sqlite.js';
import { openDatabase } from '../../src/ledger/db.js';
import { getIntent } from '../../src/ledger/intents.js';
import { getAuditLog } from '../../src/ledger/audit.js';
import { Executor } from '../../src/executor/executor.js';
import { createLogger } from '../../src/logger.js';
import type { AccountConfig } from '../../src/types.js';

// Mock the IMAP and SMTP modules
vi.mock('../../src/provider/imap.js', () => ({
  ImapProvider: vi.fn().mockImplementation(function () { return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    fetchMessage: vi.fn().mockResolvedValue({ uid: 1, messageId: 'test', from: 'a@b.com', to: [], cc: [], date: '', subject: 'Test', bodyText: 'body', references: [], flags: [], mailbox: 'INBOX' }),
    createDraft: vi.fn().mockResolvedValue({ uid: 99 }),
    moveMessages: vi.fn().mockResolvedValue(undefined),
    setFlags: vi.fn().mockResolvedValue(undefined),
    removeFlags: vi.fn().mockResolvedValue(undefined),
    getMailboxPath: vi.fn().mockResolvedValue('agent-mail-quarantine'),
    ensureMailbox: vi.fn().mockResolvedValue(undefined),
  }; }),
}));

vi.mock('../../src/provider/smtp.js', () => ({
  createSmtpTransport: vi.fn().mockReturnValue({}),
  sendMail: vi.fn().mockResolvedValue({ messageId: 'sent-123' }),
}));

const testAccount: AccountConfig = {
  id: 'test',
  email: 'test@example.com',
  imap: { host: 'imap.example.com', port: 993, tls: true },
  smtp: { host: 'smtp.example.com', port: 587, tls: true },
  auth: { user: 'test@example.com', pass: 'secret' },
};

let db: Database;
let executor: Executor;

beforeEach(() => {
  db = openDatabase(':memory:');
  executor = new Executor({
    db,
    accounts: [testAccount],
    logger: createLogger('cli', { minLevel: 'error' }),
  });
});

describe('Executor.createGatedIntent', () => {
  it('creates a pending intent', async () => {
    const intent = await executor.createGatedIntent({
      tool: 'queue_send',
      toolParams: { to: 'bob@test.com', subject: 'Hi', body: 'Hello' },
      accountId: 'test',
      agentId: 'claude',
      risk: 'high',
    });

    expect(intent.status).toBe('pending');
    expect(intent.tool).toBe('queue_send');
    expect(intent.account_id).toBe('test');

    const audit = getAuditLog(db, { intent_id: intent.id });
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit.some((a) => a.action === 'created')).toBe(true);
  });
});

describe('Executor.approveAndExecute', () => {
  it('approves and executes a pending intent', async () => {
    const intent = await executor.createGatedIntent({
      tool: 'queue_send',
      toolParams: { to: 'bob@test.com', subject: 'Hi', body: 'Hello' },
      accountId: 'test',
      agentId: 'claude',
      risk: 'high',
    });

    const result = await executor.approveAndExecute(intent.id);
    expect(result.status).toBe('executed');
    expect(result.resolved_by).toBe('user');
  });

  it('throws when intent is not pending', async () => {
    const intent = await executor.createGatedIntent({
      tool: 'queue_send',
      toolParams: {},
      accountId: 'test',
      agentId: 'claude',
      risk: 'high',
    });
    await executor.rejectIntent(intent.id);

    await expect(executor.approveAndExecute(intent.id)).rejects.toThrow(
      'not pending'
    );
  });
});

describe('Executor.rejectIntent', () => {
  it('rejects a pending intent', async () => {
    const intent = await executor.createGatedIntent({
      tool: 'queue_send',
      toolParams: {},
      accountId: 'test',
      agentId: 'claude',
      risk: 'high',
    });

    const result = await executor.rejectIntent(intent.id, 'Not now');
    expect(result.status).toBe('rejected');

    const audit = getAuditLog(db, { intent_id: intent.id });
    expect(audit.some((a) => a.action === 'rejected')).toBe(true);
  });
});

describe('Executor.executeImmediate', () => {
  it('creates and executes an intent in one step', async () => {
    const { intent } = await executor.executeImmediate({
      tool: 'search_threads',
      toolParams: { query: 'test' },
      accountId: 'test',
      agentId: 'claude',
      risk: 'none',
    });

    expect(intent.status).toBe('executed');
    expect(intent.resolved_by).toBe('policy');

    const audit = getAuditLog(db, { intent_id: intent.id });
    expect(audit.some((a) => a.action === 'executing')).toBe(true);
    expect(audit.some((a) => a.action === 'executed')).toBe(true);
  });
});

describe('Executor.undoIntent', () => {
  it('undoes a quarantine action', async () => {
    const { intent } = await executor.executeImmediate({
      tool: 'quarantine_thread',
      toolParams: { uids: [1, 2], mailbox: 'INBOX' },
      accountId: 'test',
      agentId: 'claude',
      risk: 'medium',
    });

    const result = await executor.undoIntent(intent.id);
    expect(result.success).toBe(true);

    const undone = getIntent(db, intent.id)!;
    expect(undone.status).toBe('undone');
  });

  it('refuses to undo a sent email', async () => {
    const intent = await executor.createGatedIntent({
      tool: 'queue_send',
      toolParams: { to: 'bob@test.com', subject: 'Hi', body: 'Hello' },
      accountId: 'test',
      agentId: 'claude',
      risk: 'high',
    });
    await executor.approveAndExecute(intent.id);

    const result = await executor.undoIntent(intent.id);
    expect(result.success).toBe(false);
    expect(result.message).toContain('not reversible');
  });

  it('returns error for non-existent intent', async () => {
    const result = await executor.undoIntent('nonexistent');
    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
  });
});
