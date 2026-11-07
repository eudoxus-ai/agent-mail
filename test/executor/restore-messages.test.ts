import { describe, it, expect, vi } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { insertIntentTargets } from '../../src/ledger/intent-targets.js';
import { getReversalLinks } from '../../src/ledger/intents.js';
import { createLogger } from '../../src/logger.js';
import type { AccountConfig } from '../../src/types.js';

const logger = createLogger('cli', { minLevel: 'error' });
const accounts: AccountConfig[] = [
  { id: 'a@x.com', email: 'a@x.com', imap: { host: 'h', port: 993, tls: true }, smtp: { host: 'h', port: 465, tls: true } },
];

function seedHoldIntent(db: any, intentId: string, targets: Array<{uid: number; original_mailbox: string; destination_uid?: number}>) {
  db.prepare(
    `INSERT INTO intents (id, account_id, tool, params, risk, status)
     VALUES (?, 'a@x.com', 'hold_messages', '{}', 'medium', 'executed')`
  ).run(intentId);
  insertIntentTargets(db, intentId, targets.map((t) => ({
    account_id: 'a@x.com',
    uid: t.uid,
    mailbox: 'agent-mail-holding',
    envelope_snapshot: { subject: 's', from: 'f@x.com', original_mailbox: t.original_mailbox },
    destination_uid: t.destination_uid ?? t.uid,
  })));
}

