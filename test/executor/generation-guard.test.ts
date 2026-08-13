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
 * A replay must refuse to act on UIDs from a generation that no longer exists.
 *
 * A hold records the source UID (in its source mailbox) and the destination UID
 * (in the holding mailbox). Every replay path moves the *destination* UID back
 * out of holding — so the generation that matters at replay time is holding's,
 * not the source mailbox's. If the server reassigns UIDs in holding between the
 * hold and the restore, the recorded destination UID now names some other
 * message, and moving it puts mail the user never touched into their inbox.
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
/** Mutable so a test can simulate the server reassigning UIDs mid-flight. */
let generations: Record<string, number>;

const HOLDING = 'agent-mail-holding';

function fakeImap() {
  return {
    getMailboxPath: vi.fn(async (kind: string) =>
      kind === 'holding' ? HOLDING : 'INBOX'
    ),
    mailboxSnapshot: vi.fn(async (mailbox: string) => ({
      uidValidity: generations[mailbox] ?? 1,
      uidNext: 1000,
      highestModseq: 10,
      exists: 5,
    })),
    fetchEnvelopes: vi.fn(async (_mailbox: string, uids: number[]) =>
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

/** Hold one message out of INBOX, leaving a restorable ledger record. */
async function holdOne(imap: ReturnType<typeof fakeImap>) {
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
  return intent;
}

async function restoreOne(imap: ReturnType<typeof fakeImap>) {
  const executor = makeExecutor(imap);
  const { result } = await executor.executeImmediate({
    tool: 'restore_messages',
    toolParams: {
      targets: [{ account_id: 'icloud', uid: 101, mailbox: 'INBOX' }],
    },
    accountId: 'icloud',
    agentId: 'test',
    risk: 'medium',
  });
  return JSON.parse(result[0].text) as {
    moved: Array<{ uid: number }>;
    errors: Array<{ uid: number; reason: string }>;
  };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  generations = { INBOX: 42, [HOLDING]: 7 };
});

describe('replay refuses a stale generation', () => {
  it('records the holding generation alongside the destination UID', async () => {
    const imap = fakeImap();
    const intent = await holdOne(imap);

    // The destination UID lives in holding, so it is holding's generation that
    // makes it meaningful — recording only the source mailbox's would leave
    // every restore unguarded.
    const [target] = getIntentTargets(db, intent.id);
    expect(target.destination_uid).toBe(9101);
    expect(target.destination_uidvalidity).toBe(7);
  });

  it('refuses to restore across a generation change, and moves nothing', async () => {
    const holdImap = fakeImap();
    await holdOne(holdImap);

    // The server rebuilt the holding mailbox. UID 9101 is now some other
    // message — or nothing at all.
    generations[HOLDING] = 8;

    const restoreImap = fakeImap();
    const payload = await restoreOne(restoreImap);

    expect(payload.moved).toHaveLength(0);
    expect(payload.errors).toHaveLength(1);
    expect(payload.errors[0].uid).toBe(101);
    expect(payload.errors[0].reason).toMatch(/uidvalidity/i);
    // The reason has to name both generations or it is not actionable.
    expect(payload.errors[0].reason).toContain('7');
    expect(payload.errors[0].reason).toContain('8');
    expect(restoreImap.moveMessages).not.toHaveBeenCalled();
  });

  it('restores normally when the generation still matches', async () => {
    const holdImap = fakeImap();
    await holdOne(holdImap);

    const restoreImap = fakeImap();
    const payload = await restoreOne(restoreImap);

    expect(payload.errors).toHaveLength(0);
    expect(payload.moved).toHaveLength(1);
    expect(restoreImap.moveMessages).toHaveBeenCalledWith([9101], HOLDING, 'INBOX');
  });

  it('allows a pre-migration target through, with a warning', async () => {
    const holdImap = fakeImap();
    const intent = await holdOne(holdImap);

    // Rows written before the generation column existed have no generation.
    // Refusing them would break undo for everything already in the ledger, so
    // they are allowed through and the fact is logged.
    db.prepare(`UPDATE intent_targets SET destination_uidvalidity = NULL WHERE intent_id = ?`)
      .run(intent.id);
    generations[HOLDING] = 8;

    const warn = vi.fn();
    const logger = createLogger('cli', { minLevel: 'error' });
    logger.warn = warn;

    const restoreImap = fakeImap();
    const pool = {
      withConnection: vi.fn(
        async (_a: string, fn: (i: unknown) => Promise<unknown>) => fn(restoreImap)
      ),
    };
    const executor = new Executor({
      db,
      accounts,
      pool: pool as never,
      logger,
    });
    const { result } = await executor.executeImmediate({
      tool: 'restore_messages',
      toolParams: { targets: [{ account_id: 'icloud', uid: 101, mailbox: 'INBOX' }] },
      accountId: 'icloud',
      agentId: 'test',
      risk: 'medium',
    });
    const payload = JSON.parse(result[0].text);

    expect(payload.errors).toHaveLength(0);
    expect(payload.moved).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
  });

  it('refuses the hold undo across a generation change', async () => {
    const holdImap = fakeImap();
    const intent = await holdOne(holdImap);

    generations[HOLDING] = 8;

    const undoImap = fakeImap();
    const executor = makeExecutor(undoImap);
    const outcome = await executor.undoIntent(intent.id);

    // Undo is all-or-nothing: a mismatch fails the whole operation rather than
    // silently putting the wrong message back.
    expect(outcome.success).toBe(false);
    expect(outcome.message).toMatch(/uidvalidity/i);
    expect(undoImap.moveMessages).not.toHaveBeenCalled();
  });
});
