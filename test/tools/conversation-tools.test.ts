import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { openCache, type Database } from '../../src/cache/db.js';
import { upsertMessage } from '../../src/cache/store.js';
import { upsertMailboxState } from '../../src/cache/state.js';
import { createLogger } from '../../src/logger.js';
import type { AccountConfig, EmailMessage, Participant } from '../../src/types.js';

/**
 * list_accounts says who the operator is; list_correspondents says who they
 * talk to. Both read only the cache and never contact a mail server.
 */

const logger = createLogger('cli', { minLevel: 'error' });
const ACCOUNTS: AccountConfig[] = ['work', 'home'].map((id) => ({
  id,
  email: `${id}@example.com`,
  imap: { host: 'h', port: 993, tls: true },
  smtp: { host: 'h', port: 465, tls: true },
}));

const p = (address: string, name: string | null = null): Participant => ({ address, name });
const day = (d: number) => Date.UTC(2026, 5, d);

let cache: Database;
let nextUid = 1;

function add(accountId: string, mailbox: string, m: Partial<EmailMessage> & { day: number }) {
  const uid = nextUid++;
  upsertMessage(cache, {
    accountId,
    uidvalidity: 1,
    message: {
      uid,
      messageId: `<${uid}@x>`,
      from: p('alice@example.com'),
      to: [],
      cc: [],
      date: new Date(day(m.day)).toISOString(),
      subject: 'Hello',
      bodyText: '',
      references: [],
      flags: [],
      mailbox,
      ...m,
    },
  });
}

function synced(accountId: string, mailbox: string, patch: Record<string, unknown> = {}) {
  upsertMailboxState(cache, accountId, mailbox, {
    backfill_complete: 1,
    last_delta_at: Date.now(),
    oldest_date: day(1),
    ...patch,
  });
}

function executor(db: Database | null = cache, mode = 'on') {
  return new Executor({
    db: openDatabase(':memory:'),
    accounts: ACCOUNTS,
    pool: {
      withConnection: vi.fn(async () => {
        throw new Error('IMAP must not be used');
      }),
    } as never,
    logger,
    cache: db ?? undefined,
    cacheConfig: { mode, freshnessWindowSeconds: 3600 } as never,
  });
}

async function call(ex: Executor, tool: string, params: Record<string, unknown> = {}) {
  const { result } = await ex.executeImmediate({
    tool,
    toolParams: params,
    accountId: 'work',
    agentId: 'test',
    risk: 'none',
  });
  return JSON.parse(result[0].text);
}

/**
 * work: Alice writes twice, gets two answers (one To, one Cc) from two of the
 * operator's addresses. A newsletter writes once. Bob is only ever written to.
 * home: Alice writes once more; Carol writes once and is never answered.
 */
function seedConversations() {
  add('work', 'INBOX', { day: 1, from: p('alice@example.com', 'Alice') });
  add('work', 'Sent Messages', {
    day: 2,
    from: p('work@example.com'),
    to: [p('alice@example.com', 'Alice Smith')],
    inReplyTo: '<1@x>',
    references: ['<1@x>'],
  });
  add('work', 'INBOX', { day: 3, from: p('Alice@Example.com', ''), messageId: '<3@x>' });
  add('work', 'Sent Messages', {
    day: 4,
    from: p('cameron@alias.example'),
    to: [p('bob@example.com', 'Bob')],
    cc: [p('alice@example.com')],
  });
  add('work', 'Archive', {
    day: 5,
    from: p('news@list.example', 'The List'),
    listUnsubscribe: { raw: '<https://list.example/u>', mailto: null, http_url: 'https://list.example/u', one_click: false },
  });
  add('home', 'INBOX', { day: 6, from: p('alice@example.com') });
  add('home', 'INBOX', { day: 7, from: p('carol@example.com', 'Carol') });
  // The operator mailing themselves is not a correspondent.
  add('work', 'INBOX', { day: 8, from: p('work@example.com'), to: [p('work@example.com')] });

  synced('work', 'INBOX');
  synced('work', 'Sent Messages', { oldest_date: day(2) });
  synced('work', 'Archive', { backfill_complete: 0 });
  synced('home', 'INBOX');
}

beforeEach(() => {
  cache = openCache(':memory:');
  nextUid = 1;
});

