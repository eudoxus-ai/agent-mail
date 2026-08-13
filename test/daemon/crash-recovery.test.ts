import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import type { Database } from '../../src/ledger/sqlite.js';
import { createLogger } from '../../src/logger.js';
import { getIntent } from '../../src/ledger/intents.js';
import { getIntentTargets } from '../../src/ledger/intent-targets.js';
import { claimNext } from '../../src/ledger/queue.js';
import type { AccountConfig } from '../../src/types.js';

vi.mock('../../src/provider/credentials.js', () => ({
  resolveCredentials: vi.fn((account: any) => ({
    ...account,
    auth: { user: account.email, pass: 'pw' },
  })),
}));

const { Executor } = await import('../../src/executor/executor.js');
const { QueueWorker } = await import('../../src/daemon/worker.js');

/**
 * The whole point of the queue, end to end, against the real executor.
 *
 * A worker that dies after claiming leaves the job `executing` with a lease
 * nobody is renewing. Nothing in memory survives to finish it — the next
 * worker has to reconstruct the job from the ledger alone. That is what makes
 * this different from the in-process path it replaces, where a restart
 * vaporized the work and left the intent reading `executing` forever.
 *
 * Deliberately not stubbed at the executor: the worker's own tests stub
 * performQueued, and a fake that drifts from the real thing is how this
 * codebase has shipped bugs past a green suite before.
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

function fakeImap() {
  return {
    getMailboxPath: vi.fn(async (kind: string) =>
      kind === 'holding' ? 'agent-mail-holding' : 'INBOX'
    ),
    mailboxSnapshot: vi.fn(async () => ({
      uidValidity: 42,
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
  return new Executor({
    db,
    accounts,
    pool: {
      withConnection: vi.fn(async (_a: string, fn: (i: unknown) => Promise<unknown>) => fn(imap)),
    } as never,
    logger: createLogger('cli', { minLevel: 'error' }),
  });
}

function makeWorker(imap: ReturnType<typeof fakeImap>, workerId: string) {
  return new QueueWorker({
    db,
    executor: makeExecutor(imap),
    logger: createLogger('cli', { minLevel: 'error' }),
    leaseMs: 600_000,
    operationTimeoutMs: 300_000,
    tickMs: 5,
    workerId,
  });
}

/** Queue a hold the way the MCP side will once Phase 5 lands. */
function enqueueHold(id: string, uid: number): void {
  db.prepare(
    `INSERT INTO intents (id, account_id, tool, params, risk, status)
     VALUES (?, 'icloud', 'hold_messages', ?, 'medium', 'queued')`
  ).run(
    id,
    JSON.stringify({
      targets: [{ account_id: 'icloud', uid, mailbox: 'INBOX' }],
      include_summary: false,
    })
  );
}

beforeEach(() => {
  db = openDatabase(':memory:');
});

describe('a job outlives the worker that claimed it', () => {
  it('is finished by the next worker, from the ledger alone', async () => {
    enqueueHold('a', 101);

    // Worker one claims it with a lease measured in milliseconds and then
    // vanishes: no heartbeat, no settle, nothing in memory to resume from.
    const claimed = claimNext(db, 'worker-that-died', 10)!;
    expect(claimed.attempts).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const imap = fakeImap();
    const worker = makeWorker(imap, 'worker-two');
    await worker.tick();
    await worker.drain();

    const intent = getIntent(db, 'a')!;
    expect(intent.status).toBe('executed');
    // Two claims: the one that died and the one that finished.
    expect(intent.attempts).toBe(2);

    // The work actually happened, reconstructed entirely from the ledger row.
    expect(imap.moveMessages).toHaveBeenCalledWith([101], 'INBOX', 'agent-mail-holding');
    const targets = getIntentTargets(db, 'a');
    expect(targets).toHaveLength(1);
    expect(targets[0].destination_uid).toBe(9101);
  });

  it('leaves nothing claimed once it settles', async () => {
    enqueueHold('a', 101);
    claimNext(db, 'worker-that-died', 10);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const worker = makeWorker(fakeImap(), 'worker-two');
    await worker.tick();
    await worker.drain();

    // A settled job still holding a lease would keep its account looking busy
    // to claimNext, and everything behind it would stall.
    const next = claimNext(db, 'worker-three', 60_000);
    expect(next).toBeNull();

    enqueueHold('b', 202);
    expect(claimNext(db, 'worker-three', 60_000)?.id).toBe('b');
  });

  it('does not take a job whose worker is still alive', async () => {
    enqueueHold('a', 101);
    claimNext(db, 'worker-one', 600_000);

    const imap = fakeImap();
    const worker = makeWorker(imap, 'worker-two');
    await worker.tick();
    await worker.drain();

    // Reclaiming a live job is the one thing worse than dropping a dead one:
    // two workers mutating the same mailbox at once.
    expect(imap.moveMessages).not.toHaveBeenCalled();
    expect(getIntent(db, 'a')!.claimed_by).toBe('worker-one');
  });

  it('finishes a backlog the first worker never got to', async () => {
    // Five accepted holds, one worker that dies after claiming the first.
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO intents (id, account_id, tool, params, risk, status, created_at)
         VALUES (?, ?, 'hold_messages', ?, 'medium', 'queued', ?)`
      ).run(
        `job-${i}`,
        `acct-${i}`,
        JSON.stringify({
          targets: [{ account_id: 'icloud', uid: 100 + i, mailbox: 'INBOX' }],
          include_summary: false,
        }),
        new Date(Date.UTC(2026, 7, 4, 12, 0, 0, i)).toISOString()
      );
    }
    // Accounts have to exist for the executor to accept the targets; the
    // account_id on the intent only decides queue ordering.
    accounts.push(
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `acct-${i}`,
        email: `a${i}@example.com`,
        imap: { host: 'h', port: 993, tls: true },
        smtp: { host: 'h', port: 587, tls: true },
      }))
    );

    claimNext(db, 'worker-that-died', 10);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const worker = makeWorker(fakeImap(), 'worker-two');
    for (let i = 0; i < 10; i++) {
      await worker.tick();
      await worker.drain();
    }

    const statuses = db
      .prepare(`SELECT id, status FROM intents ORDER BY id`)
      .all() as Array<{ id: string; status: string }>;
    expect(statuses.map((s) => s.status)).toEqual(Array(5).fill('executed'));

    // Restore the shared fixture for whatever runs next.
    accounts.length = 1;
  });
});
