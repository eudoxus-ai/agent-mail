import { describe, it, expect, vi } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { createLogger } from '../../src/logger.js';

const logger = createLogger('cli', { minLevel: 'error' });

describe('search_threads preassembled target', () => {
  it('result.target is pipeable to quarantine_messages without reconstruction', async () => {
    const pool = {
      withConnection: vi.fn(async (_id: string, fn: any) =>
        fn({
          search: async () => [{
            uid: 42,
            envelope: {
              message_id: 'm',
              subject: 's',
              from: { address: 'x@y', name: null },
              date: '2026-04-01T00:00:00Z',
            },
            snippet: '',
            flags: [],
            list_id: null,
            list_unsubscribe: null,
          }],
          fetchSnippet: async () => '',
        })
      ),
    };

    const executor = new Executor({
      db: openDatabase(':memory:'),
      accounts: [{
        id: 'a@x.com', email: 'a@x.com',
        imap: { host: 'h', port: 993, tls: true },
        smtp: { host: 'h', port: 465, tls: true },
      }],
      pool: pool as any,
      logger,
    });

    const { result } = await executor.executeImmediate({
      tool: 'search_threads',
      toolParams: { mailbox: 'Archive' },
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'none',
    });

    const [r0] = JSON.parse(result[0].text).results;
    expect(r0.target).toEqual({
      account_id: 'a@x.com',
      uid: 42,
      mailbox: 'Archive',
    });
  });
});
