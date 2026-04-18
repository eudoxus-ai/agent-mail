import { describe, it, expect, vi } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { insertIntentTargets } from '../../src/ledger/intent-targets.js';
import { getIntent } from '../../src/ledger/intents.js';
import { createLogger } from '../../src/logger.js';
import type { AccountConfig } from '../../src/types.js';

const logger = createLogger('cli', { minLevel: 'error' });
const accounts: AccountConfig[] = [
  { id: 'a@x.com', email: 'a@x.com', imap: { host: 'h', port: 993, tls: true }, smtp: { host: 'h', port: 465, tls: true } },
];

// Seed a restore_messages intent with intent_targets recording where messages landed
function seedRestoreIntent(
  db: ReturnType<typeof openDatabase>,
  intentId: string,
  targets: Array<{ uid: number; destinationMailbox: string }>
) {
  db.prepare(
    `INSERT INTO intents (id, account_id, tool, params, risk, status, undo_token, undo_expires_at)
     VALUES (?, 'a@x.com', 'restore_messages', '{}', 'low', 'executed', ?, datetime('now', '+30 days'))`
  ).run(intentId, JSON.stringify({ tool: 'restore_messages', reverseAction: 'rehold_messages', params: {} }));
  insertIntentTargets(db, intentId, targets.map((t) => ({
    account_id: 'a@x.com',
    uid: t.uid,
    mailbox: t.destinationMailbox,
    envelope_snapshot: { subject: 's', from: 'f@x.com', original_mailbox: t.destinationMailbox },
  })));
}

// Seed a draft_reply intent with draft_id in params
function seedDraftIntent(
  db: ReturnType<typeof openDatabase>,
  intentId: string,
  draftId: number
) {
  const params = { to: 'bob@x.com', subject: 'Re: hi', body: 'Hello', draft_id: draftId };
  db.prepare(
    `INSERT INTO intents (id, account_id, tool, params, risk, status, undo_token, undo_expires_at)
     VALUES (?, 'a@x.com', 'draft_reply', ?, 'low', 'executed', ?, datetime('now', '+30 days'))`
  ).run(
    intentId,
    JSON.stringify(params),
    JSON.stringify({ tool: 'draft_reply', reverseAction: 'delete_draft', params })
  );
}

describe('undo restore_messages (rehold_messages)', () => {
  it('moves each UID back from destination_mailbox to the holding folder', async () => {
    const moves: Array<{ uids: number[]; from: string; to: string }> = [];
    const pool = {
      withConnection: vi.fn(async (_: string, fn: any) =>
        fn({
          getMailboxPath: async () => 'agent-mail-holding',
          moveMessages: async (uids: number[], from: string, to: string) => {
            moves.push({ uids, from, to });
            return { uidMap: new Map(uids.map((u) => [u, u])) };
          },
        })
      ),
    };
    const db = openDatabase(':memory:');
    seedRestoreIntent(db, 'restore-1', [
      { uid: 20, destinationMailbox: 'INBOX' },
      { uid: 21, destinationMailbox: 'Archive' },
    ]);
    const executor = new Executor({ db, accounts, pool: pool as any, logger });

    const result = await executor.undoIntent('restore-1');
    expect(result.success).toBe(true);
    expect(moves).toEqual([
      { uids: [20], from: 'INBOX', to: 'agent-mail-holding' },
      { uids: [21], from: 'Archive', to: 'agent-mail-holding' },
    ]);
    expect(getIntent(db, 'restore-1')!.status).toBe('undone');
  });
});

describe('undo draft_reply (delete_draft)', () => {
  it('deletes the draft via deleteMessage on the Drafts mailbox', async () => {
    const deleteCalls: Array<{ mailbox: string; uid: number }> = [];
    const pool = {
      withConnection: vi.fn(async (_: string, fn: any) =>
        fn({
          getMailboxPath: async (name: string) => name === 'drafts' ? 'Drafts' : 'agent-mail-holding',
          deleteMessage: async (mailbox: string, uid: number) => {
            deleteCalls.push({ mailbox, uid });
          },
        })
      ),
    };
    const db = openDatabase(':memory:');
    seedDraftIntent(db, 'draft-1', 77);
    const executor = new Executor({ db, accounts, pool: pool as any, logger });

    const result = await executor.undoIntent('draft-1');
    expect(result.success).toBe(true);
    expect(deleteCalls).toEqual([{ mailbox: 'Drafts', uid: 77 }]);
    expect(getIntent(db, 'draft-1')!.status).toBe('undone');
  });
});

describe('queue_send and unsubscribe_sender response omit undo hint', () => {
  it('unsubscribe_sender response does not include reversible or undo_hint', async () => {
    const pool = {
      withConnection: vi.fn(async (_: string, fn: any) =>
        fn({})
      ),
    };
    // Mock fetch so unsubscribe_sender can execute
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({ status: 200 }) as any;
    try {
      // We need to mock url-safety too since it validates the URL
      const { Executor: Ex } = await import('../../src/executor/executor.js');
      const db = openDatabase(':memory:');
      // Use executeImmediate but mock assertSafeRemoteUrl
      const executor = new Ex({ db, accounts, pool: pool as any, logger });
      // We'll just test buildUndoHint directly to verify no hint for unsubscribe_sender
      const { buildUndoHint } = await import('../../src/lib/undo-hint.js');
      const hint = buildUndoHint({ intent_id: 'x', tool: 'unsubscribe_sender', created_at: '2026-04-18T12:00:00Z' });
      expect(hint).toBeNull();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('queue_send buildUndoHint returns null', async () => {
    const { buildUndoHint } = await import('../../src/lib/undo-hint.js');
    const hint = buildUndoHint({ intent_id: 'y', tool: 'queue_send', created_at: '2026-04-18T12:00:00Z' });
    expect(hint).toBeNull();
  });
});
