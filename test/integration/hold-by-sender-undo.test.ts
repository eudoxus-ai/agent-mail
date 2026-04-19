import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { createLogger } from '../../src/logger.js';

const logger = createLogger('cli', { minLevel: 'error' });

// ---------------------------------------------------------------------------
// Regression: `undo_intent` on a `hold_by_sender` intent must be able to
// reverse the move. Previously the undo path iterated `intent.params.targets`
// which was never populated for `hold_by_sender` (its params are
// {from, before, mailbox, ...}), causing `targets is not iterable`. Fix:
// undo reads from the `intent_targets` ledger table.
// ---------------------------------------------------------------------------

interface FakeMessage {
  uid: number;
  subject: string;
  from: string;
  date: string;
}

interface FakeAccountState {
  inbox: FakeMessage[];
  holding: FakeMessage[];
  moveLog: Array<{ uids: number[]; from: string; to: string }>;
}

function makeFakePool(state: Record<string, FakeAccountState>) {
  return {
    withConnection: vi.fn(async (accountId: string, fn: any) => {
      const s = state[accountId];
      if (!s) throw new Error(`no fake account state for ${accountId}`);
      return fn({
        getMailboxPath: async (role: string) => {
          if (role === 'holding') return 'agent-mail-holding';
          if (role === 'inbox') return 'INBOX';
          return role;
        },
        search: async (
          mailbox: string,
          criteria: { from?: string; before?: Date },
          _limit: number
        ) => {
          const src = mailbox === 'INBOX' ? s.inbox : s.holding;
          const beforeMs = criteria.before?.getTime();
          return src
            .filter((m) =>
              criteria.from ? m.from.includes(criteria.from) : true
            )
            .filter((m) =>
              beforeMs !== undefined ? new Date(m.date).getTime() < beforeMs : true
            )
            .map((m) => ({
              uid: m.uid,
              envelope: {
                message_id: `${m.uid}@test`,
                subject: m.subject,
                from: { address: m.from, name: null },
                date: m.date,
              },
              snippet: '',
              flags: [],
              list_id: null,
              list_unsubscribe: null,
            }));
        },
        fetchEnvelopes: async (mailbox: string, uids: number[]) => {
          const src = mailbox === 'INBOX' ? s.inbox : s.holding;
          return src
            .filter((m) => uids.includes(m.uid))
            .map((m) => ({
              uid: m.uid,
              subject: m.subject,
              from: { address: m.from, name: null },
            }));
        },
        moveMessages: async (uids: number[], from: string, to: string) => {
          s.moveLog.push({ uids, from, to });
          const src = from === 'INBOX' ? s.inbox : s.holding;
          const dst = to === 'INBOX' ? s.inbox : s.holding;
          const uidMap = new Map<number, number>();
          for (const uid of uids) {
            const idx = src.findIndex((m) => m.uid === uid);
            if (idx === -1) continue;
            const [msg] = src.splice(idx, 1);
            const newUid = uid + 10000;
            dst.push({ ...msg, uid: newUid });
            uidMap.set(uid, newUid);
          }
          return { uidMap };
        },
      });
    }),
  };
}

const ACCOUNT_ID = 'test@example.com';

function makeAccounts() {
  return [
    {
      id: ACCOUNT_ID,
      email: ACCOUNT_ID,
      imap: { host: 'h', port: 993, tls: true },
      smtp: { host: 'h', port: 465, tls: true },
    },
  ];
}

describe('hold_by_sender undo (regression)', () => {
  let state: Record<string, FakeAccountState>;
  let executor: Executor;

  beforeEach(() => {
    state = {
      [ACCOUNT_ID]: {
        inbox: [
          { uid: 1, subject: 'P1', from: 'promoter@example.com', date: '2026-04-10T10:00:00Z' },
          { uid: 2, subject: 'P2', from: 'promoter@example.com', date: '2026-04-11T10:00:00Z' },
          { uid: 3, subject: 'P3', from: 'promoter@example.com', date: '2026-04-12T10:00:00Z' },
        ],
        holding: [],
        moveLog: [],
      },
    };
    const pool = makeFakePool(state);
    executor = new Executor({
      db: openDatabase(':memory:'),
      accounts: makeAccounts(),
      pool: pool as any,
      logger,
    });
    // No replied threads — let the hold proceed so we can test undo.
    vi.spyOn(executor, 'threadHasReplies').mockResolvedValue(false);
  });

  it('undo_intent reverses a hold_by_sender, moving all messages back to inbox', async () => {
    const { intent } = await executor.executeImmediate({
      tool: 'hold_by_sender',
      toolParams: { from: 'promoter@example.com' },
      accountId: ACCOUNT_ID,
      agentId: 'test',
      risk: 'medium',
    });

    const s = state[ACCOUNT_ID];
    expect(s.holding).toHaveLength(3);
    expect(s.inbox).toHaveLength(0);

    // The bug: undoIntent would throw "targets is not iterable" because
    // `hold_by_sender` intent.params has no `targets` field.
    const undoResult = await executor.undoIntent(intent.id);
    expect(undoResult.success).toBe(true);

    // All 3 messages should be back in INBOX; holding empty.
    expect(s.inbox).toHaveLength(3);
    expect(s.holding).toHaveLength(0);
  });
});
