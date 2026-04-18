import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Database } from '../../src/ledger/sqlite.js';
import { openDatabase } from '../../src/ledger/db.js';
import { getIntent } from '../../src/ledger/intents.js';
import { getAuditLog } from '../../src/ledger/audit.js';
import { Executor } from '../../src/executor/executor.js';
import { ImapConnectionPool } from '../../src/provider/imap-pool.js';
import { createLogger } from '../../src/logger.js';
import type { AccountConfig } from '../../src/types.js';
import { sendMail } from '../../src/provider/smtp.js';

// Mock the IMAP and SMTP modules
vi.mock('../../src/provider/imap.js', () => ({
  ImapProvider: vi.fn().mockImplementation(function () { return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([
      {
        uid: 42,
        envelope: {
          subject: 'Hello',
          from: { address: 'noreply@github.com', name: 'GitHub' },
          date: '2026-04-12T10:00:00Z',
        },
        snippet: 'A snippet',
        flags: [],
      },
    ]),
    fetchMessage: vi.fn().mockResolvedValue({
      uid: 1,
      messageId: 'test',
      from: { address: 'a@b.com', name: null },
      to: [],
      cc: [],
      date: '',
      subject: 'Test',
      bodyText: 'body',
      references: [],
      flags: [],
      mailbox: 'INBOX',
    }),
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
  buildDraftMessage: vi.fn().mockReturnValue(Buffer.from('draft')),
}));

vi.mock('../../src/provider/credentials.js', () => ({
  resolveCredentials: vi.fn().mockImplementation((account: any) => ({
    ...account,
    auth: { user: account.email, pass: 'mock-password' },
  })),
}));

// Mock pool that simply resolves credentials and calls fn with a fresh mock provider
vi.mock('../../src/provider/imap-pool.js', () => ({
  ImapConnectionPool: vi.fn().mockImplementation(function () {
    return {
      withConnection: vi.fn(async (_: string, fn: (imap: any) => Promise<any>) => {
        const { ImapProvider } = await import('../../src/provider/imap.js');
        const provider = new (ImapProvider as any)();
        await provider.connect();
        return fn(provider);
      }),
      closeAll: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

const testAccount: AccountConfig = {
  id: 'test',
  email: 'test@example.com',
  imap: { host: 'imap.example.com', port: 993, tls: true },
  smtp: { host: 'smtp.example.com', port: 587, tls: true },
};

let db: Database;
let executor: Executor;
let pool: ImapConnectionPool;

beforeEach(() => {
  vi.clearAllMocks();
  db = openDatabase(':memory:');
  pool = new ImapConnectionPool({
    accounts: [testAccount],
    logger: createLogger('cli', { minLevel: 'error' }),
  });
  executor = new Executor({
    db,
    accounts: [testAccount],
    pool,
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

  it('executes with edited params when editedParams is provided', async () => {
    const intent = await executor.createGatedIntent({
      tool: 'queue_send',
      toolParams: { to: 'original@test.com', subject: 'Original Subject', body: 'Original body' },
      accountId: 'test',
      agentId: 'claude',
      risk: 'high',
    });

    const editedParams = { to: 'edited@test.com', subject: 'Edited Subject', body: 'Edited body' };
    const result = await executor.approveAndExecute(intent.id, editedParams);

    expect(result.status).toBe('executed');
    expect(result.params).toEqual(editedParams);
  });

  it('claims a pending intent exactly once under concurrent approval attempts', async () => {
    let resolveSend!: (value: { messageId: string }) => void;
    const pendingSend = new Promise<{ messageId: string }>((resolve) => {
      resolveSend = resolve;
    });
    vi.mocked(sendMail).mockReturnValueOnce(pendingSend as any);

    const intent = await executor.createGatedIntent({
      tool: 'queue_send',
      toolParams: { to: 'bob@test.com', subject: 'Hi', body: 'Hello' },
      accountId: 'test',
      agentId: 'claude',
      risk: 'high',
    });

    const firstApproval = executor.approveAndExecute(intent.id);
    await Promise.resolve();

    await expect(executor.approveAndExecute(intent.id)).rejects.toThrow(
      'not pending'
    );

    resolveSend({ messageId: 'sent-123' });
    await expect(firstApproval).resolves.toMatchObject({ status: 'executed' });
    expect(vi.mocked(sendMail)).toHaveBeenCalledTimes(1);
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

  it('decorates search_threads results with is_automated', async () => {
    const { result } = await executor.executeImmediate({
      tool: 'search_threads',
      toolParams: { query: 'hello' },
      accountId: 'test',
      agentId: 'claude',
      risk: 'none',
    });

    const parsed = JSON.parse(result[0].text);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].uid).toBe(42);
    expect(parsed.results[0].is_automated).toBe(true);
    expect(parsed.results[0].account_id).toBe('test');
    // Negative assertion — the stripped fields must NOT be present
    expect(parsed.results[0].signals).toBeUndefined();
    expect(parsed.results[0].direct_to_me).toBeUndefined();
  });
});

describe('Executor.undoIntent', () => {
  it('undoes a quarantine action', async () => {
    const { intent } = await executor.executeImmediate({
      tool: 'hold_messages',
      toolParams: {
        targets: [
          { account_id: 'test', uid: 1 },
          { account_id: 'test', uid: 2 },
        ],
      },
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

  it('prevents concurrent undo calls from executing the side effect twice', async () => {
    const { intent } = await executor.executeImmediate({
      tool: 'hold_messages',
      toolParams: {
        targets: [
          { account_id: 'test', uid: 1 },
          { account_id: 'test', uid: 2 },
        ],
      },
      accountId: 'test',
      agentId: 'claude',
      risk: 'medium',
    });

    // Start first undo — it will be in flight while the second is attempted
    const firstUndo = executor.undoIntent(intent.id);
    const secondUndo = executor.undoIntent(intent.id);

    const [first, second] = await Promise.all([firstUndo, secondUndo]);

    // Exactly one should succeed
    expect([first.success, second.success]).toContain(true);
    expect([first.success, second.success]).toContain(false);

    // The DB should reflect undone
    const undone = getIntent(db, intent.id)!;
    expect(undone.status).toBe('undone');
  });

  it('returns error for non-existent intent', async () => {
    const result = await executor.undoIntent('nonexistent');
    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
  });
});
