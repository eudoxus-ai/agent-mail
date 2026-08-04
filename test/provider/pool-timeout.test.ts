import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { AccountConfig } from '../../src/types.js';
import { createLogger } from '../../src/logger.js';

/**
 * A hung IMAP operation must not wedge an account forever.
 *
 * Borrows are serialized per account, so an operation that never settles means
 * every later call queues behind it and waits indefinitely — the server stays
 * alive and healthy while becoming permanently unable to answer anything about
 * that account. A provider can cause this by accepting a command and going
 * silent: no FIN, no RST, nothing for any error handler to catch.
 */

const instances: Array<{
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  noop: ReturnType<typeof vi.fn>;
  isDead: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  getLastError: ReturnType<typeof vi.fn>;
  connected: boolean;
  dead: boolean;
}> = [];

vi.mock('../../src/provider/imap.js', () => ({
  ImapProvider: vi.fn().mockImplementation(function () {
    const inst = {
      connect: vi.fn(async function (this: typeof inst) {
        this.connected = true;
        this.dead = false;
      }),
      disconnect: vi.fn(async function (this: typeof inst) { this.connected = false; }),
      noop: vi.fn().mockResolvedValue(undefined),
      isDead: vi.fn(function (this: typeof inst) { return this.dead; }),
      destroy: vi.fn(function (this: typeof inst) { this.connected = false; this.dead = true; }),
      getLastError: vi.fn().mockReturnValue(null),
      connected: false,
      dead: false,
    };
    instances.push(inst);
    return inst;
  }),
}));

vi.mock('../../src/provider/credentials.js', () => ({
  resolveCredentials: vi.fn().mockImplementation((account: any) => ({
    ...account,
    auth: { user: account.email, pass: 'pw' },
  })),
}));

const { ImapConnectionPool, ImapOperationTimeoutError } = await import(
  '../../src/provider/imap-pool.js'
);

const accounts: AccountConfig[] = [
  {
    id: 'icloud',
    email: 'you@icloud.com',
    imap: { host: 'imap.mail.me.com', port: 993, tls: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, tls: true },
  },
];

let pool: InstanceType<typeof ImapConnectionPool>;

beforeEach(() => {
  instances.length = 0;
  pool = new ImapConnectionPool({
    accounts,
    logger: createLogger('cli', { minLevel: 'error' }),
    keepaliveIntervalMs: 0,
    operationTimeoutMs: 50,
    logoutGraceMs: 5,
  });
});

afterEach(async () => {
  await pool.closeAll();
});

/** Never settles — the failure mode this exists to contain. */
const hangForever = () => new Promise<never>(() => {});

describe('operation timeout', () => {
  it('abandons a borrow that never settles', async () => {
    await expect(pool.withConnection('icloud', hangForever)).rejects.toThrow(
      ImapOperationTimeoutError
    );
  });

  it('explains what happened and what to do instead', async () => {
    const error = await pool
      .withConnection('icloud', hangForever)
      .catch((e: Error) => e);

    expect(error.message).toContain('icloud');
    expect(error.message).toContain('background: true');
  });

  it('unwedges the account so later calls still work', async () => {
    // This is the whole point: "nothing is working" was every subsequent call
    // queueing behind one hung operation.
    await expect(pool.withConnection('icloud', hangForever)).rejects.toThrow();

    const result = await pool.withConnection('icloud', async () => 'recovered');
    expect(result).toBe('recovered');
  });

  it('tears down the connection rather than reusing one mid-operation', async () => {
    await expect(pool.withConnection('icloud', hangForever)).rejects.toThrow();

    expect(instances[0].disconnect).toHaveBeenCalled();

    await pool.withConnection('icloud', async () => 'ok');
    // A fresh connection, because the old one still has a command outstanding
    // as far as the server is concerned.
    expect(instances).toHaveLength(2);
  });

  it('does not affect operations that finish in time', async () => {
    const result = await pool.withConnection('icloud', async () => 'fast');
    expect(result).toBe('fast');
    expect(instances).toHaveLength(1);
  });

  it('recovers repeatedly, not just once', async () => {
    for (let i = 0; i < 3; i += 1) {
      await expect(pool.withConnection('icloud', hangForever)).rejects.toThrow();
      expect(await pool.withConnection('icloud', async () => i)).toBe(i);
    }
  });

  it('lets a queued call proceed once the hung one is abandoned', async () => {
    const hung = pool.withConnection('icloud', hangForever);
    const queued = pool.withConnection('icloud', async () => 'second');

    await expect(hung).rejects.toThrow(ImapOperationTimeoutError);
    await expect(queued).resolves.toBe('second');
  });

  it('can be disabled with 0', async () => {
    const unbounded = new ImapConnectionPool({
      accounts,
      logger: createLogger('cli', { minLevel: 'error' }),
      keepaliveIntervalMs: 0,
      operationTimeoutMs: 0,
    });

    const result = await Promise.race([
      unbounded.withConnection('icloud', async () => 'ok'),
      new Promise((r) => setTimeout(() => r('timed-out'), 200)),
    ]);

    expect(result).toBe('ok');
    await unbounded.closeAll();
  });
});

