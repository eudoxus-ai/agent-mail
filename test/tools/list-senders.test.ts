import { describe, it, expect, vi } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { listSendersTool } from '../../src/tools/list-senders.js';
import { openDatabase } from '../../src/ledger/db.js';
import { createLogger } from '../../src/logger.js';

const logger = createLogger('cli', { minLevel: 'error' });

describe('list_senders', () => {
  it('aggregates by from.address with count, sample_uids, unsubscribe ratio', async () => {
    const pool = {
      withConnection: vi.fn(async (_id: string, fn: any) =>
        fn({
          search: async () => [
            { uid: 1, envelope: { message_id: 'a', subject: 'x', from: { address: 'promo@brand', name: null }, date: '2026-04-10T00:00:00Z' }, snippet: '', flags: [], list_id: null, list_unsubscribe: '<x>' },
            { uid: 2, envelope: { message_id: 'b', subject: 'y', from: { address: 'promo@brand', name: null }, date: '2026-04-09T00:00:00Z' }, snippet: '', flags: [], list_id: null, list_unsubscribe: '<x>' },
            { uid: 3, envelope: { message_id: 'c', subject: 'z', from: { address: 'friend@me', name: null }, date: '2026-04-08T00:00:00Z' }, snippet: '', flags: [], list_id: null, list_unsubscribe: null },
          ],
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
      tool: 'list_senders',
      toolParams: { min_count: 2 },
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'none',
    });

    const payload = JSON.parse(result[0].text);
    expect(payload.accounts_searched).toEqual(['a@x.com']);
    expect(payload.senders).toHaveLength(1);
    const [row] = payload.senders;
    expect(row.from).toBe('promo@brand');
    expect(row.count).toBe(2);
    expect(row.sample_uids).toEqual([1, 2]);
    expect(row.has_unsubscribe).toBe(true);
    expect(row.account_id).toBe('a@x.com');
    expect(typeof row.is_list_mail_ratio).toBe('number');
    expect(row.is_list_mail_ratio).toBeGreaterThanOrEqual(0);
    expect(row.is_list_mail_ratio).toBeLessThanOrEqual(1);
    expect(row.is_automated_ratio).toBeUndefined();
  });

  it('schema accepts an `async` boolean', () => {
    expect(listSendersTool.inputSchema.parse({ async: true }).async).toBe(true);
    expect(listSendersTool.inputSchema.parse({}).async).toBeUndefined();
  });
});
