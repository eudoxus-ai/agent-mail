import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import type { Database } from '../../src/ledger/sqlite.js';
import { createLogger } from '../../src/logger.js';
import { getIntent, getIntentProgress } from '../../src/ledger/intents.js';
import { getIntentTargets } from '../../src/ledger/intent-targets.js';
import type { AccountConfig } from '../../src/types.js';

vi.mock('../../src/provider/credentials.js', () => ({
  resolveCredentials: vi.fn((account: any) => ({
    ...account,
    auth: { user: account.email, pass: 'pw' },
  })),
}));

const { Executor } = await import('../../src/executor/executor.js');
const { parseSweep } = await import('../../src/tools/hold-by-sender.js');

const account = (id: string): AccountConfig => ({
  id,
  email: `${id}@example.com`,
  imap: { host: 'h', port: 993, tls: true },
  smtp: { host: 'h', port: 587, tls: true },
});
const accounts = [account('one'), account('two')];

let db: Database;

function fakeImap(opts: {
  matches?: (criteria: any) => number[];
  missing?: number[];
  hasReplies?: (ids: string[]) => boolean;
} = {}) {
  const missing = new Set(opts.missing ?? []);
  return {
    search: vi.fn(async (_m: string, criteria: any) =>
      (opts.matches?.(criteria) ?? []).map((uid) => ({ uid }))
    ),
    searchUids: vi.fn(async () => []),
    getMailboxPath: vi.fn(async () => 'agent-mail-holding'),
    mailboxSnapshot: vi.fn(async () => ({
      uidValidity: 42,
      uidNext: 1000,
      highestModseq: 10,
      exists: 5,
    })),
    fetchEnvelopes: vi.fn(async (_m: string, uids: number[]) =>
      uids
        .filter((uid) => !missing.has(uid))
        .map((uid) => ({
          uid,
          messageId: `<${uid}@x>`,
          subject: `Subject ${uid}`,
          from: { address: 'a@example.com', name: null },
        }))
    ),
    moveMessages: vi.fn(async (uids: number[]) => ({
      uidMap: new Map(uids.map((u) => [u, u + 9000])),
    })),
    hasRepliesTo: vi.fn(async (_m: string, ids: string[]) => opts.hasReplies?.(ids) ?? false),
  };
}

function makeExecutor(imap: ReturnType<typeof fakeImap>) {
  return new Executor({
    db,
    accounts,
    pool: {
      withConnection: vi.fn(async (_a: string, fn: (i: unknown) => Promise<unknown>) => fn(imap)),
    } as never,
    logger: createLogger('cli', { minLevel: 'error' }),
  });
}

async function run(
  imap: ReturnType<typeof fakeImap>,
  tool: string,
  toolParams: Record<string, unknown>
) {
  const { intent, result } = await makeExecutor(imap).executeImmediate({
    tool,
    toolParams,
    accountId: 'one',
    agentId: 'test',
    risk: 'medium',
  });
  return { intent, payload: JSON.parse(result[0].text) };
}

const target = (uid: number) => ({ account_id: 'one', uid, mailbox: 'INBOX' });

beforeEach(() => {
  db = openDatabase(':memory:');
});

describe('hold_messages with a UID that no longer exists', () => {
  it('moves the rest and reports the missing one', async () => {
    const imap = fakeImap({ missing: [2] });
    const { payload } = await run(imap, 'hold_messages', {
      targets: [target(1), target(2), target(3)],
    });

    expect(imap.moveMessages.mock.calls[0][0]).toEqual([1, 3]);
    expect(payload.total_messages).toBe(2);
    expect(payload.errors).toEqual([
      expect.objectContaining({ uid: 2, account_id: 'one', mailbox: 'INBOX' }),
    ]);
  });

  it('never moves a message it could not record for restore', async () => {
    const imap = fakeImap({ missing: [1, 2] });
    const { intent, payload } = await run(imap, 'hold_messages', {
      targets: [target(1), target(2)],
    });

    expect(imap.moveMessages).not.toHaveBeenCalled();
    expect(payload.total_messages).toBe(0);
    expect(getIntentTargets(db, intent.id)).toHaveLength(0);
  });

  it('keeps the outcome where a queued caller can read it', async () => {
    const imap = fakeImap({ missing: [2] });
    const { intent } = await run(imap, 'hold_messages', { targets: [target(1), target(2)] });

    const progress = getIntentProgress(db, intent.id);
    expect(progress?.phase).toBe('held');
    expect(progress?.detail?.errors).toHaveLength(1);
  });

  it('previews missing UIDs on a dry run', async () => {
    const imap = fakeImap({ missing: [2] });
    const { payload } = await run(imap, 'hold_messages', {
      targets: [target(1), target(2)],
      dry_run: true,
      include_summary: false,
    });

    expect(imap.moveMessages).not.toHaveBeenCalled();
    expect(payload.errors).toHaveLength(1);
  });
});

