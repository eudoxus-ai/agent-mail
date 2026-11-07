import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrapToolHandler } from '../../src/server/middleware.js';
import { openDatabase } from '../../src/ledger/db.js';
import type { Database } from '../../src/ledger/sqlite.js';
import { createLogger } from '../../src/logger.js';
import { getIntent } from '../../src/ledger/intents.js';
import { getIntentTargets } from '../../src/ledger/intent-targets.js';
import { holdMessagesTool } from '../../src/tools/hold-messages.js';
import type { AccountConfig, PolicyConfig } from '../../src/types.js';

vi.mock('../../src/provider/credentials.js', () => ({
  resolveCredentials: vi.fn((account: any) => ({
    ...account,
    auth: { user: account.email, pass: 'pw' },
  })),
}));

const { Executor } = await import('../../src/executor/executor.js');
const { QueueWorker } = await import('../../src/daemon/worker.js');

/**
 * The whole path, across two connections to one real file.
 *
 * The MCP server writes the work down and returns; the daemon — a different
 * process, with its own connection and no shared memory — picks it up and does
 * it. Everything before this exercises one half or the other. This is the test
 * that would have caught the original bug: a bulk hold accepted, an id handed
 * back, and nothing ever performing it.
 */

const accounts: AccountConfig[] = [
  {
    id: 'icloud',
    email: 'you@icloud.com',
    imap: { host: 'h', port: 993, tls: true },
    smtp: { host: 'h', port: 587, tls: true },
  },
];

const policy: PolicyConfig = {
  tools: { hold_messages: { risk: 'medium', gate: 'ungated' } },
};

let dir: string;
let dbPath: string;
/** The MCP server's connection. */
let serverDb: Database;

const logger = createLogger('cli', { minLevel: 'error' });

function fakeImap(onMove?: () => void) {
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
    fetchEnvelopes: vi.fn(async (_m: string, uids: number[]) =>
      uids.map((uid) => ({
        uid,
        subject: `Subject ${uid}`,
        from: { address: 'alice@example.com', name: null },
      }))
    ),
    moveMessages: vi.fn(async (uids: number[]) => {
      onMove?.();
      return { uidMap: new Map(uids.map((u) => [u, u + 9000])) };
    }),
    // The middleware checks thread context before applying policy to a
    // hold_messages call, which happens before the queue is ever reached.
    hasRepliesTo: vi.fn(async () => false),
    sentMailboxes: vi.fn(async () => []),
  };
}

function executorOn(db: Database, imap: ReturnType<typeof fakeImap>) {
  return new Executor({
    db,
    accounts,
    pool: {
      withConnection: vi.fn(async (_a: string, fn: (i: unknown) => Promise<unknown>) => fn(imap)),
    } as never,
    logger,
  });
}

/** A worker on its own connection, the way the daemon has one. */
function workerOn(imap: ReturnType<typeof fakeImap>, workerId: string) {
  const db = openDatabase(dbPath);
  return {
    db,
    worker: new QueueWorker({
      db,
      executor: executorOn(db, imap),
      logger,
      leaseMs: 600_000,
      operationTimeoutMs: 300_000,
      workerId,
    }),
  };
}

async function fileHold(uid: number) {
  const handler = wrapToolHandler(holdMessagesTool as never, {
    db: serverDb,
    executor: executorOn(serverDb, fakeImap()) as never,
    policy,
    accounts,
    logger,
    agentId: 'test-agent',
  });
  const result = (await handler({
    targets: [{ account_id: 'icloud', uid, mailbox: 'INBOX' }],
    include_summary: false,
    background: true,
  })) as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-mail-e2e-'));
  dbPath = join(dir, 'ledger.db');
  serverDb = openDatabase(dbPath);
});

afterEach(() => {
  serverDb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('accepted work reaches the daemon', () => {
  it('is queued by the server and performed by the worker', async () => {
    const payload = await fileHold(101);

    expect(payload.status).toBe('queued');
    expect(payload.intent_id).toBeTruthy();
    // Filed, and honest about the fact that nothing is running it yet.
    expect(payload.daemon_running).toBe(false);

    // Nothing has touched IMAP at this point — that is the contract.
    expect(getIntent(serverDb, payload.intent_id)!.status).toBe('queued');

    const imap = fakeImap();
    const { db, worker } = workerOn(imap, 'daemon-1');
    await worker.tick();
    await worker.drain();

    const intent = getIntent(serverDb, payload.intent_id)!;
    expect(intent.status).toBe('executed');
    expect(imap.moveMessages).toHaveBeenCalledWith([101], 'INBOX', 'agent-mail-holding');

    // And the record needed to undo it survived the handoff between processes.
    const targets = getIntentTargets(serverDb, payload.intent_id);
    expect(targets).toHaveLength(1);
    expect(targets[0].destination_uid).toBe(9101);
    expect(targets[0].uidvalidity).toBe(42);

    db.close();
  });

  it('finishes a batch a restarted daemon inherits', async () => {
    // Five holds filed in one go — the shape that used to be refused outright,
    // and that a restart used to lose.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await fileHold(100 + i)).intent_id);
    }
    expect(new Set(ids).size).toBe(5);

    // A daemon starts, does one job, and dies mid-batch.
    const firstImap = fakeImap();
    const first = workerOn(firstImap, 'daemon-before-restart');
    await first.worker.tick();
    await first.worker.drain();
    first.db.close();

    const doneAfterFirst = ids.filter(
      (id) => getIntent(serverDb, id)!.status === 'executed'
    ).length;
    // Per-account serialization means one at a time for a single account.
    expect(doneAfterFirst).toBe(1);
    expect(doneAfterFirst).toBeLessThan(5);

    // A fresh daemon on a fresh connection, sharing nothing but the file.
    const second = workerOn(fakeImap(), 'daemon-after-restart');
    for (let i = 0; i < 10; i++) {
      await second.worker.tick();
      await second.worker.drain();
    }

    const statuses = ids.map((id) => getIntent(serverDb, id)!.status);
    expect(statuses).toEqual(Array(5).fill('executed'));

    second.db.close();
  });

  it('loses nothing when the daemon never starts', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await fileHold(200 + i)).intent_id);
    }

    // The old failure: work accepted, nothing running, and after a restart the
    // intents read `executing` forever with no way to tell them from slow ones.
    // They now sit at `queued`, which is a state a later daemon can act on.
    const later = openDatabase(dbPath);
    expect(
      (later.prepare(`SELECT COUNT(*) AS n FROM intents WHERE status = 'queued'`).get() as {
        n: number;
      }).n
    ).toBe(5);

    const { db, worker } = workerOn(fakeImap(), 'daemon-eventually');
    for (let i = 0; i < 10; i++) {
      await worker.tick();
      await worker.drain();
    }

    expect(ids.every((id) => getIntent(serverDb, id)!.status === 'executed')).toBe(true);

    later.close();
    db.close();
  });

  it('reports the queue as draining once a worker is live', async () => {
    const { db, worker } = workerOn(fakeImap(), 'daemon-live');
    worker.start();
    try {
      const payload = await fileHold(301);
      // The server reads the daemon's heartbeat across the file, which is the
      // only channel the two share.
      expect(payload.daemon_running).toBe(true);
      expect(payload.warning).toBeUndefined();
    } finally {
      await worker.stop();
      db.close();
    }
  });
});