describe('list_accounts', () => {
  it('lists each account with its sending addresses and cached mailboxes', async () => {
    seedConversations();

    const payload = await call(executor(), 'list_accounts');

    expect(payload.note).toBeUndefined();
    expect(payload.accounts).toEqual([
      {
        id: 'work',
        email: 'work@example.com',
        addresses: [
          { address: 'cameron@alias.example', sent: 1 },
          { address: 'work@example.com', sent: 1 },
        ],
        mailboxes: [
          { mailbox: 'Archive', role: 'other', messages: 1, oldest: new Date(day(1)).toISOString(), backfill_complete: false },
          { mailbox: 'INBOX', role: 'inbox', messages: 3, oldest: new Date(day(1)).toISOString(), backfill_complete: true },
          { mailbox: 'Sent Messages', role: 'sent', messages: 2, oldest: new Date(day(2)).toISOString(), backfill_complete: true },
        ],
      },
      {
        id: 'home',
        email: 'home@example.com',
        // Nothing sent from home yet, but its own address is still listed.
        addresses: [{ address: 'home@example.com', sent: 0 }],
        mailboxes: [
          { mailbox: 'INBOX', role: 'inbox', messages: 2, oldest: new Date(day(1)).toISOString(), backfill_complete: true },
        ],
      },
    ]);
  });

  it('still lists the configured accounts when there is no cache', async () => {
    for (const ex of [executor(null), executor(cache, 'off')]) {
      const payload = await call(ex, 'list_accounts');
      expect(payload.accounts).toEqual([
        { id: 'work', email: 'work@example.com' },
        { id: 'home', email: 'home@example.com' },
      ]);
      expect(payload.note).toMatch(/local cache is not available/);
    }
  });
});

describe('list_correspondents', () => {
  it('reports each person once, both directions, without the operator', async () => {
    seedConversations();

    const payload = await call(executor(), 'list_correspondents');

    expect(payload.correspondents_total).toBe(4);
    expect(payload.correspondents.map((c: { address: string }) => c.address)).toEqual([
      'alice@example.com',
      'bob@example.com',
      'carol@example.com',
      'news@list.example',
    ]);
    const [alice, bob, carol, news] = payload.correspondents;
    expect(alice).toEqual({
      address: 'alice@example.com',
      // The newest name anyone used for her: Alice Smith in the first answer.
      name: 'Alice Smith',
      received: 3,
      sent: 2,
      first_contact_at: new Date(day(1)).toISOString(),
      last_received_at: new Date(day(6)).toISOString(),
      last_sent_at: new Date(day(4)).toISOString(),
      last_direction: 'received',
      // Her first message and its answer share a thread.
      threads: 4,
      is_list_sender: false,
    });
    expect(bob).toMatchObject({ name: 'Bob', received: 0, sent: 1, last_direction: 'sent', last_received_at: null });
    expect(carol).toMatchObject({ received: 1, sent: 0, last_direction: 'received', last_sent_at: null });
    expect(news).toMatchObject({ is_list_sender: true });
  });

  it('keeps only people the operator has written to with min_sent', async () => {
    seedConversations();

    const payload = await call(executor(), 'list_correspondents', { min_sent: 1 });

    expect(payload.correspondents.map((c: { address: string }) => c.address)).toEqual([
      'alice@example.com',
      'bob@example.com',
    ]);
    expect(payload.correspondents_total).toBe(2);
  });

  it('scopes by account and date, and reports the total before the limit', async () => {
    seedConversations();

    const home = await call(executor(), 'list_correspondents', { account_ids: ['home'] });
    expect(home.correspondents.map((c: { address: string; received: number }) => [c.address, c.received])).toEqual([
      ['alice@example.com', 1],
      ['carol@example.com', 1],
    ]);

    const early = await call(executor(), 'list_correspondents', {
      before: new Date(day(3)).toISOString(),
    });
    expect(early.correspondents).toEqual([
      expect.objectContaining({ address: 'alice@example.com', received: 1, sent: 1 }),
    ]);

    const top = await call(executor(), 'list_correspondents', { limit: 1 });
    expect(top.correspondents).toHaveLength(1);
    expect(top.correspondents_total).toBe(4);
  });

  it('refuses when the cache cannot answer', async () => {
    await expect(call(executor(null), 'list_correspondents')).rejects.toThrow(
      /answered only from the local cache/
    );

    seedConversations();
    synced('home', 'INBOX', { last_delta_at: Date.now() - 24 * 60 * 60 * 1000 });
    await expect(call(executor(), 'list_correspondents')).rejects.toThrow(/the local cache is stale/);
  });
});

describe('reading a cache the daemon wrote', () => {
  it('answers both tools on a connection opened read-only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-mail-tools-ro-'));
    try {
      const path = join(dir, 'cache.db');
      cache = openCache(path);
      seedConversations();
      cache.close();

      const reader = openCache(path, { readOnly: true });
      const accounts = await call(executor(reader), 'list_accounts');
      expect(accounts.accounts[0].addresses).toHaveLength(2);
      const people = await call(executor(reader), 'list_correspondents');
      expect(people.correspondents_total).toBe(4);
      reader.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
