import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { AccountConfig } from '../../src/types.js';
import { createLogger } from '../../src/logger.js';

// Track the ImapProvider instances created and control their behavior
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
      // The pool checks these before reusing a pooled connection; a socket
      // that died asynchronously must not be handed out again.
      isDead: vi.fn(function (this: typeof inst) { return this.dead; }),
      // Teardown always destroys the socket, so a hung LOGOUT cannot leave an
      // orphaned connection behind.
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

import { ImapConnectionPool } from '../../src/provider/imap-pool.js';

const account: AccountConfig = {
  id: 'test',
  email: 'test@example.com',
  imap: { host: 'imap.example.com', port: 993, tls: true },
  smtp: { host: 'smtp.example.com', port: 587, tls: true },
};

let pool: ImapConnectionPool;

beforeEach(() => {
  instances.length = 0;
  pool = new ImapConnectionPool({
    accounts: [account],
    logger: createLogger('cli', { minLevel: 'error' }),
  });
});

afterEach(async () => {
  await pool.closeAll();
});

describe('ImapConnectionPool', () => {
  it('lazily connects on first borrow', async () => {
    expect(instances).toHaveLength(0);
    await pool.withConnection('test', async () => 'ok');
    expect(instances).toHaveLength(1);
    expect(instances[0].connect).toHaveBeenCalledTimes(1);
  });

  it('reuses the same connection on subsequent borrows', async () => {
    await pool.withConnection('test', async () => 'a');
    await pool.withConnection('test', async () => 'b');
    expect(instances).toHaveLength(1);
    expect(instances[0].connect).toHaveBeenCalledTimes(1);
  });

  it('replaces a connection that died between borrows', async () => {
    // The ECONNRESET case: the socket dies asynchronously while the pool is
    // idle, so no in-flight call fails and nothing tears the entry down. The
    // next borrow must notice and reconnect rather than hand out a dead client.
    await pool.withConnection('test', async () => 'first');
    expect(instances).toHaveLength(1);

    instances[0].dead = true;

    const result = await pool.withConnection('test', async () => 'second');

    expect(result).toBe('second');
    expect(instances).toHaveLength(2);
    expect(instances[0].disconnect).toHaveBeenCalled();
    expect(instances[1].connect).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent borrows on the same account', async () => {
    const events: string[] = [];
    const a = pool.withConnection('test', async () => {
      events.push('a-start');
      await new Promise((r) => setTimeout(r, 20));
      events.push('a-end');
    });
    const b = pool.withConnection('test', async () => {
      events.push('b-start');
      events.push('b-end');
    });
    await Promise.all([a, b]);
    expect(events).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('reconnects and retries once after a connection-drop error', async () => {
    let callCount = 0;
    const result = await pool.withConnection('test', async () => {
      callCount++;
      if (callCount === 1) {
        const err = new Error('socket closed') as Error & { code?: string };
        err.code = 'NoConnection';
        throw err;
      }
      return 'success';
    });
    expect(result).toBe('success');
    expect(callCount).toBe(2);
    // Old instance was torn down, new one created
    expect(instances.length).toBeGreaterThanOrEqual(2);
  });

  it('propagates the error when the retry also fails', async () => {
    const err = () => {
      const e = new Error('socket closed') as Error & { code?: string };
      e.code = 'NoConnection';
      return e;
    };
    await expect(
      pool.withConnection('test', async () => {
        throw err();
      })
    ).rejects.toThrow('socket closed');
  });

  it('does not retry non-connection errors', async () => {
    let callCount = 0;
    await expect(
      pool.withConnection('test', async () => {
        callCount++;
        throw new Error('some business logic error');
      })
    ).rejects.toThrow('some business logic error');
    expect(callCount).toBe(1);
  });

  it('closeAll disconnects every live connection', async () => {
    await pool.withConnection('test', async () => 'ok');
    expect(instances[0].connected).toBe(true);
    await pool.closeAll();
    expect(instances[0].disconnect).toHaveBeenCalled();
  });

  it('throws for unknown account', async () => {
    await expect(
      pool.withConnection('nope', async () => 'x')
    ).rejects.toThrow(/nope/i);
  });
});
