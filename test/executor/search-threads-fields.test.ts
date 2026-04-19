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

function fakeCorpus() {
  return Array.from({ length: 5 }, (_, i) => {
    const day = 5 - i;
    const date = new Date(`2026-04-${String(day).padStart(2, '0')}T12:00:00Z`);
    return {
      uid: 1000 + i,
      envelope: {
        message_id: `m${i}`,
        subject: `subject ${i}`,
        from: { address: `sender${i}@y`, name: `Sender ${i}` },
        date: date.toISOString(),
      },
      snippet: '',
      flags: [],
      list_id: null,
      list_unsubscribe: null,
    };
  });
}

function buildExecutor(corpus: ReturnType<typeof fakeCorpus>) {
  const searchSpy = vi.fn(async (_mailbox: string, _criteria: any, limit: number) => {
    return corpus.slice(0, limit);
  });
  const pool = {
    withConnection: vi.fn(async (_id: string, fn: any) =>
      fn({ search: searchSpy, fetchSnippet: async () => '' })
    ),
  };
  const executor = new Executor({
    db: openDatabase(':memory:'),
    accounts: accounts(),
    pool: pool as any,
    logger,
  });
  return { executor };
}

describe('search_threads fields projection', () => {
  it('projects only requested fields when `fields` is provided', async () => {
    const { executor } = buildExecutor(fakeCorpus());

    const { result } = await executor.executeImmediate({
      tool: 'search_threads',
      toolParams: { limit: 5, fields: ['uid', 'subject', 'from_address'] },
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'none',
    });

    const payload = JSON.parse(result[0].text);
    expect(payload.results).toHaveLength(5);
    for (const r of payload.results) {
      expect(Object.keys(r).sort()).toEqual(['from_address', 'subject', 'uid']);
      expect(r).not.toHaveProperty('envelope');
      expect(r).not.toHaveProperty('snippet');
      expect(r).not.toHaveProperty('target');
      expect(typeof r.from_address).toBe('string');
    }
  });

  it('returns full shape when `fields` is omitted', async () => {
    const { executor } = buildExecutor(fakeCorpus());

    const { result } = await executor.executeImmediate({
      tool: 'search_threads',
      toolParams: { limit: 5 },
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'none',
    });

    const payload = JSON.parse(result[0].text);
    expect(payload.results).toHaveLength(5);
    for (const r of payload.results) {
      expect(r).toHaveProperty('envelope');
      expect(r.envelope).toHaveProperty('subject');
      expect(r.envelope.from).toHaveProperty('address');
      expect(r).toHaveProperty('target');
      expect(r).toHaveProperty('account_id');
      expect(r).toHaveProperty('uid');
    }
  });
});
