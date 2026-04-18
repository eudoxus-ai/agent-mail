import { describe, it, expect, vi } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { createLogger } from '../../src/logger.js';
import type { AccountConfig } from '../../src/types.js';

const logger = createLogger('cli', { minLevel: 'error' });

function accounts(): AccountConfig[] {
  return [{
    id: 'a@x.com',
    email: 'a@x.com',
    imap: { host: 'h', port: 993, tls: true },
    smtp: { host: 'h', port: 465, tls: true },
  }];
}

describe('search_threads `before` cursor', () => {
  it('forwards `before` as a Date in SearchCriteria to imap.search', async () => {
    const searchSpy = vi.fn(async () => []);
    const pool = {
      withConnection: vi.fn(async (_id: string, fn: any) =>
        fn({ search: searchSpy })
      ),
    };

    const executor = new Executor({
      db: openDatabase(':memory:'),
      accounts: accounts(),
      pool: pool as any,
      logger,
    });

    await executor.executeImmediate({
      tool: 'search_threads',
      toolParams: { before: '2026-03-18T00:00:00Z' },
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'none',
    });

    expect(searchSpy).toHaveBeenCalled();
    const [, criteria] = searchSpy.mock.calls[0];
    expect(criteria.before).toBeInstanceOf(Date);
    expect((criteria.before as Date).toISOString()).toBe('2026-03-18T00:00:00.000Z');
  });
});