describe('threadHasReplies', () => {
  it('does not fail on a missing UID', async () => {
    const imap = fakeImap({ missing: [2] });
    await expect(makeExecutor(imap).threadHasReplies('one', 'INBOX', [1, 2])).resolves.toBe(false);
  });

  it('checks the messages that exist', async () => {
    const imap = fakeImap({ missing: [2], hasReplies: (ids) => ids.includes('<1@x>') });
    await expect(makeExecutor(imap).threadHasReplies('one', 'INBOX', [1, 2])).resolves.toBe(true);
  });
});

describe('hold_by_sender with a list of senders', () => {
  const senders = { 'a@x.com': [1, 2], 'b@x.com': [3], 'c@x.com': [] as number[] };
  const matches = (c: any) => senders[c.from as keyof typeof senders] ?? [];

  it('is one intent reporting per-sender outcomes', async () => {
    const imap = fakeImap({ matches });
    const { intent, payload } = await run(imap, 'hold_by_sender', {
      from: Object.keys(senders),
      account_ids: ['one'],
    });

    expect(payload.total_messages).toBe(3);
    expect(payload.senders).toEqual([
      expect.objectContaining({ from: 'a@x.com', status: 'held', messages: 2 }),
      expect.objectContaining({ from: 'b@x.com', status: 'held', messages: 1 }),
      expect.objectContaining({ from: 'c@x.com', status: 'no_match', messages: 0 }),
    ]);
    expect(getIntentTargets(db, intent.id)).toHaveLength(3);
  });

  it('does not let a blocked sender stop the others', async () => {
    const imap = fakeImap({ matches, hasReplies: (ids) => ids.includes('<1@x>') });
    const { payload } = await run(imap, 'hold_by_sender', {
      from: ['a@x.com', 'b@x.com'],
      account_ids: ['one'],
    });

    expect(payload.senders[0]).toMatchObject({ from: 'a@x.com', status: 'blocked', messages: 0 });
    expect(payload.senders[1]).toMatchObject({ from: 'b@x.com', status: 'held', messages: 1 });
    expect(imap.moveMessages.mock.calls.flatMap((c: any) => c[0])).toEqual([3]);
  });

  it('reports a sender whose search failed without stopping the others', async () => {
    const imap = fakeImap({ matches });
    imap.search.mockImplementation(async (_m: string, c: any) => {
      if (c.from === 'a@x.com') throw new Error('IMAP search failed in INBOX');
      return (matches(c) ?? []).map((uid) => ({ uid })) as never;
    });
    const { payload } = await run(imap, 'hold_by_sender', {
      from: ['a@x.com', 'b@x.com'],
      account_ids: ['one'],
    });

    expect(payload.senders[0]).toMatchObject({ status: 'failed', messages: 0 });
    expect(payload.senders[1]).toMatchObject({ status: 'held', messages: 1 });
  });

  it('fails the intent when every sender failed', async () => {
    const imap = fakeImap();
    imap.search.mockRejectedValue(new Error('IMAP search failed in INBOX'));

    await expect(
      run(imap, 'hold_by_sender', { from: ['a@x.com', 'b@x.com'], account_ids: ['one'] })
    ).rejects.toThrow(/Every sender failed/);
  });

  it('records the outcomes for a queued caller', async () => {
    const imap = fakeImap({ matches });
    const { intent } = await run(imap, 'hold_by_sender', {
      from: ['a@x.com', 'c@x.com'],
      account_ids: ['one'],
    });

    const progress = getIntentProgress(db, intent.id);
    expect(progress?.phase).toBe('batch_complete');
    expect(progress?.detail?.senders).toHaveLength(2);
  });

  it('moves nothing on a dry run', async () => {
    const imap = fakeImap({ matches });
    const { payload } = await run(imap, 'hold_by_sender', {
      from: ['a@x.com'],
      account_ids: ['one'],
      dry_run: true,
    });

    expect(imap.moveMessages).not.toHaveBeenCalled();
    expect(payload.senders[0]).toMatchObject({ status: 'held', messages: 2 });
  });
});

