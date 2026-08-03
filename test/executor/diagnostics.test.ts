import { describe, it, expect, vi } from 'vitest';
import { createLogger } from '../../src/logger.js';

// Stub the transport: these assert the pool's own bookkeeping, not IMAP.
vi.mock('../../src/provider/imap.js', () => ({
  // A `function`, not an arrow: the pool calls `new ImapProvider(...)`, and an
  // arrow function cannot be used as a constructor.
  ImapProvider: vi.fn().mockImplementation(function () {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
      noop: vi.fn().mockResolvedValue(undefined),
      isDead: vi.fn().mockReturnValue(false),
      getLastError: vi.fn().mockReturnValue(null),
    };
  }),
}));

vi.mock('../../src/provider/credentials.js', () => ({
  resolveCredentials: vi.fn((account: any) => ({
    ...account,
    auth: { user: account.email, pass: 'pw' },
  })),
}));

const { ImapConnectionPool } = await import('../../src/provider/imap-pool.js');
import { openDatabase } from '../../src/ledger/db.js';
import { createIntent, updateIntentProgress, getIntentProgress } from '../../src/ledger/intents.js';
import type { AccountConfig } from '../../src/types.js';

/**
 * Visibility into a hang.
 *
 * A background action reporting only `status: "executing"` with empty targets
 * is indistinguishable from one that was never picked up. The pool lives
 * inside the MCP server process, so no CLI can observe it — these are the
 * signals that separate "queued behind something slow" from "wedged" from
 * "the process restarted mid-flight".
 */

const accounts: AccountConfig[] = [
  {
    id: 'theaboutbox',
    email: 'a@b.com',
    imap: { host: 'h', port: 993, tls: true },
    smtp: { host: 'h', port: 587, tls: true },
  },
  {
    id: 'icloud',
    email: 'c@d.com',
    imap: { host: 'h', port: 993, tls: true },
    smtp: { host: 'h', port: 587, tls: true },
  },
];

function makePool(overrides = {}) {
  return new ImapConnectionPool({
    accounts,
    logger: createLogger('cli', { minLevel: 'error' }),
    keepaliveIntervalMs: 0,
    ...overrides,
  });
}

describe('pool diagnostics', () => {
  it('reports an idle pool with no connections', () => {
    const d = makePool().diagnostics();
    expect(d).toMatchObject({ opened: 0, closed: 0, live: 0 });
    expect(d.accounts).toEqual([]);
  });

  it('defaults the operation timeout to 5 minutes', () => {
    // Long enough for a legitimate large sweep, short enough that several
    // queued background jobs don't add up to an hour of silence.
    expect(makePool().diagnostics().operation_timeout_ms).toBe(300_000);
  });

  it('reports queue depth so a queued job is distinguishable from a stuck one', async () => {
    const pool = makePool({ operationTimeoutMs: 0 });
    let release: () => void = () => {};
    const blocked = new Promise<void>((r) => {
      release = r;
    });

    const first = pool.withConnection('icloud', async () => blocked, 'hold:move').catch(
      () => undefined
    );
    const second = pool
      .withConnection('icloud', async () => 'second', 'hold_by_sender:search')
      .catch(() => undefined);

    await new Promise((r) => setTimeout(r, 10));

    const icloud = pool.diagnostics().accounts.find((a) => a.account_id === 'icloud')!;
    // Two borrows outstanding, one running: the second is waiting on the first.
    expect(icloud.queue_depth).toBe(2);
    expect(icloud.in_flight?.label).toBe('hold:move');
    expect(icloud.in_flight?.elapsed_ms).toBeGreaterThanOrEqual(0);

    release();
    await Promise.all([first, second]);
  });

  it('names the operation in flight rather than just reporting busy', async () => {
    const pool = makePool({ operationTimeoutMs: 0 });
    let release: () => void = () => {};
    const blocked = new Promise<void>((r) => {
      release = r;
    });

    const running = pool
      .withConnection('theaboutbox', async () => blocked, 'search_threads')
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, 10));

    expect(
      pool.diagnostics().accounts.find((a) => a.account_id === 'theaboutbox')!.in_flight?.label
    ).toBe('search_threads');

    release();
    await running;
  });

  it('clears in-flight state once the borrow settles', async () => {
    const pool = makePool({ operationTimeoutMs: 0 });
    await pool.withConnection('icloud', async () => 'done', 'hold:move').catch(() => undefined);

    const icloud = pool.diagnostics().accounts.find((a) => a.account_id === 'icloud')!;
    expect(icloud.in_flight).toBeNull();
    expect(icloud.queue_depth).toBe(0);
  });
});

describe('intent progress', () => {
  it('records the phase a running action is in', () => {
    const db = openDatabase(':memory:');
    const intent = createIntent(db, {
      account_id: 'icloud',
      tool: 'hold_by_sender',
      params: { from: 'news@example.com' },
      risk: 'medium',
      agent_id: 'test',
    });

    // Before any progress, a poller sees only status + empty targets.
    expect(getIntentProgress(db, intent.id)).toBeNull();

    updateIntentProgress(db, intent.id, 'searching', {
      from: 'news@example.com',
      accounts: ['icloud'],
    });

    const progress = getIntentProgress(db, intent.id)!;
    expect(progress.phase).toBe('searching');
    expect(progress.detail).toMatchObject({ from: 'news@example.com' });
    expect(typeof progress.updated_at).toBe('string');
  });

  it('overwrites with the latest phase', () => {
    const db = openDatabase(':memory:');
    const intent = createIntent(db, {
      account_id: 'icloud',
      tool: 'hold_by_sender',
      params: {},
      risk: 'medium',
      agent_id: 'test',
    });

    updateIntentProgress(db, intent.id, 'searching');
    updateIntentProgress(db, intent.id, 'moving', { messages: 112 });

    const progress = getIntentProgress(db, intent.id)!;
    expect(progress.phase).toBe('moving');
    expect(progress.detail).toMatchObject({ messages: 112 });
  });

  it('never throws, so telemetry cannot break the action it describes', () => {
    const db = openDatabase(':memory:');
    expect(() => updateIntentProgress(db, 'no-such-intent', 'searching')).not.toThrow();
    expect(getIntentProgress(db, 'no-such-intent')).toBeNull();
  });
});
