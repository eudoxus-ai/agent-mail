import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { openCache, type Database } from '../../src/cache/db.js';
import { upsertMessage } from '../../src/cache/store.js';
import { upsertMailboxState } from '../../src/cache/state.js';
import { createLogger } from '../../src/logger.js';
import type { AccountConfig, EmailMessage, Participant } from '../../src/types.js';

/**
 * search_threads as a view of conversations: who each message went to, which
 * conversation it belongs to, whether the operator wrote it, and whether the
 * operator has ever written to its sender.
 */

const logger = createLogger('cli', { minLevel: 'error' });
const ACCOUNTS: AccountConfig[] = ['work', 'home'].map((id) => ({
  id,
  email: `${id}@example.com`,
  imap: { host: 'h', port: 993, tls: true },
  smtp: { host: 'h', port: 465, tls: true },
}));

const p = (address: string, name: string | null = null): Participant => ({ address, name });
const day = (d: number) => new Date(Date.UTC(2026, 5, d)).toISOString();

let cache: Database;

function add(accountId: string, mailbox: string, uid: number, m: Partial<EmailMessage>) {
  upsertMessage(cache, {
    accountId,
    uidvalidity: 1,
    message: {
      uid,
      messageId: `<${accountId}-${mailbox}-${uid}@x>`,
      from: p('alice@example.com', 'Alice'),
      to: [],
      cc: [],
      date: day(1),
      subject: 'Hello',
      bodyText: '',
      references: [],
      flags: [],
      mailbox,
      ...m,
    },
  });
}

function synced(accountId: string, mailbox: string, lastDeltaAt = Date.now()) {
  upsertMailboxState(cache, accountId, mailbox, { backfill_complete: 1, last_delta_at: lastDeltaAt });
}

function executor(opts: { cache?: Database; pool?: unknown } = {}) {
  return new Executor({
    db: openDatabase(':memory:'),
    accounts: ACCOUNTS,
    pool: (opts.pool ?? {
      withConnection: vi.fn(async () => {
        throw new Error('IMAP must not be used');
      }),
    }) as never,
    logger,
    cache: 'cache' in opts ? opts.cache : cache,
    cacheConfig: { mode: 'on', freshnessWindowSeconds: 3600 } as never,
  });
}

async function search(ex: Executor, params: Record<string, unknown>) {
  const { result } = await ex.executeImmediate({
    tool: 'search_threads',
    toolParams: params,
    accountId: 'work',
    agentId: 'test',
    risk: 'none',
  });
  return JSON.parse(result[0].text);
}

beforeEach(() => {
  cache = openCache(':memory:');
  // Alice writes to work, copying Bob.
  add('work', 'INBOX', 1, {
    messageId: '<a1@x>',
    to: [p('work@example.com')],
    cc: [p('bob@example.com', 'Bob')],
    date: day(1),
  });
  // The operator answers from work's Gmail sent folder...
  add('work', '[Gmail]/Sent Mail', 1, {
    messageId: '<r1@x>',
    from: p('work@example.com'),
    to: [p('alice@example.com')],
    inReplyTo: '<a1@x>',
    references: ['<a1@x>'],
    date: day(2),
  });
  // ...and copies her, in another case, from home's differently named one,
  // through an alias no account is configured with.
  add('home', 'INBOX.Sent Messages', 1, {
    messageId: '<r2@x>',
    from: p('me@alias.example'),
    to: [p('carol@example.com')],
    cc: [p('Alice@Example.com')],
    date: day(3),
  });
  // A note to self, from a configured address but sitting in INBOX.
  add('work', 'INBOX', 2, { from: p('work@example.com'), to: [p('work@example.com')], date: day(4) });
  // Alice's follow-up, since archived.
  add('work', 'Archive', 1, {
    messageId: '<a2@x>',
    inReplyTo: '<r1@x>',
    references: ['<a1@x>', '<r1@x>'],
    date: day(5),
  });
  // Someone the operator has never written to.
  add('work', 'INBOX', 3, { from: p('dave@example.com'), to: [p('work@example.com')], date: day(6) });

  for (const [accountId, mailbox] of [
    ['work', 'INBOX'],
    ['work', '[Gmail]/Sent Mail'],
    ['work', 'Archive'],
    ['home', 'INBOX'],
    ['home', 'INBOX.Sent Messages'],
  ]) {
    synced(accountId, mailbox);
  }
});

const where = (r: { account_id: string; mailbox: string; uid: number }) =>
  `${r.account_id} ${r.mailbox} ${r.uid}`;

