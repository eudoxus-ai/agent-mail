import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AccountConfig } from '../../src/types.js';

// Mock pool passes calls through to a per-test configured handler
const accountImapBehavior: Record<string, any> = {};

vi.mock('../../src/provider/imap-pool.js', () => ({
  ImapConnectionPool: vi.fn().mockImplementation(function () {
    return {
      withConnection: vi.fn(async (accountId: string, fn: any) => {
        const behavior = accountImapBehavior[accountId];
        if (behavior?.throwOn === 'connect') {
          throw new Error(behavior.error ?? 'boom');
        }
        return fn(behavior?.imap ?? {});
      }),
      closeAll: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

import { ImapConnectionPool } from '../../src/provider/imap-pool.js';
import { createLogger } from '../../src/logger.js';
import { runGetOverview } from '../../src/tools/get-overview.js';

const personal: AccountConfig = {
  id: 'personal',
  email: 'you@example.com',
  imap: { host: 'imap.example.com', port: 993, tls: true },
  smtp: { host: 'smtp.example.com', port: 587, tls: true },
};
const work: AccountConfig = {
  id: 'work',
  email: 'you@work.com',
  imap: { host: 'imap.work.com', port: 993, tls: true },
  smtp: { host: 'smtp.work.com', port: 587, tls: true },
};

beforeEach(() => {
  for (const k of Object.keys(accountImapBehavior)) delete accountImapBehavior[k];
});

describe('runGetOverview', () => {
  it('returns threads for unread messages on a single account', async () => {
    const pool = new ImapConnectionPool({
      accounts: [personal],
      logger: createLogger('cli', { minLevel: 'error' }),
    });
    accountImapBehavior.personal = {
      imap: {
        searchUids: vi.fn(async (_m: string, criteria: any) => {
          if (criteria.unseen) return [101, 102];
          return [];
        }),
        fetchEnvelopes: vi.fn(async (_m: string, uids: number[]) =>
          uids.map((uid) => ({
            uid,
            messageId: `<msg-${uid}@example.com>`,
            from: { address: 'alice@example.com', name: 'Alice' },
            to: [{ address: 'you@example.com', name: null }],
            cc: [],
            date: '2026-04-12T10:00:00Z',
            subject: `Subject ${uid}`,
            bodyText: '',
            references: [],
            flags: [],
            mailbox: 'INBOX',
            snippet: `snippet ${uid}`,
            listUnsubscribe: undefined,
          }))
        ),
        fetchThreadContext: vi.fn(async () => []),
      },
    };

    const result = await runGetOverview({
      pool,
      accounts: [personal],
      input: { include: ['unread'] },
    });

    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].account_id).toBe('personal');
    expect(result.accounts[0].error).toBeNull();
    expect(result.accounts[0].threads).toHaveLength(2);
    expect(result.accounts[0].threads[0].categories).toContain('unread');
    expect(result.accounts[0].threads[0].signals).toBeDefined();
    expect(result.accounts[0].threads[0].latest_message.snippet).toMatch(/^snippet /);
    expect(result.summary.total_threads).toBe(2);
    expect(result.summary.by_category.unread).toBe(2);
  });

  it('isolates per-account failures', async () => {
    const pool = new ImapConnectionPool({
      accounts: [personal, work],
      logger: createLogger('cli', { minLevel: 'error' }),
    });
    accountImapBehavior.personal = {
      imap: {
        searchUids: vi.fn(async () => []),
        fetchEnvelopes: vi.fn(async () => []),
        fetchThreadContext: vi.fn(async () => []),
      },
    };
    accountImapBehavior.work = {
      throwOn: 'connect',
      error: 'work account is down',
    };

    const result = await runGetOverview({
      pool,
      accounts: [personal, work],
      input: { include: ['unread'] },
    });

    expect(result.accounts).toHaveLength(2);
    const workBundle = result.accounts.find((a) => a.account_id === 'work');
    expect(workBundle?.error).toContain('work account is down');
    expect(workBundle?.threads).toEqual([]);
    const personalBundle = result.accounts.find((a) => a.account_id === 'personal');
    expect(personalBundle?.error).toBeNull();
  });

  it('defaults to a 7-day window when since is omitted', async () => {
    const pool = new ImapConnectionPool({
      accounts: [personal],
      logger: createLogger('cli', { minLevel: 'error' }),
    });
    const captured: any[] = [];
    accountImapBehavior.personal = {
      imap: {
        searchUids: vi.fn(async (_m: string, criteria: any) => {
          captured.push(criteria);
          return [];
        }),
        fetchEnvelopes: vi.fn(async () => []),
        fetchThreadContext: vi.fn(async () => []),
      },
    };

    const before = Date.now();
    await runGetOverview({
      pool,
      accounts: [personal],
      input: { include: ['unread'] },
    });
    const after = Date.now();

    const unreadCriteria = captured.find((c) => c.unseen);
    expect(unreadCriteria).toBeDefined();
    const sinceMs = new Date(unreadCriteria.since).getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(sinceMs).toBeGreaterThanOrEqual(before - sevenDaysMs - 5000);
    expect(sinceMs).toBeLessThanOrEqual(after - sevenDaysMs + 5000);
  });
});

describe('runGetOverview — all categories', () => {
  it('returns flagged, recent_direct, awaiting_you', async () => {
    const pool = new ImapConnectionPool({
      accounts: [personal],
      logger: createLogger('cli', { minLevel: 'error' }),
    });

    accountImapBehavior.personal = {
      imap: {
        searchUids: vi.fn(async (_m: string, criteria: any) => {
          if (criteria.unseen) return [101];
          if (criteria.flagged) return [201];
          if (criteria.unanswered) return [301];
          // recent_direct is a plain since query
          if (criteria.since && !criteria.unseen && !criteria.flagged && !criteria.unanswered) {
            return [401];
          }
          return [];
        }),
        fetchEnvelopes: vi.fn(async (_m: string, uids: number[]) =>
          uids.map((uid) => ({
            uid,
            messageId: `<m${uid}@x.com>`,
            from: { address: 'alice@x.com', name: null },
            to: [{ address: 'you@example.com', name: null }],
            cc: [],
            date: '2026-04-12T10:00:00Z',
            subject: `s${uid}`,
            bodyText: '',
            references: [],
            flags: [],
            mailbox: 'INBOX',
            snippet: `snip ${uid}`,
            listUnsubscribe: undefined,
          }))
        ),
        fetchThreadContext: vi.fn(async () => []),
      },
    };

    const result = await runGetOverview({
      pool,
      accounts: [personal],
      input: {},
    });

    const threads = result.accounts[0].threads;
    const uids = threads.map((t) => t.latest_message.uid);
    expect(uids).toContain(101);
    expect(uids).toContain(201);
    expect(uids).toContain(301);
    expect(uids).toContain(401);
  });

  it('dedupes threads that appear in multiple categories', async () => {
    const pool = new ImapConnectionPool({
      accounts: [personal],
      logger: createLogger('cli', { minLevel: 'error' }),
    });

    // Same UID 999 appears in both unread and flagged
    accountImapBehavior.personal = {
      imap: {
        searchUids: vi.fn(async (_m: string, criteria: any) => {
          if (criteria.unseen) return [999];
          if (criteria.flagged) return [999];
          return [];
        }),
        fetchEnvelopes: vi.fn(async (_m: string, uids: number[]) =>
          uids.map((uid) => ({
            uid,
            messageId: `<shared@x.com>`,
            from: { address: 'alice@x.com', name: null },
            to: [{ address: 'you@example.com', name: null }],
            cc: [],
            date: '2026-04-12T10:00:00Z',
            subject: 'shared',
            bodyText: '',
            references: [],
            flags: ['\\Flagged'],
            mailbox: 'INBOX',
            snippet: 'shared snippet',
            listUnsubscribe: undefined,
          }))
        ),
        fetchThreadContext: vi.fn(async () => []),
      },
    };

    const result = await runGetOverview({
      pool,
      accounts: [personal],
      input: { include: ['unread', 'flagged'] },
    });

    expect(result.accounts[0].threads).toHaveLength(1);
    const categories = result.accounts[0].threads[0].categories;
    expect(categories).toContain('unread');
    expect(categories).toContain('flagged');
  });

  it('filters recent_direct to messages where you are in to', async () => {
    const pool = new ImapConnectionPool({
      accounts: [personal],
      logger: createLogger('cli', { minLevel: 'error' }),
    });

    accountImapBehavior.personal = {
      imap: {
        searchUids: vi.fn(async (_m: string, criteria: any) => {
          if (criteria.since && !criteria.unseen && !criteria.flagged && !criteria.unanswered) {
            return [500, 501];
          }
          return [];
        }),
        fetchEnvelopes: vi.fn(async (_m: string, uids: number[]) =>
          uids.map((uid) => {
            const direct = uid === 500;
            return {
              uid,
              messageId: `<m${uid}@x.com>`,
              from: { address: 'alice@x.com', name: null },
              to: direct
                ? [{ address: 'you@example.com', name: null }]
                : [{ address: 'list@x.com', name: null }],
              cc: [],
              date: '2026-04-12T10:00:00Z',
              subject: `s${uid}`,
              bodyText: '',
              references: [],
              flags: [],
              mailbox: 'INBOX',
              snippet: `snip ${uid}`,
              listUnsubscribe: undefined,
            };
          })
        ),
        fetchThreadContext: vi.fn(async () => []),
      },
    };

    const result = await runGetOverview({
      pool,
      accounts: [personal],
      input: { include: ['recent_direct'] },
    });

    const uids = result.accounts[0].threads.map((t) => t.latest_message.uid);
    expect(uids).toContain(500); // direct-to-you
    expect(uids).not.toContain(501); // not direct
  });

  it('filters awaiting_you to threads where state is awaiting_you', async () => {
    const pool = new ImapConnectionPool({
      accounts: [personal],
      logger: createLogger('cli', { minLevel: 'error' }),
    });

    accountImapBehavior.personal = {
      imap: {
        searchUids: vi.fn(async (_m: string, criteria: any) => {
          if (criteria.unanswered) return [700];
          return [];
        }),
        fetchEnvelopes: vi.fn(async (_m: string, uids: number[]) =>
          uids.map((uid) => ({
            uid,
            messageId: `<m${uid}@x.com>`,
            from: { address: 'list@newsletter.com', name: null },
            to: [{ address: 'you@example.com', name: null }],
            cc: [],
            date: '2026-04-12T10:00:00Z',
            subject: `s${uid}`,
            bodyText: '',
            references: [],
            flags: [],
            mailbox: 'INBOX',
            snippet: 'newsletter',
            listUnsubscribe: '<https://newsletter.com/unsub>',
          }))
        ),
        fetchThreadContext: vi.fn(async () => []),
      },
    };

    const result = await runGetOverview({
      pool,
      accounts: [personal],
      input: { include: ['awaiting_you'] },
    });

    // List mail should NOT be awaiting_you even though UNANSWERED
    expect(result.accounts[0].threads).toHaveLength(0);
  });
});

describe('runGetOverview — recommendations', () => {
  it('sets recommendations when >30 distinct senders each have >=4 threads', async () => {
    const pool = new ImapConnectionPool({
      accounts: [personal],
      logger: createLogger('cli', { minLevel: 'error' }),
    });

    // 31 distinct senders, each appearing as the from address on 4 UIDs
    const SENDER_COUNT = 31;
    const MSGS_PER_SENDER = 4;
    const allUids: number[] = [];
    const uidToSender: Record<number, string> = {};
    let uid = 1;
    for (let s = 0; s < SENDER_COUNT; s++) {
      for (let m = 0; m < MSGS_PER_SENDER; m++) {
        uidToSender[uid] = `sender${s}@example.com`;
        allUids.push(uid);
        uid++;
      }
    }

    accountImapBehavior.personal = {
      imap: {
        searchUids: vi.fn(async (_m: string, criteria: any) => {
          if (criteria.unseen) return allUids;
          return [];
        }),
        fetchEnvelopes: vi.fn(async (_m: string, uids: number[]) =>
          uids.map((u) => ({
            uid: u,
            messageId: `<msg-${u}@example.com>`,
            from: { address: uidToSender[u], name: null },
            to: [{ address: 'you@example.com', name: null }],
            cc: [],
            date: '2026-04-12T10:00:00Z',
            subject: `Subject ${u}`,
            bodyText: '',
            references: [],
            flags: [],
            mailbox: 'INBOX',
            snippet: `snippet ${u}`,
            listUnsubscribe: undefined,
          }))
        ),
        fetchThreadContext: vi.fn(async () => []),
      },
    };

    const result = await runGetOverview({
      pool,
      accounts: [personal],
      input: { include: ['unread'], limit_per_category: SENDER_COUNT * MSGS_PER_SENDER },
    });

    expect(result.recommendations).toBeDefined();
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations![0]).toContain('list_senders');
  });

  it('omits recommendations when senders are below threshold', async () => {
    const pool = new ImapConnectionPool({
      accounts: [personal],
      logger: createLogger('cli', { minLevel: 'error' }),
    });

    // Only 5 distinct senders, each with 4 messages — well under 30
    const allUids: number[] = [];
    const uidToSender: Record<number, string> = {};
    let uid = 1;
    for (let s = 0; s < 5; s++) {
      for (let m = 0; m < 4; m++) {
        uidToSender[uid] = `sender${s}@example.com`;
        allUids.push(uid);
        uid++;
      }
    }

    accountImapBehavior.personal = {
      imap: {
        searchUids: vi.fn(async (_m: string, criteria: any) => {
          if (criteria.unseen) return allUids;
          return [];
        }),
        fetchEnvelopes: vi.fn(async (_m: string, uids: number[]) =>
          uids.map((u) => ({
            uid: u,
            messageId: `<msg-${u}@example.com>`,
            from: { address: uidToSender[u], name: null },
            to: [{ address: 'you@example.com', name: null }],
            cc: [],
            date: '2026-04-12T10:00:00Z',
            subject: `Subject ${u}`,
            bodyText: '',
            references: [],
            flags: [],
            mailbox: 'INBOX',
            snippet: `snippet ${u}`,
            listUnsubscribe: undefined,
          }))
        ),
        fetchThreadContext: vi.fn(async () => []),
      },
    };

    const result = await runGetOverview({
      pool,
      accounts: [personal],
      input: { include: ['unread'] },
    });

    expect(result.recommendations).toBeUndefined();
  });
});

describe('runGetOverview — thread context', () => {
  it('aggregates thread participants across messages', async () => {
    const pool = new ImapConnectionPool({
      accounts: [personal],
      logger: createLogger('cli', { minLevel: 'error' }),
    });

    accountImapBehavior.personal = {
      imap: {
        searchUids: vi.fn(async (_m: string, criteria: any) => {
          if (criteria.unseen) return [12];
          return [];
        }),
        fetchEnvelopes: vi.fn(async (_m: string, uids: number[]) =>
          uids.map(() => ({
            uid: 12,
            messageId: '<m2@x.com>',
            from: { address: 'bob@x.com', name: null },
            to: [{ address: 'you@example.com', name: null }],
            cc: [{ address: 'carol@x.com', name: null }],
            date: '2026-04-12T11:00:00Z',
            subject: 'Re: planning',
            bodyText: '',
            inReplyTo: '<m1@x.com>',
            references: ['<m1@x.com>'],
            flags: [],
            mailbox: 'INBOX',
            snippet: 'latest reply',
            listUnsubscribe: undefined,
          }))
        ),
        fetchThreadContext: vi.fn(async (_m: string, _rootIds: string[]) => [
          {
            uid: 11,
            messageId: '<m1@x.com>',
            from: { address: 'alice@x.com', name: null },
            to: [{ address: 'bob@x.com', name: null }],
            cc: [],
            date: '2026-04-12T10:00:00Z',
            subject: 'planning',
            bodyText: '',
            references: [],
            flags: [],
            mailbox: 'INBOX',
            snippet: 'earlier message',
            listUnsubscribe: undefined,
          },
          {
            uid: 12,
            messageId: '<m2@x.com>',
            from: { address: 'bob@x.com', name: null },
            to: [{ address: 'you@example.com', name: null }],
            cc: [{ address: 'carol@x.com', name: null }],
            date: '2026-04-12T11:00:00Z',
            subject: 'Re: planning',
            bodyText: '',
            inReplyTo: '<m1@x.com>',
            references: ['<m1@x.com>'],
            flags: [],
            mailbox: 'INBOX',
            snippet: 'latest reply',
            listUnsubscribe: undefined,
          },
        ]),
      },
    };

    const result = await runGetOverview({
      pool,
      accounts: [personal],
      input: { include: ['unread'] },
    });

    const thread = result.accounts[0].threads[0];
    expect(thread.thread.message_count).toBe(2);
    expect(thread.signals.thread_participant_count).toBeGreaterThanOrEqual(3);
    const addrs = thread.signals.thread_participants.map((p) => p.address);
    expect(addrs).toContain('alice@x.com');
    expect(addrs).toContain('bob@x.com');
    expect(addrs).toContain('carol@x.com');
    expect(addrs).toContain('you@example.com');
    expect(thread.signals.thread_state).toBe('awaiting_you');
  });

  it('marks thread.truncated when thread is longer than the tail window', async () => {
    const pool = new ImapConnectionPool({
      accounts: [personal],
      logger: createLogger('cli', { minLevel: 'error' }),
    });

    const buildMsg = (uid: number) => ({
      uid,
      messageId: `<m${uid}@x.com>`,
      from: { address: uid % 2 === 0 ? 'alice@x.com' : 'bob@x.com', name: null },
      to: [{ address: 'you@example.com', name: null }],
      cc: [],
      date: new Date(2026, 3, 12, 10, uid).toISOString(),
      subject: 'long thread',
      bodyText: '',
      references: ['<m1@x.com>'],
      inReplyTo: uid > 1 ? `<m${uid - 1}@x.com>` : undefined,
      flags: [],
      mailbox: 'INBOX',
      snippet: `msg ${uid}`,
      listUnsubscribe: undefined,
    });

    accountImapBehavior.personal = {
      imap: {
        searchUids: vi.fn(async (_m: string, criteria: any) => {
          if (criteria.unseen) return [10];
          return [];
        }),
        fetchEnvelopes: vi.fn(async (_m: string, uids: number[]) =>
          uids.map((u) => buildMsg(u))
        ),
        fetchThreadContext: vi.fn(async () =>
          Array.from({ length: 10 }, (_, i) => buildMsg(i + 1))
        ),
      },
    };

    const result = await runGetOverview({
      pool,
      accounts: [personal],
      input: { include: ['unread'] },
    });

    const thread = result.accounts[0].threads[0];
    expect(thread.thread.message_count).toBe(10);
    expect(thread.thread.truncated).toBe(true);
  });
});
