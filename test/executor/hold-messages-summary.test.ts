import { describe, it, expect, vi } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { getIntentTargets } from '../../src/ledger/intent-targets.js';
import { createLogger } from '../../src/logger.js';
import type { AccountConfig } from '../../src/types.js';

const logger = createLogger('cli', { minLevel: 'error' });
const accounts: AccountConfig[] = [
  { id: 'a@x.com', email: 'a@x.com', imap: { host: 'h', port: 993, tls: true }, smtp: { host: 'h', port: 465, tls: true } },
];

describe('hold_messages include_summary', () => {
  it('returns moved[] and persists targets with envelope snapshots', async () => {
    const pool = {
      withConnection: vi.fn(async (_: string, fn: any) =>
        fn({
          getMailboxPath: async () => 'agent-mail-holding',
          moveMessages: async (uids: number[]) => ({ uidMap: new Map(uids.map((u) => [u, u])) }),
          fetchEnvelopes: async (_m: string, uids: number[]) =>
            uids.map((uid) => ({ uid, subject: `subj-${uid}`, from: { address: 'a@x.com', name: null }, snippet: '' })),
        })
      ),
    };
    const db = openDatabase(':memory:');
    const executor = new Executor({ db, accounts, pool: pool as any, logger });

    const { intent, result } = await executor.executeImmediate({
      tool: 'hold_messages',
      toolParams: {
        targets: [
          { account_id: 'a@x.com', uid: 10, mailbox: 'INBOX' },
          { account_id: 'a@x.com', uid: 11, mailbox: 'INBOX' },
        ],
        include_summary: true,
      },
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'medium',
    });

    const payload = JSON.parse(result[0].text);
    expect(payload.moved).toEqual([
      { uid: 10, account_id: 'a@x.com', subject: 'subj-10', from: 'a@x.com', original_mailbox: 'INBOX' },
      { uid: 11, account_id: 'a@x.com', subject: 'subj-11', from: 'a@x.com', original_mailbox: 'INBOX' },
    ]);

    const targets = getIntentTargets(db, intent.id);
    expect(targets).toHaveLength(2);
    expect(targets[0].envelope_snapshot).toMatchObject({
      subject: 'subj-10', from: 'a@x.com', original_mailbox: 'INBOX',
    });
    // destination_uid should reflect the uidMap returned by moveMessages
    expect(targets[0].destination_uid).toBe(10);
    expect(targets[1].destination_uid).toBe(11);
  });

  it('persists destination_uid from fake uidMap with remapped UIDs', async () => {
    // Simulate a real IMAP server that assigns new UIDs in the holding folder
    const pool = {
      withConnection: vi.fn(async (_: string, fn: any) =>
        fn({
          getMailboxPath: async () => 'agent-mail-holding',
          moveMessages: async (uids: number[]) => ({
            uidMap: new Map(uids.map((u) => [u, u + 1000])),
          }),
          fetchEnvelopes: async (_m: string, uids: number[]) =>
            uids.map((uid) => ({ uid, subject: `subj-${uid}`, from: { address: 'a@x.com', name: null }, snippet: '' })),
        })
      ),
    };
    const db = openDatabase(':memory:');
    const executor = new Executor({ db, accounts, pool: pool as any, logger });

    const { intent } = await executor.executeImmediate({
      tool: 'hold_messages',
      toolParams: {
        targets: [
          { account_id: 'a@x.com', uid: 10, mailbox: 'INBOX' },
          { account_id: 'a@x.com', uid: 11, mailbox: 'INBOX' },
        ],
        include_summary: true,
      },
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'medium',
    });

    const targets = getIntentTargets(db, intent.id);
    expect(targets).toHaveLength(2);
    // Source UIDs remain the agent-facing UIDs
    expect(targets[0].uid).toBe(10);
    expect(targets[1].uid).toBe(11);
    // destination_uid reflects the remapped UIDs from IMAP
    expect(targets[0].destination_uid).toBe(1010);
    expect(targets[1].destination_uid).toBe(1011);
  });

  it('omits moved when include_summary is explicitly false; still persists targets on real run', async () => {
    const pool = {
      withConnection: vi.fn(async (_: string, fn: any) =>
        fn({
          getMailboxPath: async () => 'agent-mail-holding',
          moveMessages: async (uids: number[]) => ({ uidMap: new Map(uids.map((u) => [u, u])) }),
          fetchEnvelopes: async (_m: string, uids: number[]) =>
            uids.map((uid) => ({ uid, subject: 's', from: { address: 'f@x.com', name: null }, snippet: '' })),
        })
      ),
    };
    const db = openDatabase(':memory:');
    const executor = new Executor({ db, accounts, pool: pool as any, logger });
    const { intent, result } = await executor.executeImmediate({
      tool: 'hold_messages',
      toolParams: { targets: [{ account_id: 'a@x.com', uid: 10, mailbox: 'INBOX' }], include_summary: false },
      accountId: 'a@x.com', agentId: 'test', risk: 'medium',
    });
    const payload = JSON.parse(result[0].text);
    expect(payload.moved).toBeUndefined();
    expect(getIntentTargets(db, intent.id)).toHaveLength(1);
  });

  it('dry_run does not persist targets and does not include moved', async () => {
    const pool = {
      withConnection: vi.fn(async (_: string, fn: any) =>
        fn({
          getMailboxPath: async () => 'agent-mail-holding',
          moveMessages: async (uids: number[]) => ({ uidMap: new Map(uids.map((u) => [u, u])) }),
          fetchEnvelopes: async () => [],
        })
      ),
    };
    const db = openDatabase(':memory:');
    const executor = new Executor({ db, accounts, pool: pool as any, logger });
    const { intent } = await executor.executeImmediate({
      tool: 'hold_messages',
      toolParams: { targets: [{ account_id: 'a@x.com', uid: 10, mailbox: 'INBOX' }], dry_run: true },
      accountId: 'a@x.com', agentId: 'test', risk: 'medium',
    });
    expect(getIntentTargets(db, intent.id)).toEqual([]);
  });
});
