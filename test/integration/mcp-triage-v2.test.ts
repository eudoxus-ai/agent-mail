import { describe, it, expect, vi } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { createLogger } from '../../src/logger.js';

const logger = createLogger('cli', { minLevel: 'error' });

describe('MCP triage v2 end-to-end', () => {
  it('search_threads → quarantine_messages → list_senders pipes cleanly', async () => {
    const pool = {
      withConnection: vi.fn(async (_id: string, fn: any) =>
        fn({
          search: async () => [
            {
              uid: 10,
              envelope: {
                message_id: 'a',
                subject: 'Deal',
                from: { address: 'promo@x', name: null },
                date: '2026-04-10T00:00:00Z',
              },
              snippet: 'save 30%',
              flags: [],
              list_id: 'Promos <x>',
              list_unsubscribe: '<mailto:u@x>',
            },
            {
              uid: 11,
              envelope: {
                message_id: 'b',
                subject: 'Deal 2',
                from: { address: 'promo@x', name: null },
                date: '2026-04-09T00:00:00Z',
              },
              snippet: 'save 40%',
              flags: [],
              list_id: 'Promos <x>',
              list_unsubscribe: '<mailto:u@x>',
            },
          ],
          getMailboxPath: async () => 'agent-mail-quarantine',
          moveMessages: async () => {},
          listMailboxes: async () => [
            { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', delimiter: '/', flags: [] },
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

    // 1. search_threads returns v2 shape with target, list headers, is_list_mail
    const search = await executor.executeImmediate({
      tool: 'search_threads',
      toolParams: { before: '2026-04-15T00:00:00Z' },
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'none',
    });
    const sPayload = JSON.parse(search.result[0].text);
    expect(sPayload.results[0].target).toEqual({
      account_id: 'a@x.com',
      uid: 10,
      mailbox: 'INBOX',
    });
    expect(sPayload.results[0].is_list_mail).toBe(true);
    expect(sPayload.results[0].list_id).toContain('Promos');

    // 2. Pipe targets straight into quarantine_thread (canonical internal name)
    const targets = sPayload.results.map((r: any) => r.target);
    const quar = await executor.executeImmediate({
      tool: 'quarantine_thread',
      toolParams: { targets, dry_run: true },
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'medium',
    });
    const qPayload = JSON.parse(quar.result[0].text);
    expect(qPayload.dry_run).toBe(true);
    expect(qPayload.total_messages).toBe(2);

    // 3. list_senders collapses the two UIDs to one sender decision
    const senders = await executor.executeImmediate({
      tool: 'list_senders',
      toolParams: { min_count: 2 },
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'none',
    });
    const lsPayload = JSON.parse(senders.result[0].text);
    expect(lsPayload.senders).toHaveLength(1);
    expect(lsPayload.senders[0].from).toBe('promo@x');
    expect(lsPayload.senders[0].count).toBe(2);
    expect(lsPayload.senders[0].has_unsubscribe).toBe(true);

    // 4. list_mailboxes surfaces folder structure
    const mailboxes = await executor.executeImmediate({
      tool: 'list_mailboxes',
      toolParams: {},
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'none',
    });
    const mPayload = JSON.parse(mailboxes.result[0].text);
    expect(mPayload.per_account['a@x.com'].mailboxes[0].specialUse).toBe('\\Inbox');
  });
});
