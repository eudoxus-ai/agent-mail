import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { createLogger } from '../../src/logger.js';

const logger = createLogger('cli', { minLevel: 'error' });

// ---------------------------------------------------------------------------
// Fake IMAP pool: maintains per-account INBOX and agent-mail-holding state so
// we can verify that `hold_by_sender` actually moves matching messages and
// leaves non-matching ones untouched.
// ---------------------------------------------------------------------------

interface FakeMessage {
  uid: number;
  subject: string;
  from: string;
  date: string; // ISO8601
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
            // Simulate UID remap: destination UID = source UID + 10000
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

function makeInitialInbox(): FakeMessage[] {
  return [
    { uid: 1, subject: 'Promo 1', from: 'promoter@example.com', date: '2026-04-10T10:00:00Z' },
    { uid: 2, subject: 'Promo 2', from: 'promoter@example.com', date: '2026-04-11T10:00:00Z' },
    { uid: 3, subject: 'Promo 3', from: 'promoter@example.com', date: '2026-04-12T10:00:00Z' },
    { uid: 4, subject: 'Promo 4', from: 'promoter@example.com', date: '2026-04-13T10:00:00Z' },
    { uid: 5, subject: 'Promo 5', from: 'promoter@example.com', date: '2026-04-14T10:00:00Z' },
    { uid: 100, subject: 'Hey', from: 'friend@example.com', date: '2026-04-10T10:00:00Z' },
    { uid: 101, subject: 'Lunch?', from: 'friend@example.com', date: '2026-04-12T10:00:00Z' },
    { uid: 102, subject: 'See you', from: 'friend@example.com', date: '2026-04-14T10:00:00Z' },
  ];
}

describe('hold_by_sender integration', () => {
  let state: Record<string, FakeAccountState>;
  let executor: Executor;

  beforeEach(() => {
    state = {
      [ACCOUNT_ID]: { inbox: makeInitialInbox(), holding: [], moveLog: [] },
    };
    const pool = makeFakePool(state);
    executor = new Executor({
      db: openDatabase(':memory:'),
      accounts: makeAccounts(),
      pool: pool as any,
      logger,
    });
  });

  it('holds all 5 promoter messages, leaves friend untouched, records undo', async () => {
    const { intent, result } = await executor.executeImmediate({
      tool: 'hold_by_sender',
      toolParams: { from: 'promoter@example.com' },
      accountId: ACCOUNT_ID,
      agentId: 'test',
      risk: 'medium',
    });

    const payload = JSON.parse(result[0].text);
    expect(payload.dry_run).toBe(false);
    expect(payload.total_messages).toBe(5);
    expect(payload.moved).toHaveLength(5);
    expect(payload.reversible).toBe(true);
    expect(payload.undo_hint.method).toBe('restore_messages');
    expect(payload.undo_hint.intent_id).toBe(intent.id);
    expect(intent.undo_token).not.toBeNull();

    // All 5 promoter UIDs moved to holding; friend UIDs still in inbox.
    const s = state[ACCOUNT_ID];
    expect(s.holding).toHaveLength(5);
    expect(s.holding.every((m) => m.from === 'promoter@example.com')).toBe(true);
    expect(s.inbox.map((m) => m.uid).sort()).toEqual([100, 101, 102]);

    // Every moved summary row carries subject + from + original_mailbox
    for (const m of payload.moved) {
      expect(m.account_id).toBe(ACCOUNT_ID);
      expect(m.from).toBe('promoter@example.com');
      expect(m.original_mailbox).toBe('INBOX');
      expect(typeof m.subject).toBe('string');
    }
  });

  it('dry_run previews without moving and omits undo_hint', async () => {
    const { result } = await executor.executeImmediate({
      tool: 'hold_by_sender',
      toolParams: { from: 'friend@example.com', dry_run: true },
      accountId: ACCOUNT_ID,
      agentId: 'test',
      risk: 'medium',
    });

    const payload = JSON.parse(result[0].text);
    expect(payload.dry_run).toBe(true);
    expect(payload.total_messages).toBe(3);
    expect(payload.reversible).toBeUndefined();
    expect(payload.undo_hint).toBeUndefined();

    // Nothing actually moved — inbox unchanged, holding empty, no moves logged.
    const s = state[ACCOUNT_ID];
    expect(s.holding).toHaveLength(0);
    expect(s.inbox).toHaveLength(8);
    expect(s.moveLog).toHaveLength(0);
  });

  it('honors before cutoff (strict less-than)', async () => {
    // 2026-04-12T00:00:00Z → only uids 1 and 2 (dated 04-10 and 04-11) match.
    const { result } = await executor.executeImmediate({
      tool: 'hold_by_sender',
      toolParams: {
        from: 'promoter@example.com',
        before: '2026-04-12T00:00:00Z',
      },
      accountId: ACCOUNT_ID,
      agentId: 'test',
      risk: 'medium',
    });

    const payload = JSON.parse(result[0].text);
    expect(payload.total_messages).toBe(2);
    const movedUids = payload.moved.map((m: any) => m.uid).sort();
    expect(movedUids).toEqual([1, 2]);

    // Remaining promoter messages (3,4,5) still in inbox; friend untouched.
    const s = state[ACCOUNT_ID];
    const inboxFromPromoter = s.inbox
      .filter((m) => m.from === 'promoter@example.com')
      .map((m) => m.uid)
      .sort();
    expect(inboxFromPromoter).toEqual([3, 4, 5]);
  });

  it('returns empty payload when no messages match', async () => {
    const { result } = await executor.executeImmediate({
      tool: 'hold_by_sender',
      toolParams: { from: 'nobody@nowhere.invalid' },
      accountId: ACCOUNT_ID,
      agentId: 'test',
      risk: 'medium',
    });

    const payload = JSON.parse(result[0].text);
    expect(payload.total_messages).toBe(0);
    expect(payload.moved).toEqual([]);
    expect(state[ACCOUNT_ID].moveLog).toHaveLength(0);
  });

  it('rejects unknown account_id', async () => {
    await expect(
      executor.executeImmediate({
        tool: 'hold_by_sender',
        toolParams: {
          from: 'promoter@example.com',
          account_ids: ['unknown@nowhere.invalid'],
        },
        accountId: ACCOUNT_ID,
        agentId: 'test',
        risk: 'medium',
      })
    ).rejects.toThrow(/unknown.*account/i);
  });
});
