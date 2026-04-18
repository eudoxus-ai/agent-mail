import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AccountConfig } from '../../src/types.js';

const accountImapBehavior: Record<string, any> = {};

vi.mock('../../src/provider/imap-pool.js', () => ({
  ImapConnectionPool: vi.fn().mockImplementation(function () {
    return {
      withConnection: vi.fn(async (accountId: string, fn: any) => {
        const behavior = accountImapBehavior[accountId];
        if (behavior?.throwOn === 'connect') {
          throw new Error(behavior.error ?? 'boom');
        }
        return fn(behavior?.imap ?? {});
      }),
      closeAll: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

import { ImapConnectionPool } from '../../src/provider/imap-pool.js';
import { createLogger } from '../../src/logger.js';
import { runGetOverview } from '../../src/tools/get-overview.js';

const a: AccountConfig = {
  id: 'a@x.com',
  email: 'a@x.com',
  imap: { host: 'imap.x.com', port: 993, tls: true },
  smtp: { host: 'smtp.x.com', port: 587, tls: true },
};
const b: AccountConfig = {
  id: 'b@x.com',
  email: 'b@x.com',
  imap: { host: 'imap.x.com', port: 993, tls: true },
  smtp: { host: 'smtp.x.com', port: 587, tls: true },
};

const emptyImap = {
  searchUids: vi.fn(async () => []),
  fetchEnvelopes: vi.fn(async () => []),
  fetchThreadContext: vi.fn(async () => []),
};

beforeEach(() => {
  for (const k of Object.keys(accountImapBehavior)) delete accountImapBehavior[k];
});

describe('runGetOverview — envelope', () => {
  it('exposes accounts_searched and accounts_available at top level', async () => {
    const pool = new ImapConnectionPool({
      accounts: [a, b],
      logger: createLogger('cli', { minLevel: 'error' }),
    });
    accountImapBehavior['a@x.com'] = { imap: emptyImap };
    accountImapBehavior['b@x.com'] = { imap: emptyImap };

    const result = await runGetOverview({
      pool,
      accounts: [a, b],
      input: { include: ['unread'] },
    });

    expect(result.accounts_searched).toEqual(['a@x.com', 'b@x.com']);
    expect(result.accounts_available).toEqual(['a@x.com', 'b@x.com']);
    expect(result.per_account_errors).toBeUndefined();
  });

  it('scopes accounts_searched to account_ids when provided', async () => {
    const pool = new ImapConnectionPool({
      accounts: [a, b],
      logger: createLogger('cli', { minLevel: 'error' }),
    });
    accountImapBehavior['a@x.com'] = { imap: emptyImap };
    accountImapBehavior['b@x.com'] = { imap: emptyImap };

    const result = await runGetOverview({
      pool,
      accounts: [a, b],
      input: { account_ids: ['a@x.com'], include: ['unread'] },
    });

    expect(result.accounts_searched).toEqual(['a@x.com']);
    expect(result.accounts_available).toEqual(['a@x.com', 'b@x.com']);
  });

  it('populates per_account_errors when an account fails', async () => {
    const pool = new ImapConnectionPool({
      accounts: [a, b],
      logger: createLogger('cli', { minLevel: 'error' }),
    });
    accountImapBehavior['a@x.com'] = { imap: emptyImap };
    accountImapBehavior['b@x.com'] = { throwOn: 'connect', error: 'b is down' };

    const result = await runGetOverview({
      pool,
      accounts: [a, b],
      input: { include: ['unread'] },
    });

    expect(result.per_account_errors).toBeDefined();
    expect(result.per_account_errors?.['b@x.com']).toContain('b is down');
    expect(result.per_account_errors?.['a@x.com']).toBeUndefined();
  });

  it('omits per_account_errors when all accounts succeed', async () => {
    const pool = new ImapConnectionPool({
      accounts: [a],
      logger: createLogger('cli', { minLevel: 'error' }),
    });
    accountImapBehavior['a@x.com'] = { imap: emptyImap };

    const result = await runGetOverview({
      pool,
      accounts: [a],
      input: { include: ['unread'] },
    });

    expect(result.per_account_errors).toBeUndefined();
  });

  it('rejects unknown account_ids', async () => {
    const pool = new ImapConnectionPool({
      accounts: [a],
      logger: createLogger('cli', { minLevel: 'error' }),
    });

    await expect(
      runGetOverview({
        pool,
        accounts: [a],
        input: { account_ids: ['nope@nowhere'] },
      })
    ).rejects.toThrow(/Unknown account_ids: nope@nowhere/);
  });
});
