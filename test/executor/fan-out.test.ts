import { describe, it, expect, vi } from 'vitest';
import { fanOut } from '../../src/executor/fan-out.js';
import type { ImapConnectionPool } from '../../src/provider/imap-pool.js';

function makeFakePool(perAccount: Record<string, unknown>): ImapConnectionPool {
  return {
    withConnection: vi.fn(async (accountId: string, fn: any) => {
      const value = perAccount[accountId];
      if (value instanceof Error) throw value;
      return fn(value);
    }),
  } as unknown as ImapConnectionPool;
}

describe('fanOut', () => {
  it('runs the function per account in parallel and merges results', async () => {
    const pool = makeFakePool({ 'a@x.com': 'A', 'b@y.com': 'B' });

    const result = await fanOut({
      pool,
      accountIds: ['a@x.com', 'b@y.com'],
      fn: async (accountId, conn) => `${accountId}:${conn}`,
    });

    expect(result.accounts_searched.sort()).toEqual(['a@x.com', 'b@y.com']);
    expect(result.per_account).toEqual({
      'a@x.com': 'a@x.com:A',
      'b@y.com': 'b@y.com:B',
    });
    expect(result.errors).toEqual({});
  });

  it('captures per-account errors without failing the whole call', async () => {
    const pool = makeFakePool({ 'a@x.com': 'A', 'b@y.com': new Error('auth failed') });

    const result = await fanOut({
      pool,
      accountIds: ['a@x.com', 'b@y.com'],
      fn: async (_id, conn) => conn,
    });

    expect(result.per_account).toEqual({ 'a@x.com': 'A' });
    expect(result.errors).toEqual({ 'b@y.com': 'auth failed' });
    expect(result.accounts_searched.sort()).toEqual(['a@x.com', 'b@y.com']);
  });

  it('returns empty maps when accountIds is empty', async () => {
    const pool = makeFakePool({});
    const result = await fanOut({ pool, accountIds: [], fn: async () => 'x' });
    expect(result.accounts_searched).toEqual([]);
    expect(result.per_account).toEqual({});
    expect(result.errors).toEqual({});
  });
});
