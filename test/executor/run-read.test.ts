import { describe, it, expect, vi } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { createLogger } from '../../src/logger.js';
import type { AccountConfig } from '../../src/types.js';

function makeAccounts(): AccountConfig[] {
  return [
    { id: 'a@x.com', email: 'a@x.com', imap: { host: 'h', port: 993, tls: true }, smtp: { host: 'h', port: 465, tls: true } },
  ];
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

describe('Executor.runRead (no-intent read path)', () => {
  it('returns the same search_threads payload as the sync executor path WITHOUT creating an intent', async () => {
    const accounts = makeAccounts();
    const db = openDatabase(':memory:');
    const searchRow = {
      uid: 1,
      envelope: {
        message_id: 'm1',
        subject: 's1',
        from: { address: 'x@x', name: null },
        date: '2026-04-15T00:00:00Z',
      },
      snippet: '',
      flags: [],
      list_id: null,
      list_unsubscribe: null,
    };
    const pool = makeFakePool({
      'a@x.com': { search: vi.fn(async () => [searchRow]), fetchSnippet: vi.fn(async () => '') },
    });
    const executor = new Executor({ db, accounts, pool: pool as any, logger });

    const intentsBefore = (db.prepare('SELECT COUNT(*) AS n FROM intents').get() as { n: number }).n;

    const payload = (await executor.runRead('search_threads', {})) as any;
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0].account_id).toBe('a@x.com');
    expect(payload.accounts_searched).toEqual(['a@x.com']);

    const intentsAfter = (db.prepare('SELECT COUNT(*) AS n FROM intents').get() as { n: number }).n;
    expect(intentsAfter).toBe(intentsBefore);
  });

  it('reuses listSendersMulti for list_senders', async () => {
    const accounts = makeAccounts();
    const db = openDatabase(':memory:');
    const pool = makeFakePool({
      'a@x.com': {
        search: vi.fn(async () => [
          { uid: 1, envelope: { from: { address: 's@a.com' }, date: '2026-04-15T00:00:00Z' }, list_unsubscribe: null },
          { uid: 2, envelope: { from: { address: 's@a.com' }, date: '2026-04-16T00:00:00Z' }, list_unsubscribe: null },
        ]),
      },
    });
    const executor = new Executor({ db, accounts, pool: pool as any, logger });

    const payload = (await executor.runRead('list_senders', {})) as any;
    expect(payload.senders).toHaveLength(1);
    expect(payload.senders[0].from).toBe('s@a.com');
    expect(payload.senders[0].count).toBe(2);
  });

  it('throws for an unsupported tool', async () => {
    const executor = new Executor({
      db: openDatabase(':memory:'),
      accounts: makeAccounts(),
      pool: makeFakePool({}) as any,
      logger,
    });
    await expect(executor.runRead('hold_messages', {})).rejects.toThrow(/unsupported/);
  });
});
