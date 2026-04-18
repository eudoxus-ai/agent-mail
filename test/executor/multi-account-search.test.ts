import { describe, it, expect, vi } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { createLogger } from '../../src/logger.js';
import type { AccountConfig } from '../../src/types.js';

function makeAccounts(): AccountConfig[] {
  return [
    {
      id: 'a@x.com',
      email: 'a@x.com',
      imap: { host: 'h', port: 993, tls: true },
      smtp: { host: 'h', port: 465, tls: true },
    },
    {
      id: 'b@y.com',
      email: 'b@y.com',
      imap: { host: 'h', port: 993, tls: true },
      smtp: { host: 'h', port: 465, tls: true },
    },
  ];
}

function fakeImap(searchResults: any[]) {
  return {
    search: vi.fn(async () => searchResults),
  };
}

function makeFakePool(byAccount: Record<string, any>) {
  return {
    withConnection: vi.fn(async (accountId: string, fn: any) => {
      const imap = byAccount[accountId];
      if (!imap) throw new Error(`no account ${accountId}`);
      return fn(imap);
    }),
  };
}

const logger = createLogger('cli', { minLevel: 'error' });

describe('search_threads multi-account', () => {
  it('fans out to all configured accounts when account_ids is omitted', async () => {
    const accounts = makeAccounts();
    const pool = makeFakePool({
      'a@x.com': fakeImap([
        {
          uid: 1,
          envelope: {
            message_id: 'm1',
            subject: 's1',
            from: { address: 'x@x', name: null },
            date: '2026-04-15T00:00:00Z',
          },
          snippet: '',
          flags: [],
        },
      ]),
      'b@y.com': fakeImap([
        {
          uid: 2,
          envelope: {
            message_id: 'm2',
            subject: 's2',
            from: { address: 'y@y', name: null },
            date: '2026-04-16T00:00:00Z',
          },
          snippet: '',
          flags: [],
        },
      ]),
    });

    const executor = new Executor({
      db: openDatabase(':memory:'),
      accounts,
      pool: pool as any,
      logger,
    });

    const { result } = await executor.executeImmediate({
      tool: 'search_threads',
      toolParams: {},
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'none',
    });

    const payload = JSON.parse(result[0].text);
    expect(payload.accounts_searched.sort()).toEqual(['a@x.com', 'b@y.com']);
    expect(payload.accounts_available.sort()).toEqual(['a@x.com', 'b@y.com']);
    expect(payload.results).toHaveLength(2);
    expect(payload.results[0].account_id).toBe('b@y.com');
    expect(payload.results[1].account_id).toBe('a@x.com');
    expect(payload.results[0].uid).toBe(2);
  });

  it('scopes to account_ids when provided', async () => {
    const accounts = makeAccounts();
    const pool = makeFakePool({
      'a@x.com': fakeImap([
        {
          uid: 1,
          envelope: {
            message_id: 'm1',
            subject: 's1',
            from: { address: 'x@x', name: null },
            date: '2026-04-15T00:00:00Z',
          },
          snippet: '',
          flags: [],
        },
      ]),
      'b@y.com': fakeImap([]),
    });

    const executor = new Executor({
      db: openDatabase(':memory:'),
      accounts,
      pool: pool as any,
      logger,
    });

    const { result } = await executor.executeImmediate({
      tool: 'search_threads',
      toolParams: { account_ids: ['a@x.com'] },
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'none',
    });

    const payload = JSON.parse(result[0].text);
    expect(payload.accounts_searched).toEqual(['a@x.com']);
    expect(payload.accounts_available.sort()).toEqual(['a@x.com', 'b@y.com']);
    expect(pool.withConnection).toHaveBeenCalledTimes(1);
    expect(pool.withConnection).toHaveBeenCalledWith('a@x.com', expect.any(Function));
  });

  it('reports per-account errors without failing the call', async () => {
    const accounts = makeAccounts();
    const pool = {
      withConnection: vi.fn(async (id: string, fn: any) => {
        if (id === 'b@y.com') throw new Error('auth failed');
        return fn(
          fakeImap([
            {
              uid: 1,
              envelope: {
                message_id: 'm1',
                subject: 's1',
                from: { address: 'x@x', name: null },
                date: '2026-04-15T00:00:00Z',
              },
              snippet: '',
              flags: [],
            },
          ])
        );
      }),
    };

    const executor = new Executor({
      db: openDatabase(':memory:'),
      accounts,
      pool: pool as any,
      logger,
    });

    const { result } = await executor.executeImmediate({
      tool: 'search_threads',
      toolParams: {},
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'none',
    });

    const payload = JSON.parse(result[0].text);
    expect(payload.accounts_searched.sort()).toEqual(['a@x.com', 'b@y.com']);
    expect(payload.per_account_errors).toEqual({ 'b@y.com': 'auth failed' });
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0].account_id).toBe('a@x.com');
  });
});
