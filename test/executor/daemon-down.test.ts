import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import type { Database } from '../../src/ledger/sqlite.js';
import { createLogger } from '../../src/logger.js';
import { recordWorkerHeartbeat } from '../../src/ledger/worker-heartbeat.js';
import { describeWorkerState } from '../../src/ledger/worker-heartbeat.js';
import type { AccountConfig } from '../../src/types.js';

vi.mock('../../src/provider/credentials.js', () => ({
  resolveCredentials: vi.fn((account: any) => ({
    ...account,
    auth: { user: account.email, pass: 'pw' },
  })),
}));

const { Executor } = await import('../../src/executor/executor.js');

/**
 * The bar: a user must never believe they filed fifty holds and have filed
 * none.
 *
 * Once the daemon is the only thing that drains the queue, its absence is
 * silent by construction — the MCP server accepts the work, writes it down,
 * and returns an id, all of which look exactly the same whether or not
 * anything is going to pick it up. Every surface that can be asked "what
 * happened to my work?" has to answer that question.
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

function makeExecutor() {
  return new Executor({
    db,
    accounts,
    pool: {
      withConnection: vi.fn(),
      diagnostics: () => ({
        opened: 1,
        closed: 0,
        live: 1,
        operation_timeout_ms: 300_000,
        accounts: [],
      }),
      stats: () => ({ opened: 1, closed: 0, live: 1 }),
    } as never,
    logger: createLogger('cli', { minLevel: 'error' }),
  });
}

function enqueue(id: string, ageSeconds = 0): void {
  db.prepare(
    `INSERT INTO intents (id, account_id, tool, params, risk, status, created_at)
     VALUES (?, 'icloud', 'hold_by_sender', '{}', 'medium', 'queued', ?)`
  ).run(id, new Date(Date.now() - ageSeconds * 1000).toISOString());
}

function alive(): void {
  recordWorkerHeartbeat(db, { workerId: 'worker-1', pid: 999 });
}

async function call(tool: string, params: Record<string, unknown> = {}) {
  const { result } = await makeExecutor().executeImmediate({
    tool,
    toolParams: params,
    accountId: 'icloud',
    agentId: 'test',
    risk: 'none',
  });
  return JSON.parse(result[0].text);
}

beforeEach(() => {
  db = openDatabase(':memory:');
});

describe('describeWorkerState', () => {
  it('says nothing is running when nothing ever has', () => {
    const state = describeWorkerState(db);
    expect(state.alive).toBe(false);
    expect(state.worker_id).toBeNull();
    expect(state.warning).toBeTruthy();
    // A warning that does not say what to do is just noise on an error path.
    expect(state.warning).toContain('install-daemon');
  });

  it('is quiet when a worker is beating', () => {
    alive();
    const state = describeWorkerState(db);
    expect(state.alive).toBe(true);
    expect(state.warning).toBeUndefined();
    expect(state.worker_id).toBe('worker-1');
    expect(state.pid).toBe(999);
  });

  it('counts the queue and ages the oldest job', () => {
    enqueue('a', 120);
    enqueue('b', 30);

    const state = describeWorkerState(db);
    expect(state.queued_count).toBe(2);
    // The age is the number that tells a user how long they have been waiting
    // on nothing.
    expect(state.oldest_queued_age_seconds).toBeGreaterThanOrEqual(115);
  });

  it('spells out the consequence when work is actually waiting', () => {
    enqueue('a', 60);
    const state = describeWorkerState(db);
    expect(state.warning).toMatch(/1 /);
    expect(state.warning).toContain('install-daemon');
  });

  it('ages the oldest job whichever timestamp format it was written in', () => {
    // `created_at` is text in two shapes: SQLite's `YYYY-MM-DD HH:MM:SS` from
    // the column default, and ISO strings from anything that sets it. A string
    // comparison sorts the space before the `T`, so a SQL MIN would pick the
    // newer row purely on format and report the queue as brand new.
    // The order matters here. With the old row in SQLite's format a string MIN
    // gets the right answer by luck, because the space sorts first anyway — so
    // the case that catches it is the old row in ISO and the new one in the
    // default format.
    enqueue('old-iso', 600);
    db.prepare(
      `INSERT INTO intents (id, account_id, tool, params, risk, status)
       VALUES ('new-default', 'gmail', 'hold_by_sender', '{}', 'medium', 'queued')`
    ).run();

    const state = describeWorkerState(db);
    expect(state.queued_count).toBe(2);
    expect(state.oldest_queued_age_seconds).toBeGreaterThanOrEqual(595);
  });

  it('ages correctly with the formats the other way round too', () => {
    db.prepare(
      `INSERT INTO intents (id, account_id, tool, params, risk, status, created_at)
       VALUES ('old-default', 'icloud', 'hold_by_sender', '{}', 'medium', 'queued',
               datetime('now', '-600 seconds'))`
    ).run();
    enqueue('new-iso', 5);

    expect(describeWorkerState(db).oldest_queued_age_seconds).toBeGreaterThanOrEqual(595);
  });

  it('reads the SQLite default timestamp as UTC', () => {
    // The default has no zone marker. Parsing it as local time makes every age
    // wrong by the machine's offset — hours out, in either direction.
    db.prepare(
      `INSERT INTO intents (id, account_id, tool, params, risk, status)
       VALUES ('a', 'icloud', 'hold_by_sender', '{}', 'medium', 'queued')`
    ).run();

    expect(describeWorkerState(db).oldest_queued_age_seconds).toBeLessThan(60);
  });

  it('does not count finished work as waiting', () => {
    db.prepare(
      `INSERT INTO intents (id, account_id, tool, params, risk, status)
       VALUES ('done', 'icloud', 'hold_by_sender', '{}', 'medium', 'executed')`
    ).run();
    expect(describeWorkerState(db).queued_count).toBe(0);
    expect(describeWorkerState(db).oldest_queued_age_seconds).toBeNull();
  });
});

describe('get_intent on queued work', () => {
  it('says the daemon is down', async () => {
    enqueue('a');
    const payload = await call('get_intent', { intent_id: 'a' });

    expect(payload.status).toBe('queued');
    expect(payload.daemon_running).toBe(false);
    expect(payload.warning).toContain('install-daemon');
  });

  it('says nothing when a worker is running', async () => {
    enqueue('a');
    alive();
    const payload = await call('get_intent', { intent_id: 'a' });

    expect(payload.daemon_running).toBe(true);
    expect(payload.warning).toBeUndefined();
  });

  it('leaves finished intents alone', async () => {
    db.prepare(
      `INSERT INTO intents (id, account_id, tool, params, risk, status)
       VALUES ('done', 'icloud', 'hold_by_sender', '{}', 'medium', 'executed')`
    ).run();

    const payload = await call('get_intent', { intent_id: 'done' });

    // The daemon being down is irrelevant to work that already happened, and
    // a warning here would train the reader to ignore it.
    expect(payload.daemon_running).toBeUndefined();
    expect(payload.warning).toBeUndefined();
  });
});

describe('get_diagnostics', () => {
  it('leads with worker liveness and the queue', async () => {
    enqueue('a', 90);
    const payload = await call('get_diagnostics');

    expect(payload.worker.alive).toBe(false);
    expect(payload.worker.queued_count).toBe(1);
    expect(payload.worker.oldest_queued_age_seconds).toBeGreaterThanOrEqual(85);

    // First key in the object: this is the thing to check before anything else
    // in here, and burying it under connection stats is how it gets missed.
    expect(Object.keys(payload)[0]).toBe('worker');
  });

  it('names the stopped worker as the cause in the interpretation', async () => {
    enqueue('a', 90);
    const payload = await call('get_diagnostics');

    // The interpretation is the line people actually read.
    expect(payload.interpretation).toMatch(/worker|daemon/i);
    expect(payload.interpretation).toContain('install-daemon');
  });

  it('does not blame the worker when one is running', async () => {
    enqueue('a', 90);
    alive();
    const payload = await call('get_diagnostics');

    expect(payload.worker.alive).toBe(true);
    expect(payload.interpretation).not.toContain('install-daemon');
  });

  it('does not blame the worker when nothing is queued', async () => {
    const payload = await call('get_diagnostics');

    // A stopped daemon with an empty queue is worth reporting, but it is not
    // the explanation for anything, and claiming otherwise sends people
    // chasing it whenever they read this.
    expect(payload.worker.alive).toBe(false);
    expect(payload.interpretation).not.toContain('install-daemon');
  });
});
