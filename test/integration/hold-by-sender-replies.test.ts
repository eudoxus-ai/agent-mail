import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { getIntent } from '../../src/ledger/intents.js';
import { getAuditLog } from '../../src/ledger/audit.js';
import { createLogger } from '../../src/logger.js';

const logger = createLogger('cli', { minLevel: 'error' });

// ---------------------------------------------------------------------------
// Regression: `hold_by_sender` declares `when_thread_has_replies:
// approval_required` in default policy, but the middleware can't inspect
// replies without first expanding the IMAP search. The executor must run the
// replies check itself after expanding UIDs, leave replied threads where they
// are, and fail-closed with a structured error when that leaves nothing to hold.
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
            .filter((m) => (criteria.from ? m.from.includes(criteria.from) : true))
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

describe('hold_by_sender replies gate (regression)', () => {
  let state: Record<string, FakeAccountState>;
  let executor: Executor;

  beforeEach(() => {
    state = {
      [ACCOUNT_ID]: {
        inbox: [
          { uid: 1, subject: 'Hi', from: 'x@example.com', date: '2026-04-10T10:00:00Z' },
          { uid: 2, subject: 'Re: Hi', from: 'x@example.com', date: '2026-04-11T10:00:00Z' },
          { uid: 3, subject: 'Another', from: 'x@example.com', date: '2026-04-12T10:00:00Z' },
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
    // Simulate: every expanded UID is in a replied-to thread.
    vi.spyOn(executor, 'repliedUids').mockImplementation(async (_a, _m, uids) => new Set(uids));
  });

  it('aborts with structured replies_present error and moves no messages', async () => {
    const { intent, result } = await executor.executeImmediate({
      tool: 'hold_by_sender',
      toolParams: { from: 'x@example.com' },
      accountId: ACCOUNT_ID,
      agentId: 'test',
      risk: 'medium',
    });

    const payload = JSON.parse(result[0].text);
    expect(payload.error).toBe(true);
    expect(payload.code).toBe('replies_present');
    expect(typeof payload.message).toBe('string');
    expect(payload.matched_count).toBe(3);
    expect(payload.hint).toMatch(/dry_run|hold_messages/i);

    // Nothing moved.
    const s = state[ACCOUNT_ID];
    expect(s.holding).toHaveLength(0);
    expect(s.inbox).toHaveLength(3);
    expect(s.moveLog).toHaveLength(0);

    // Ledger: the intent is marked `failed` (not `executed`) with a
    // human-readable `error_detail`, so audit consumers don't see a
    // "Held messages from X" line when zero messages moved.
    const db = (executor as any).db;
    const persisted = getIntent(db, intent.id)!;
    expect(persisted.status).toBe('failed');
    expect(persisted.error_detail).toBeTruthy();
    const detail = persisted.error_detail as { message: string; code?: string };
    expect(detail.message).toMatch(/replies/i);
    expect(detail.code).toBe('replies_present');

    // Audit log: a `failed` entry exists, and no `executed` entry.
    const entries = getAuditLog(db, { intent_id: intent.id });
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('failed');
    expect(actions).not.toContain('executed');
    const failedEntry = entries.find((e) => e.action === 'failed')!;
    const failedDetail = failedEntry.detail as { summary: string; error: string };
    // Audit summary must not claim success (no "Held messages from ...").
    expect(failedDetail.summary).toMatch(/^Failed:/);
    expect(failedDetail.summary).not.toMatch(/^Held messages from/);
    expect(failedDetail.error).toMatch(/replies/i);
  });

  it('dry_run still reports replies_present (warn on preview)', async () => {
    const { result } = await executor.executeImmediate({
      tool: 'hold_by_sender',
      toolParams: { from: 'x@example.com', dry_run: true },
      accountId: ACCOUNT_ID,
      agentId: 'test',
      risk: 'medium',
    });

    const payload = JSON.parse(result[0].text);
    expect(payload.error).toBe(true);
    expect(payload.code).toBe('replies_present');
    // Still no moves.
    expect(state[ACCOUNT_ID].moveLog).toHaveLength(0);
  });
});
