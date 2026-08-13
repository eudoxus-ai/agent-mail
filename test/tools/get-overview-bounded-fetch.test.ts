import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AccountConfig } from '../../src/types.js';

const accountImapBehavior: Record<string, any> = {};

vi.mock('../../src/provider/imap-pool.js', () => ({
  ImapConnectionPool: vi.fn().mockImplementation(function () {
    return {
      withConnection: vi.fn(async (accountId: string, fn: any) => {
        const behavior = accountImapBehavior[accountId];
        return fn(behavior?.imap ?? {});
      }),
      closeAll: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

import { ImapConnectionPool } from '../../src/provider/imap-pool.js';
import { createLogger } from '../../src/logger.js';
import { runGetOverview, getOverviewTool, MAX_OVERVIEW_FETCH_UIDS } from '../../src/tools/get-overview.js';

const personal: AccountConfig = {
  id: 'personal',
  email: 'you@example.com',
  imap: { host: 'imap.example.com', port: 993, tls: true },
  smtp: { host: 'smtp.example.com', port: 587, tls: true },
};

beforeEach(() => {
  for (const k of Object.keys(accountImapBehavior)) delete accountImapBehavior[k];
});

/** Build a fake imap whose per-category searchUids result is configurable. */
function makeImap(
  perCategory: Record<string, number[]>,
  capture: { fetchedUids: number[] }
) {
  return {
    // searchUids is called once per category with a distinguishing criterion:
    //   unread        → { unseen: true }
    //   flagged       → { flagged: true }
    //   recent_direct → { since } only
    //   awaiting_you  → { unanswered: true }
    searchUids: vi.fn(async (_m: string, criteria: any) => {
      if (criteria.unseen) return perCategory.unread ?? [];
      if (criteria.flagged) return perCategory.flagged ?? [];
      if (criteria.unanswered) return perCategory.awaiting_you ?? [];
      return perCategory.recent_direct ?? [];
    }),
    fetchEnvelopes: vi.fn(async (_m: string, uids: number[]) => {
      capture.fetchedUids = uids;
      return uids.map((uid) => ({
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
      }));
    }),
    fetchThreadContext: vi.fn(async () => []),
  };
}

describe('get_overview bounded envelope fetch', () => {
  it('caps the fetchEnvelopes UID set at MAX_OVERVIEW_FETCH_UIDS even with many candidates', async () => {
    // Return far more candidate UIDs than the cap across multiple categories.
    const manyUids = Array.from({ length: 1000 }, (_, i) => i + 1);
    const capture = { fetchedUids: [] as number[] };

    const pool = new ImapConnectionPool({
      accounts: [personal],
      logger: createLogger('cli', { minLevel: 'error' }),
    });
    accountImapBehavior.personal = {
      imap: makeImap({ unread: manyUids, flagged: manyUids }, capture),
    };

    await runGetOverview({
      pool,
      accounts: [personal],
      // Large limit_per_category so the per-category clip doesn't hide the cap.
      input: { include: ['unread', 'flagged'], limit_per_category: 1000 },
    });

    // The overall safety ceiling still caps the fetch.
    expect(capture.fetchedUids.length).toBeLessThanOrEqual(MAX_OVERVIEW_FETCH_UIDS);
  });

  it('does not starve a small low-UID category under a global newest-by-UID cap', async () => {
    // A large category of HIGH uids that, alone, would fill the global cap, and
    // a small `flagged` category of LOW uids. The old global newest-by-UID
    // slice across the union would drop every flagged (low) uid. The per-
    // category bound must keep the small category's uids in the fetch.
    const highUids = Array.from({ length: 1000 }, (_, i) => i + 5001); // 5001..6000
    const lowFlagged = [1, 2, 3]; // older, lower uids
    const capture = { fetchedUids: [] as number[] };

    const pool = new ImapConnectionPool({
      accounts: [personal],
      logger: createLogger('cli', { minLevel: 'error' }),
    });
    accountImapBehavior.personal = {
      imap: makeImap({ unread: highUids, flagged: lowFlagged }, capture),
    };

    await runGetOverview({
      pool,
      accounts: [personal],
      input: { include: ['unread', 'flagged'], limit_per_category: 1000 },
    });

    // The small flagged category survived — none of its low uids were dropped.
    for (const uid of lowFlagged) {
      expect(capture.fetchedUids).toContain(uid);
    }
    // And the overall fetch is still bounded.
    expect(capture.fetchedUids.length).toBeLessThanOrEqual(MAX_OVERVIEW_FETCH_UIDS);
  });

  it('schema accepts an `async` boolean', () => {
    expect(getOverviewTool.inputSchema.parse({ async: true }).async).toBe(true);
    expect(getOverviewTool.inputSchema.parse({}).async).toBeUndefined();
  });
});
