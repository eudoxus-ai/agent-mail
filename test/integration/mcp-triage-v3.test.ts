import { describe, it, expect, vi } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { createLogger } from '../../src/logger.js';

const logger = createLogger('cli', { minLevel: 'error' });

// ---------------------------------------------------------------------------
// Fake IMAP: records every moveMessages call so we can assert IMAP side effects.
// UIDs are remapped on move: destination UID = source UID + 1000, simulating
// how real IMAP servers assign new UIDs in the destination mailbox.
// ---------------------------------------------------------------------------

const moveLog: Array<{ uids: number[]; from: string; to: string }> = [];

// Tracks the "current" UID for each original message (remaps on each move)
// key: original uid, value: current uid in its current mailbox
const uidMapping = new Map<number, number>();

function makeFakePool(messages: Array<{
  uid: number;
  subject: string;
  from: string;
}>) {
  return {
    withConnection: vi.fn(async (_id: string, fn: any) =>
      fn({
        getMailboxPath: async (role: string) => {
          if (role === 'holding') return 'agent-mail-holding';
          if (role === 'inbox') return 'INBOX';
          return role;
        },
        moveMessages: async (uids: number[], from: string, to: string) => {
          moveLog.push({ uids, from, to });
          // Remap: new UID = old UID + 1000
          const uidMap = new Map(uids.map((u) => [u, u + 1000]));
          return { uidMap };
        },
        fetchEnvelopes: async (_mailbox: string, uids: number[]) =>
          messages
            .filter((m) => uids.includes(m.uid))
            .map((m) => ({
              uid: m.uid,
              subject: m.subject,
              from: { address: m.from, name: null },
            })),
      })
    ),
  };
}

// ---------------------------------------------------------------------------
// Test data: 3 messages for a single account, representing an over-held batch
// ---------------------------------------------------------------------------

const ACCOUNT_ID = 'test@example.com';

const MESSAGES = [
  { uid: 101, subject: 'Denver Ventures intro', from: 'denver@example.com' },
  { uid: 102, subject: 'Weekly newsletter', from: 'news@example.com' },
  { uid: 103, subject: 'Discount offer', from: 'promo@example.com' },
];

describe('MCP triage v3: hold → get_intent → partial restore', () => {
  it('holds 3 messages, inspects intent, restores 1, checks reversal links (with UID remapping)', async () => {
    // Fresh in-memory DB + fake IMAP pool per test
    moveLog.length = 0;
    uidMapping.clear();
    const db = openDatabase(':memory:');
    const pool = makeFakePool(MESSAGES);

    const executor = new Executor({
      db,
      accounts: [{
        id: ACCOUNT_ID,
        email: ACCOUNT_ID,
        imap: { host: 'h', port: 993, tls: true },
        smtp: { host: 'h', port: 465, tls: true },
      }],
      pool: pool as any,
      logger,
    });

    const targets = MESSAGES.map((m) => ({
      account_id: ACCOUNT_ID,
      uid: m.uid,
      mailbox: 'INBOX',
    }));

    // -----------------------------------------------------------------------
    // Step 2: hold_messages with include_summary: true for all 3 UIDs
    // -----------------------------------------------------------------------
    const holdResult = await executor.executeImmediate({
      tool: 'hold_messages',
      toolParams: { targets, include_summary: true },
      accountId: ACCOUNT_ID,
      agentId: 'test-agent',
      risk: 'medium',
    });

    const holdPayload = JSON.parse(holdResult.result[0].text);

    // -----------------------------------------------------------------------
    // Step 3: assert moved has 3 items, reversible: true, undo_hint method
    // -----------------------------------------------------------------------
    expect(holdPayload.moved).toHaveLength(3);
    expect(holdPayload.reversible).toBe(true);
    expect(holdPayload.undo_hint.method).toBe('restore_messages');

    const holdIntentId = holdResult.intent.id;

    // -----------------------------------------------------------------------
    // Step 4: get_intent returns all 3 targets with captured subjects
    // -----------------------------------------------------------------------
    const intentResult = await executor.executeImmediate({
      tool: 'get_intent',
      toolParams: { intent_id: holdIntentId },
      accountId: ACCOUNT_ID,
      agentId: 'test-agent',
      risk: 'none',
    });

    const intentPayload = JSON.parse(intentResult.result[0].text);
    expect(intentPayload.id).toBe(holdIntentId);
    expect(intentPayload.targets).toHaveLength(3);

    // Every target should have a captured subject
    const capturedSubjects = intentPayload.targets.map((t: any) => t.subject);
    expect(capturedSubjects).toContain('Denver Ventures intro');
    expect(capturedSubjects).toContain('Weekly newsletter');
    expect(capturedSubjects).toContain('Discount offer');

    // -----------------------------------------------------------------------
    // Step 5: restore_messages for just UID 101 (Denver Ventures)
    // -----------------------------------------------------------------------
    const restoreResult = await executor.executeImmediate({
      tool: 'restore_messages',
      toolParams: {
        targets: [{ account_id: ACCOUNT_ID, uid: 101, mailbox: 'agent-mail-holding' }],
      },
      accountId: ACCOUNT_ID,
      agentId: 'test-agent',
      risk: 'low',
    });

    const restorePayload = JSON.parse(restoreResult.result[0].text);

    // -----------------------------------------------------------------------
    // Step 6: moved has 1 item, errors: [], reversible: true, undo_hint method
    // -----------------------------------------------------------------------
    expect(restorePayload.moved).toHaveLength(1);
    expect(restorePayload.errors).toHaveLength(0);
    expect(restorePayload.reversible).toBe(true);
    expect(restorePayload.undo_hint.method).toBe('undo_intent');

    const restoreIntentId = restoreResult.intent.id;

    // -----------------------------------------------------------------------
    // Step 7: get_intent on hold intent → reversed_by_intent_id = restore intent id
    // -----------------------------------------------------------------------
    const holdIntentAfterRestore = await executor.executeImmediate({
      tool: 'get_intent',
      toolParams: { intent_id: holdIntentId },
      accountId: ACCOUNT_ID,
      agentId: 'test-agent',
      risk: 'none',
    });

    const holdAfterPayload = JSON.parse(holdIntentAfterRestore.result[0].text);
    expect(holdAfterPayload.reversed_by_intent_id).toBe(restoreIntentId);

    // -----------------------------------------------------------------------
    // Step 8: fake IMAP recorded 3 moves to holding, then 1 move out.
    // With UID remapping: hold moves source UIDs [101,102,103]; restore must
    // move the destination_uid (101 + 1000 = 1101) back to INBOX.
    // -----------------------------------------------------------------------
    const movesToHolding = moveLog.filter((m) => m.to === 'agent-mail-holding');
    const movesFromHolding = moveLog.filter((m) => m.from === 'agent-mail-holding');

    // The hold call moves each source UID to holding
    const heldUids = movesToHolding.flatMap((m) => m.uids);
    expect(heldUids.sort()).toEqual([101, 102, 103]);

    // The restore call must use the remapped UID (1101) to find the message in holding
    const restoredUids = movesFromHolding.flatMap((m) => m.uids);
    expect(restoredUids).toEqual([1101]);

    // Total move operations: hold moves came first
    const holdMoveIndex = moveLog.findIndex((m) => m.to === 'agent-mail-holding');
    const restoreMoveIndex = moveLog.findIndex((m) => m.from === 'agent-mail-holding');
    expect(holdMoveIndex).toBeLessThan(restoreMoveIndex);

    // Agent-facing payload still shows source UID 101 (not the remapped UID)
    expect(restorePayload.moved[0].uid).toBe(101);
  });
});
