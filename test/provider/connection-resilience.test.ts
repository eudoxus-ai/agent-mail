import { describe, it, expect } from 'vitest';
import { ImapProvider } from '../../src/provider/imap.js';
import { isConnectionDropError } from '../../src/provider/imap-pool.js';
import type { ResolvedAccount } from '../../src/types.js';

/**
 * Regression coverage for the ECONNRESET crash.
 *
 * ImapFlow is an EventEmitter, and Node throws on an 'error' event with no
 * listener — an uncaught exception that killed the whole MCP server. Idle
 * pooled connections get reset routinely, asynchronously, outside any awaited
 * call, so no try/catch around a tool invocation could catch it. The client saw
 * a request that never returned; work already committed to IMAP stayed
 * committed with no response and no intent id.
 */

const account: ResolvedAccount = {
  id: 'test',
  email: 'you@example.com',
  imap: { host: 'imap.example.com', port: 993, tls: true },
  smtp: { host: 'smtp.example.com', port: 587, tls: true },
  auth: { user: 'you@example.com', pass: 'secret' },
};

/** The constructor does not connect, so this is safe with no server. */
function provider(options?: { onError?: (e: Error) => void }) {
  const p = new ImapProvider(account, options);
  // The ImapFlow client is private; reaching in is the point of the test.
  const client = (p as unknown as { client: NodeJS.EventEmitter }).client;
  return { p, client };
}

describe('async socket errors', () => {
  it('registers an error listener so the process cannot be killed by one', () => {
    const { client } = provider();
    expect(client.listenerCount('error')).toBeGreaterThan(0);
  });

  it('does not throw when the socket resets', () => {
    const { client } = provider();
    const reset = Object.assign(new Error('read ECONNRESET'), {
      code: 'ECONNRESET',
      errno: -54,
      syscall: 'read',
    });

    // Before the fix this emit threw, and the throw reached the top level.
    expect(() => client.emit('error', reset)).not.toThrow();
  });

  it('marks the connection dead so the pool stops reusing it', () => {
    const { p, client } = provider();
    expect(p.isDead()).toBe(false);

    client.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));

    expect(p.isDead()).toBe(true);
    expect(p.getLastError()?.message).toBe('read ECONNRESET');
  });

  it('treats a clean close as unusable too', () => {
    const { p, client } = provider();
    client.emit('close');
    expect(p.isDead()).toBe(true);
  });

  it('notifies the owner so the pool can log it', () => {
    const seen: Error[] = [];
    const { client } = provider({ onError: (e) => seen.push(e) });

    client.emit('error', new Error('boom'));

    expect(seen).toHaveLength(1);
    expect(seen[0].message).toBe('boom');
  });

  it('survives repeated errors on the same connection', () => {
    const { p, client } = provider();
    expect(() => {
      client.emit('error', new Error('first'));
      client.emit('error', new Error('second'));
    }).not.toThrow();
    expect(p.getLastError()?.message).toBe('second');
  });
});

describe('isConnectionDropError', () => {
  it('recognizes ECONNRESET by code', () => {
    // The message "read ECONNRESET" matches none of the original text
    // patterns, so this was previously treated as a fatal application error
    // and the reconnect-once path never ran.
    const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(isConnectionDropError(err)).toBe(true);
  });

  it('recognizes other socket-level codes', () => {
    for (const code of ['EPIPE', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTCONN']) {
      const err = Object.assign(new Error('socket died'), { code });
      expect(isConnectionDropError(err), code).toBe(true);
    }
  });

  it('still recognizes the original message patterns', () => {
    expect(isConnectionDropError(new Error('socket closed unexpectedly'))).toBe(true);
    expect(isConnectionDropError(new Error('connection reset by peer'))).toBe(true);
    expect(isConnectionDropError(new Error('* BYE Logging out'))).toBe(true);
    expect(
      isConnectionDropError(Object.assign(new Error('x'), { code: 'NoConnection' }))
    ).toBe(true);
  });

  it('does not treat application errors as connection drops', () => {
    // These must still propagate — retrying them would silently repeat a
    // mutation or mask a real bug.
    expect(isConnectionDropError(new Error('Mailbox does not exist'))).toBe(false);
    expect(isConnectionDropError(new Error('Invalid credentials'))).toBe(false);
    expect(isConnectionDropError('not an error')).toBe(false);
    expect(isConnectionDropError(null)).toBe(false);
  });
});