describe('restore_messages', () => {
  it('moves each UID back to its recorded original mailbox', async () => {
    const moves: Array<{ uids: number[]; from: string; to: string }> = [];
    const pool = {
      withConnection: vi.fn(async (_: string, fn: any) =>
        fn({
          getMailboxPath: async () => 'agent-mail-holding',
          existingUids: async (_m: string, uids: number[]) => uids,
          mailboxSnapshot: async () => ({ uidValidity: 1, uidNext: 1000, highestModseq: 1, exists: 0 }),
          uidsByMessageId: async () => new Map<string, number[]>(),
          moveMessages: async (uids: number[], from: string, to: string) => {
            moves.push({ uids, from, to });
            return { uidMap: new Map(uids.map((u) => [u, u])) };
          },
        })
      ),
    };
    const db = openDatabase(':memory:');
    seedHoldIntent(db, 'hold-1', [
      { uid: 10, original_mailbox: 'INBOX' },
      { uid: 11, original_mailbox: 'Archive' },
    ]);
    const executor = new Executor({ db, accounts, pool: pool as any, logger });

    const { intent, result } = await executor.executeImmediate({
      tool: 'restore_messages',
      toolParams: { targets: [
        { account_id: 'a@x.com', uid: 10 },
        { account_id: 'a@x.com', uid: 11 },
      ] },
      accountId: 'a@x.com', agentId: 'test', risk: 'low',
    });

    expect(moves).toEqual([
      { uids: [10], from: 'agent-mail-holding', to: 'INBOX' },
      { uids: [11], from: 'agent-mail-holding', to: 'Archive' },
    ]);
    const payload = JSON.parse(result[0].text);
    expect(payload.moved).toHaveLength(2);
    expect(payload.errors).toEqual([]);

    const links = getReversalLinks(db, intent.id);
    expect(links.reverses).toContain('hold-1');
    expect(payload.reversible).toBe(true);
    expect(payload.undo_hint.method).toBe('undo_intent');
    expect(payload.to_undo).toMatch(/undo_intent.*intent_id "[^"]+"/);
    expect(payload.to_undo).toContain(intent.id);
    expect(payload.to_undo).toContain(payload.undo_hint.window_expires_at);
  });

  it('per-target error for UID with no ledger entry, still moves valid ones', async () => {
    const moves: Array<{ uids: number[]; from: string; to: string }> = [];
    const pool = {
      withConnection: vi.fn(async (_: string, fn: any) =>
        fn({
          getMailboxPath: async () => 'agent-mail-holding',
          existingUids: async (_m: string, uids: number[]) => uids,
          mailboxSnapshot: async () => ({ uidValidity: 1, uidNext: 1000, highestModseq: 1, exists: 0 }),
          uidsByMessageId: async () => new Map<string, number[]>(),
          moveMessages: async (uids: number[], from: string, to: string) => {
            moves.push({ uids, from, to });
            return { uidMap: new Map(uids.map((u) => [u, u])) };
          },
        })
      ),
    };
    const db = openDatabase(':memory:');
    seedHoldIntent(db, 'hold-1', [{ uid: 10, original_mailbox: 'INBOX' }]);
    const executor = new Executor({ db, accounts, pool: pool as any, logger });

    const { result } = await executor.executeImmediate({
      tool: 'restore_messages',
      toolParams: { targets: [
        { account_id: 'a@x.com', uid: 10 },
        { account_id: 'a@x.com', uid: 999 },
      ] },
      accountId: 'a@x.com', agentId: 'test', risk: 'low',
    });
    const payload = JSON.parse(result[0].text);
    expect(payload.moved).toEqual([
      { uid: 10, account_id: 'a@x.com', destination_mailbox: 'INBOX' },
    ]);
    expect(payload.errors).toEqual([
      { uid: 999, account_id: 'a@x.com', reason: 'original_mailbox unknown (not in ledger)' },
    ]);
    expect(moves).toEqual([{ uids: [10], from: 'agent-mail-holding', to: 'INBOX' }]);
  });

  it('dry_run plans moves without calling moveMessages', async () => {
    const moves: any[] = [];
    const pool = {
      withConnection: vi.fn(async (_: string, fn: any) =>
        fn({
          getMailboxPath: async () => 'agent-mail-holding',
          existingUids: async (_m: string, uids: number[]) => uids,
          mailboxSnapshot: async () => ({ uidValidity: 1, uidNext: 1000, highestModseq: 1, exists: 0 }),
          uidsByMessageId: async () => new Map<string, number[]>(),
          moveMessages: async (uids: number[]) => { moves.push(1); return { uidMap: new Map(uids.map((u) => [u, u])) }; },
        })
      ),
    };
    const db = openDatabase(':memory:');
    seedHoldIntent(db, 'hold-1', [{ uid: 10, original_mailbox: 'INBOX' }]);
    const executor = new Executor({ db, accounts, pool: pool as any, logger });
    const { result } = await executor.executeImmediate({
      tool: 'restore_messages',
      toolParams: { targets: [{ account_id: 'a@x.com', uid: 10 }], dry_run: true },
      accountId: 'a@x.com', agentId: 'test', risk: 'low',
    });
    expect(moves).toEqual([]);
    const payload = JSON.parse(result[0].text);
    expect(payload.dry_run).toBe(true);
    expect(payload.moved[0]).toMatchObject({ uid: 10, destination_mailbox: 'INBOX' });
    expect(payload.reversible).toBeUndefined();
    expect(payload.undo_hint).toBeUndefined();
    expect(payload.to_undo).toBeUndefined();
  });

  it('uses destination_uid (remapped UID in holding) when moving back', async () => {
    // Simulates a real IMAP server: source UID 10 was stored in holding as UID 500.
    // The restore must move UID 500, not UID 10, from holding to INBOX.
    const moves: Array<{ uids: number[]; from: string; to: string }> = [];
    const pool = {
      withConnection: vi.fn(async (_: string, fn: any) =>
        fn({
          getMailboxPath: async () => 'agent-mail-holding',
          existingUids: async (_m: string, uids: number[]) => uids,
          mailboxSnapshot: async () => ({ uidValidity: 1, uidNext: 1000, highestModseq: 1, exists: 0 }),
          uidsByMessageId: async () => new Map<string, number[]>(),
          moveMessages: async (uids: number[], from: string, to: string) => {
            moves.push({ uids, from, to });
            return { uidMap: new Map(uids.map((u) => [u, u])) };
          },
        })
      ),
    };
    const db = openDatabase(':memory:');
    // Seed: source UID 10, destination_uid 500 (what IMAP assigned in holding)
    seedHoldIntent(db, 'hold-1', [
      { uid: 10, original_mailbox: 'INBOX', destination_uid: 500 },
    ]);
    const executor = new Executor({ db, accounts, pool: pool as any, logger });

    const { result } = await executor.executeImmediate({
      tool: 'restore_messages',
      toolParams: { targets: [{ account_id: 'a@x.com', uid: 10 }] },
      accountId: 'a@x.com', agentId: 'test', risk: 'low',
    });

    // The actual move must use UID 500 (the destination_uid in holding), not UID 10
    expect(moves).toEqual([
      { uids: [500], from: 'agent-mail-holding', to: 'INBOX' },
    ]);
    const payload = JSON.parse(result[0].text);
    // Agent-facing moved[] still shows source UID 10
    expect(payload.moved).toEqual([
      { uid: 10, account_id: 'a@x.com', destination_mailbox: 'INBOX' },
    ]);
    expect(payload.errors).toEqual([]);
  });

  it('rejects unknown account_id in targets', async () => {
    const pool = { withConnection: vi.fn() };
    const db = openDatabase(':memory:');
    const executor = new Executor({ db, accounts, pool: pool as any, logger });
    await expect(
      executor.executeImmediate({
        tool: 'restore_messages',
        toolParams: { targets: [{ account_id: 'unknown@z.com', uid: 1 }] },
        accountId: 'a@x.com', agentId: 'test', risk: 'low',
      })
    ).rejects.toThrow(/unknown.*account/i);
  });
});