describe('hold_by_sender with a List-Id', () => {
  it('searches the header and holds the matches', async () => {
    const imap = fakeImap({ matches: (c) => (c.listId === 'cto.groups.io' ? [5, 6] : []) });
    const { payload } = await run(imap, 'hold_by_sender', {
      list_id: 'cto.groups.io',
      account_ids: ['one'],
    });

    expect(payload.total_messages).toBe(2);
    expect(imap.search.mock.calls[0][1].from).toBeUndefined();
  });

  it('says what it searched for when nothing matches', async () => {
    const { payload } = await run(fakeImap(), 'hold_by_sender', {
      list_id: 'cto.groups.io',
      account_ids: ['one'],
    });

    expect(payload.status).toBe('no_match');
    expect(payload.searched.list_id).toBe('cto.groups.io');
    expect(payload.diagnosis).toContain('List-Id');
  });
});

describe('parseSweep', () => {
  it('accepts one sender without account_ids', () => {
    expect(parseSweep({ from: 'a@x.com' })).toEqual({ senders: ['a@x.com'], batch: false });
  });

  it('requires account_ids for a list', () => {
    expect(() => parseSweep({ from: ['a@x.com'] })).toThrow(/account_ids/);
  });

  it('requires account_ids for a List-Id', () => {
    expect(() => parseSweep({ list_id: 'x.groups.io' })).toThrow(/account_ids/);
  });

  it('refuses both or neither of from and list_id', () => {
    expect(() => parseSweep({})).toThrow(/exactly one/);
    expect(() => parseSweep({ from: 'a@x.com', list_id: 'x.io', account_ids: ['one'] })).toThrow(
      /exactly one/
    );
  });
});

describe('cancel_intent', () => {
  async function queued(executor: InstanceType<typeof Executor>) {
    return executor.enqueue({
      tool: 'hold_by_sender',
      toolParams: { from: 'a@x.com' },
      accountId: 'one',
      agentId: 'test',
      risk: 'medium',
    });
  }

  it('cancels queued work so nothing will claim it', async () => {
    const imap = fakeImap();
    const executor = makeExecutor(imap);
    const intent = await queued(executor);

    const { result } = await executor.executeImmediate({
      tool: 'cancel_intent',
      toolParams: { intent_ids: [intent.id] },
      accountId: 'one',
      agentId: 'test',
      risk: 'low',
    });

    expect(JSON.parse(result[0].text).results[0]).toMatchObject({
      intent_id: intent.id,
      cancelled: true,
    });
    expect(getIntent(db, intent.id)?.status).toBe('rejected');
  });

  it('reports each id it could not cancel and why', async () => {
    const imap = fakeImap();
    const executor = makeExecutor(imap);
    const intent = await queued(executor);
    db.prepare(`UPDATE intents SET status = 'executing' WHERE id = ?`).run(intent.id);

    const { result } = await executor.executeImmediate({
      tool: 'cancel_intent',
      toolParams: { intent_ids: [intent.id, 'nope'] },
      accountId: 'one',
      agentId: 'test',
      risk: 'low',
    });

    const { results, cancelled } = JSON.parse(result[0].text);
    expect(cancelled).toBe(0);
    expect(results[0]).toMatchObject({ cancelled: false, status: 'executing' });
    expect(results[1]).toMatchObject({ cancelled: false, status: 'not_found' });
    expect(getIntent(db, intent.id)?.status).toBe('executing');
  });
});

describe('sweep progress', () => {
  it('names each account as it finishes searching', async () => {
    const imap = fakeImap({ matches: () => [] });
    const executor = makeExecutor(imap);
    const seen: unknown[] = [];
    const update = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const statement = update(sql);
      if (!sql.startsWith('UPDATE intents SET progress')) return statement;
      return {
        run: (json: string, id: string) => {
          seen.push(JSON.parse(json));
          return statement.run(json, id);
        },
      };
    }) as typeof db.prepare;

    await executor.executeImmediate({
      tool: 'hold_by_sender',
      toolParams: { from: 'a@x.com', account_ids: ['one', 'two'] },
      accountId: 'one',
      agentId: 'test',
      risk: 'medium',
    });

    const searching = seen.filter((p: any) => p.phase === 'searching') as any[];
    expect(searching.at(-1).detail.searched).toEqual(expect.arrayContaining(['one', 'two']));
    expect(searching[0].detail.searched).toEqual([]);
  });
});