describe('search_threads conversation fields from the cache', () => {
  const STALE = Date.now() - 2 * 3600 * 1000;

  it('does not answer include_sent from the cache when a sent mailbox is stale', async () => {
    synced('work', '[Gmail]/Sent Mail', STALE);
    const search_ = vi.fn(async () => []);
    const imap = { search: search_, sentMailboxes: vi.fn(async () => ['[Gmail]/Sent Mail']) };
    const ex = executor({
      pool: { withConnection: vi.fn(async (_id: string, fn: (i: unknown) => unknown) => fn(imap)) },
    });

    const payload = await search(ex, { account_ids: ['work'], include_sent: true });

    expect(payload.cache).toBeUndefined();
    expect(search_.mock.calls.map((c) => c[0])).toEqual(['INBOX', '[Gmail]/Sent Mail']);
  });

  it('reports replies as unknown, not zero, when sent mail is stale', async () => {
    synced('home', 'INBOX.Sent Messages', STALE);

    const payload = await search(executor(), { account_ids: ['work'] });

    expect(payload.cache.state).toBe('fresh');
    expect(payload.results.map((r: { replied_to_sender: unknown }) => r.replied_to_sender)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('reports recipients, thread, authorship and replies per message', async () => {
    const payload = await search(executor(), { account_ids: ['work'] });

    expect(payload.results.map(where)).toEqual(['work INBOX 3', 'work INBOX 2', 'work INBOX 1']);
    const [dave, note, alice] = payload.results;

    expect(alice).toMatchObject({
      to: [{ address: 'work@example.com', name: null }],
      cc: [{ address: 'bob@example.com', name: 'Bob' }],
      in_reply_to: null,
      from_me: false,
      // One reply from work, one copy from home: replies count every account.
      replied_to_sender: 2,
    });
    expect(typeof alice.thread_id).toBe('string');

    expect(note).toMatchObject({ from_me: true });
    expect(dave).toMatchObject({ from_me: false, replied_to_sender: 0 });
  });

  it('projects the new fields by name', async () => {
    const payload = await search(executor(), {
      account_ids: ['work'],
      fields: ['uid', 'cc', 'from_me', 'replied_to_sender'],
    });
    expect(payload.results.at(-1)).toEqual({
      uid: 1,
      cc: [{ address: 'bob@example.com', name: 'Bob' }],
      from_me: false,
      replied_to_sender: 2,
    });
  });

  it('merges every account\'s sent mailbox into one date-ordered result with include_sent', async () => {
    const without = await search(executor(), { account_ids: ['work', 'home'] });
    expect(without.results.map(where)).toEqual(['work INBOX 3', 'work INBOX 2', 'work INBOX 1']);

    const withSent = await search(executor(), { account_ids: ['work', 'home'], include_sent: true });
    expect(withSent.results.map(where)).toEqual([
      'work INBOX 3',
      'work INBOX 2',
      'home INBOX.Sent Messages 1',
      'work [Gmail]/Sent Mail 1',
      'work INBOX 1',
    ]);
    expect(withSent.results.map((r: { from_me: boolean }) => r.from_me)).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
  });

  it('pulls a whole conversation across mailboxes with thread_id, ignoring mailbox', async () => {
    const first = await search(executor(), { account_ids: ['work'] });
    const threadId = first.results.at(-1).thread_id;

    const thread = await search(executor(), { account_ids: ['work'], mailbox: 'INBOX', thread_id: threadId });

    expect(thread.results.map(where)).toEqual([
      'work Archive 1',
      'work [Gmail]/Sent Mail 1',
      'work INBOX 1',
    ]);
    expect(thread.results.every((r: { thread_id: string }) => r.thread_id === threadId)).toBe(true);
    expect(thread.results[1]).toMatchObject({ in_reply_to: '<a1@x>', from_me: true });
  });

  it('refuses a thread_id search the cache cannot answer instead of searching INBOX', async () => {
    await expect(
      search(executor({ cache: undefined }), { thread_id: 'whatever' })
    ).rejects.toThrow(/answered only from the local cache/);

    synced('home', 'INBOX', Date.now() - 24 * 60 * 60 * 1000);
    await expect(search(executor(), { thread_id: 'whatever' })).rejects.toThrow(
      /answered only from the local cache, and the local cache is stale/
    );
  });
});

describe('search_threads conversation fields from the mail server', () => {
  function hit(uid: number, from: string, date: string, extra: Record<string, unknown> = {}) {
    return {
      uid,
      envelope: { message_id: `<${uid}@x>`, subject: 's', from: p(from), date },
      to: [p('work@example.com')],
      cc: [p('bob@example.com')],
      in_reply_to: '<parent@x>',
      snippet: '',
      flags: [],
      list_id: null,
      list_unsubscribe: null,
      ...extra,
    };
  }

  it('passes recipients through, marks sent mail, and leaves cache-only fields null', async () => {
    const search_ = vi.fn(async (mailbox: string) =>
      mailbox === 'INBOX'
        ? [hit(1, 'alice@example.com', day(1)), hit(2, 'WORK@example.com', day(3))]
        : [hit(9, 'someone@else.example', day(2))]
    );
    const imap = { search: search_, sentMailboxes: vi.fn(async () => ['Sent Items']) };
    const ex = executor({
      cache: undefined,
      pool: { withConnection: vi.fn(async (_id: string, fn: (i: unknown) => unknown) => fn(imap)) },
    });

    const payload = await search(ex, { account_ids: ['work'], include_sent: true });

    expect(search_.mock.calls.map((c) => c[0])).toEqual(['INBOX', 'Sent Items']);
    expect(payload.results.map(where)).toEqual(['work INBOX 2', 'work Sent Items 9', 'work INBOX 1']);
    expect(payload.results.map((r: { from_me: boolean }) => r.from_me)).toEqual([true, true, false]);
    expect(payload.results[2]).toMatchObject({
      to: [{ address: 'work@example.com', name: null }],
      cc: [{ address: 'bob@example.com', name: null }],
      in_reply_to: '<parent@x>',
      thread_id: null,
      replied_to_sender: null,
    });
  });

  it('classifies an automated sender as a notification', async () => {
    const imap = { search: vi.fn(async () => [hit(1, 'no-reply@service.example', day(1))]) };
    const ex = executor({
      cache: undefined,
      pool: { withConnection: vi.fn(async (_id: string, fn: (i: unknown) => unknown) => fn(imap)) },
    });

    const payload = await search(ex, { account_ids: ['work'] });
    expect(payload.results[0].category).toBe('notification');
  });
});
