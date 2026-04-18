import { describe, it, expect, vi } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { createLogger } from '../../src/logger.js';
import type { AccountConfig } from '../../src/types.js';

const logger = createLogger('cli', { minLevel: 'error' });

function accounts(): AccountConfig[] {
  return [{
    id: 'a@x.com', email: 'a@x.com',
    imap: { host: 'h', port: 993, tls: true },
    smtp: { host: 'h', port: 465, tls: true },
  }];
}

describe('search_threads list headers', () => {
  it('includes list_id, list_unsubscribe, is_list_mail per result', async () => {
    const pool = {
      withConnection: vi.fn(async (_id: string, fn: any) =>
        fn({
          search: async () => [{
            uid: 7,
            envelope: {
              message_id: 'm7',
              subject: 'Promo',
              from: { address: 'promo@brand.example', name: null },
              date: '2026-04-10T00:00:00Z',
            },
            snippet: 'body',
            flags: [],
            list_id: 'Promotions <promos.brand>',
            list_unsubscribe: '<mailto:u@brand>',
          }],
        })
      ),
    };

    const executor = new Executor({
      db: openDatabase(':memory:'),
      accounts: accounts(),
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
    const [r0] = payload.results;
    expect(r0.list_id).toBe('Promotions <promos.brand>');
    expect(r0.list_unsubscribe).toBe('<mailto:u@brand>');
    expect(r0.is_list_mail).toBe(true);
  });
});
