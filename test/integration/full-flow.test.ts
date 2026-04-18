import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Database } from '../../src/ledger/sqlite.js';
import { openDatabase } from '../../src/ledger/db.js';
import { getPendingIntents, getIntent } from '../../src/ledger/intents.js';
import { getAuditLog } from '../../src/ledger/audit.js';
import { Executor } from '../../src/executor/executor.js';
import { ImapConnectionPool } from '../../src/provider/imap-pool.js';
import { createLogger } from '../../src/logger.js';
import type { AccountConfig } from '../../src/types.js';

// Mock IMAP/SMTP
vi.mock('../../src/provider/imap.js', () => ({
  ImapProvider: vi.fn().mockImplementation(function () { return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([
      { uid: 1, envelope: { subject: 'Test email', from: { address: 'alice@test.com', name: 'Alice' }, date: '2026-04-10' }, snippet: 'Hello world', flags: [] },
      { uid: 2, envelope: { subject: 'Newsletter', from: { address: 'news@spam.com', name: null }, date: '2026-04-10' }, snippet: 'Unsubscribe', flags: [] },
    ]),
    fetchMessage: vi.fn().mockResolvedValue({
      uid: 1, messageId: 'msg-1@test.com', from: 'alice@test.com', to: ['bob@test.com'],
      cc: [], date: '2026-04-10', subject: 'Test', bodyText: 'Hello', references: [], flags: [], mailbox: 'INBOX',
    }),
    createDraft: vi.fn().mockResolvedValue({ uid: 42 }),
    moveMessages: vi.fn().mockResolvedValue(undefined),
    setFlags: vi.fn().mockResolvedValue(undefined),
    removeFlags: vi.fn().mockResolvedValue(undefined),
    getMailboxPath: vi.fn().mockResolvedValue('agent-mail-quarantine'),
    ensureMailbox: vi.fn().mockResolvedValue(undefined),
  }; }),
}));

vi.mock('../../src/provider/smtp.js', () => ({
  createSmtpTransport: vi.fn().mockReturnValue({}),
  sendMail: vi.fn().mockResolvedValue({ messageId: 'sent-456' }),
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
  id: 'gmail',
  email: 'cameron@gmail.com',
  imap: { host: 'imap.gmail.com', port: 993, tls: true },
  smtp: { host: 'smtp.gmail.com', port: 587, tls: true },
};

let db: Database;
let executor: Executor;
let pool: ImapConnectionPool;

beforeEach(() => {
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

describe('Full E2E flow: triage, draft, queue, approve', () => {
  it('completes a full email workflow', async () => {
    // 1. Search threads (ungated, immediate)
    const searchResult = await executor.executeImmediate({
      tool: 'search_threads',
      toolParams: { query: 'test', mailbox: 'INBOX' },
      accountId: 'gmail',
      agentId: 'claude',
      risk: 'none',
    });
    expect(searchResult.intent.status).toBe('executed');
    expect(searchResult.result.length).toBeGreaterThan(0);

    // 2. Draft a reply (ungated, immediate)
    const draftResult = await executor.executeImmediate({
      tool: 'draft_reply',
      toolParams: { to: 'alice@test.com', subject: 'Re: Test', body: 'Thanks!' },
      accountId: 'gmail',
      agentId: 'claude',
      risk: 'low',
    });
    expect(draftResult.intent.status).toBe('executed');

    // 3. Queue send (gated, creates pending intent)
    const sendIntent = await executor.createGatedIntent({
      tool: 'queue_send',
      toolParams: { to: 'alice@test.com', subject: 'Re: Test', body: 'Thanks!' },
      accountId: 'gmail',
      agentId: 'claude',
      risk: 'high',
    });
    expect(sendIntent.status).toBe('pending');

    // 4. Check pending actions
    const pending = getPendingIntents(db);
    expect(pending).toHaveLength(1);
    expect(pending[0].tool).toBe('queue_send');

    // 5. Approve the send (simulates reviewer UI)
    const approved = await executor.approveAndExecute(sendIntent.id);
    expect(approved.status).toBe('executed');

    // 6. Verify no more pending actions
    expect(getPendingIntents(db)).toHaveLength(0);

    // 7. Check audit trail
    const audit = getAuditLog(db);
    expect(audit.length).toBeGreaterThanOrEqual(6); // multiple entries across all actions
    const actions = audit.map(a => a.action);
    expect(actions).toContain('created');
    expect(actions).toContain('approved');
    expect(actions).toContain('executed');
  });

  it('rejects a queued send', async () => {
    const sendIntent = await executor.createGatedIntent({
      tool: 'queue_send',
      toolParams: { to: 'spam@evil.com', subject: 'Bad', body: 'No' },
      accountId: 'gmail',
      agentId: 'claude',
      risk: 'high',
    });

    const rejected = await executor.rejectIntent(sendIntent.id, 'Looks suspicious');
    expect(rejected.status).toBe('rejected');
    expect(getPendingIntents(db)).toHaveLength(0);
  });

  it('quarantines and undoes', async () => {
    // Quarantine (ungated when no replies)
    const quarantine = await executor.executeImmediate({
      tool: 'quarantine_thread',
      toolParams: { targets: [{ account_id: 'gmail', uid: 2 }] },
      accountId: 'gmail',
      agentId: 'claude',
      risk: 'medium',
    });
    expect(quarantine.intent.status).toBe('executed');

    // Undo quarantine
    const undoResult = await executor.undoIntent(quarantine.intent.id);
    expect(undoResult.success).toBe(true);

    const undone = getIntent(db, quarantine.intent.id)!;
    expect(undone.status).toBe('undone');
  });
});