describe('connection lifecycle accounting', () => {
  it('closes a connection for every one it opens', async () => {
    // The tell for a leak: opened climbing while closed lags behind, and live
    // exceeding the number of accounts.
    for (let i = 0; i < 5; i += 1) {
      await expect(pool.withConnection('icloud', hangForever)).rejects.toThrow();
      await pool.withConnection('icloud', async () => 'ok');
    }

    const stats = pool.stats();
    expect(stats.opened - stats.closed).toBe(stats.live);
    expect(stats.live).toBeLessThanOrEqual(accounts.length);
  });

  it('does not accumulate connections across many successful calls', async () => {
    for (let i = 0; i < 20; i += 1) {
      await pool.withConnection('icloud', async () => i);
    }

    // One pooled connection, reused — not twenty.
    expect(pool.stats().opened).toBe(1);
    expect(pool.stats().live).toBe(1);
  });

  it('destroys the socket even when a graceful logout hangs', async () => {
    await pool.withConnection('icloud', async () => 'ok');
    // A wedged connection never answers LOGOUT; teardown must not wait on it.
    instances[0].disconnect.mockImplementation(() => new Promise(() => {}));

    instances[0].dead = true;
    const result = await pool.withConnection('icloud', async () => 'recovered');

    expect(result).toBe('recovered');
    expect(instances[0].destroy).toHaveBeenCalled();
  });
});

describe('no retry after the timeout has fired', () => {
  /**
   * The timed-out work keeps running. Tearing down its provider makes it
   * reject with a connection-drop error, which runWithRetry would otherwise
   * treat as transient and retry — re-invoking the callback on a fresh
   * connection after the caller already received a timeout and the intent may
   * already be marked failed. For a move or a flag change that is a duplicate
   * mutation nobody is waiting for.
   */
  it('does not re-invoke the callback when teardown makes the work reject', async () => {
    let calls = 0;
    const started: Array<() => void> = [];

    await expect(
      pool.withConnection('icloud', async () => {
        calls += 1;
        // Rejects with a connection-drop error shortly after the timeout, the
        // way a destroyed socket does.
        return new Promise((_resolve, reject) => {
          const t = setTimeout(() => {
            const err = new Error('socket closed') as Error & { code?: string };
            err.code = 'NoConnection';
            reject(err);
          }, 80);
          started.push(() => clearTimeout(t));
        });
      })
    ).rejects.toThrow(ImapOperationTimeoutError);

    await new Promise((r) => setTimeout(r, 120));
    started.forEach((cancel) => cancel());

    // Exactly once. A second invocation would be a duplicate mutation.
    expect(calls).toBe(1);
  });

  it('still retries a connection drop when no timeout fired', async () => {
    let calls = 0;
    const result = await pool.withConnection('icloud', async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('socket closed') as Error & { code?: string };
        err.code = 'NoConnection';
        throw err;
      }
      return 'recovered';
    });

    expect(result).toBe('recovered');
    expect(calls).toBe(2);
  });
});
