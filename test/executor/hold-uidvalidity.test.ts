import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import type { Database } from '../../src/ledger/sqlite.js';
import { createLogger } from '../../src/logger.js';
import { getIntentTargets } from '../../src/ledger/intent-targets.js';
import type { AccountConfig } from '../../src/types.js';

vi.mock('../../src/provider/credentials.js', () => ({
  resolveCredentials: vi.fn((account: any) => ({
    ...account,
    auth: { user: account.email, pass: 'pw' },
  })),
}));

const { Executor } = await import('../../src/executor/executor.js');

/**
 * A hold must record the generation each UID was captured in.
 *
 * Without it the ledger has no way to tell, at replay time, whether the
 * recorded UIDs still identify the messages the user selected.
 */

const accounts: AccountConfig[] = [
  {
    id: 'icloud',
    email: 'you@icloud.com',
    imap: { host: 'h', port: 993, tls: true },
    smtp: { host: 'h', port: 587, tls: true },
  },
];

let db: Database;

/** UIDVALIDITY differs per mailbox, so the stub keys on it. */
const GENERATIONS: Record<string, number> = { INBOX: 42, Archive: 7 };

function fakeImap() {
  return {
    getMailboxPath: vi.fn(async () => 'agent-mail-holding'),
    mailboxSnapshot: vi.fn(async (mailbox: string) => ({
      uidValidity: GENERATIONS[mailbox] ?? 1,
      uidNext: 1000,
      highestModseq: 10,
      exists: 5,
    })),
    fetchEnvelopes: vi.fn(async (mailbox: string, uids: number[]) =>
      uids.map((uid) => ({
        uid,
        subject: `Subject ${uid}`,
        from: { address: 'alice@example.com', name: null },
      }))
    ),
    moveMessages: vi.fn(async (uids: number[]) => ({
      uidMap: new Map(uids.map((u) => [u, u + 9000])),
    })),
  };
}

function makeExecutor(imap: ReturnType<typeof fakeImap>) {
  const pool = {
    withConnection: vi.fn(async (_accountId: string, fn: (i: unknown) => Promise<unknown>) =>
      fn(imap)
    ),
  };
  return new Executor({
    db,
    accounts,
    pool: pool as never,
    logger: createLogger('cli', { minLevel: 'error' }),
  });
}

beforeEach(() => {
  db = openDatabase(':memory:');
});

describe('hold records the mailbox generation', () => {
  it('stamps UIDVALIDITY on every target', async () => {
    const imap = fakeImap();
    const executor = makeExecutor(imap);

    const { intent } = await executor.executeImmediate({
      tool: 'hold_messages',
      toolParams: {
        targets: [{ account_id: 'icloud', uid: 101, mailbox: 'INBOX' }],
        include_summary: false,
      },
      accountId: 'icloud',
      agentId: 'test',
      risk: 'medium',
    });

    const targets = getIntentTargets(db, intent.id);
    expect(targets).toHaveLength(1);
    expect(targets[0].uidvalidity).toBe(42);
  });

  it('stamps the right generation per mailbox in a mixed hold', async () => {
    const imap = fakeImap();
    const executor = makeExecutor(imap);

    const { intent } = await executor.executeImmediate({
      tool: 'hold_messages',
      toolParams: {
        targets: [
          { account_id: 'icloud', uid: 101, mailbox: 'INBOX' },
          { account_id: 'icloud', uid: 101, mailbox: 'Archive' },
        ],
        include_summary: false,
      },
      accountId: 'icloud',
      agentId: 'test',
      risk: 'medium',
    });

    const targets = getIntentTargets(db, intent.id);
    // Same UID, two mailboxes, two different generations. Stamping one
    // mailbox's generation onto the other would make the guard actively wrong.
    expect(targets.find((t) => t.mailbox === 'INBOX')!.uidvalidity).toBe(42);
    expect(targets.find((t) => t.mailbox === 'Archive')!.uidvalidity).toBe(7);
  });

  it('records nothing on a dry run', async () => {
    const imap = fakeImap();
    const executor = makeExecutor(imap);

    const { intent } = await executor.executeImmediate({
      tool: 'hold_messages',
      toolParams: {
        targets: [{ account_id: 'icloud', uid: 101, mailbox: 'INBOX' }],
        dry_run: true,
      },
      accountId: 'icloud',
      agentId: 'test',
      risk: 'medium',
    });

    expect(getIntentTargets(db, intent.id)).toHaveLength(0);
    expect(imap.moveMessages).not.toHaveBeenCalled();
  });
});
