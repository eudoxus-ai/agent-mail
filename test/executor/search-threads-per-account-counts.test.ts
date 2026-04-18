import { describe, it, expect, vi } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { createLogger } from '../../src/logger.js';
import type { AccountConfig } from '../../src/types.js';

const logger = createLogger('cli', { minLevel: 'error' });
const accounts: AccountConfig[] = [
  { id: 'a@x.com', email: 'a@x.com', imap: { host: 'h', port: 993, tls: true }, smtp: { host: 'h', port: 465, tls: true } },
  { id: 'b@y.com', email: 'b@y.com', imap: { host: 'h', port: 993, tls: true }, smtp: { host: 'h', port: 465, tls: true } },
];

function makeRow(uid: number, date: string) {
  return {
    uid,
    envelope: {
      message_id: `m${uid}`,
      subject: `s${uid}`,
      from: { address: 'x@x', name: null },
      date,
    },
    snippet: '',
    flags: [],
  };
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

describe('search_threads per_account_counts', () => {
  it('reports per-account thread counts in the envelope', async () => {
    const pool = makeFakePool({
      'a@x.com': fakeImap([
        makeRow(1, '2026-04-15T00:00:00Z'),
        makeRow(2, '2026-04-14T00:00:00Z'),
      ]),
      'b@y.com': fakeImap([
        makeRow(3, '2026-04-13T00:00:00Z'),
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
    expect(payload.per_account_counts).toEqual({ 'a@x.com': 2, 'b@y.com': 1 });
  });
});
