import { describe, it, expect, vi, afterEach } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { createIntent } from '../../src/ledger/intents.js';
import { createLogger } from '../../src/logger.js';
import type { AccountConfig } from '../../src/types.js';

vi.mock('../../src/provider/url-safety.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/provider/url-safety.js')>()),
  assertSafeRemoteUrl: async (url: string) => ({ url: new URL(url), headers: {} }),
}));

const logger = createLogger('cli', { minLevel: 'error' });

const accounts: AccountConfig[] = [
  { id: 'a', email: 'a@x.com', imap: { host: 'h', port: 993, tls: true }, smtp: { host: 'h', port: 465, tls: true } },
  { id: 'b', email: 'b@y.com', imap: { host: 'h', port: 993, tls: true }, smtp: { host: 'h', port: 465, tls: true } },
];

function setup(imap: Record<string, unknown>) {
  const used: string[] = [];
  const db = openDatabase(':memory:');
  const executor = new Executor({
    db,
    accounts,
    pool: {
      withConnection: vi.fn(async (id: string, fn: any) => {
        used.push(id);
        return fn(imap);
      }),
    } as any,
    logger,
  });
  const run = async (tool: string, toolParams: Record<string, unknown>, accountId = 'a') => {
    const { result } = await executor.executeImmediate({ tool, toolParams, accountId, agentId: 't', risk: 'none' });
    return JSON.parse(result[0].text);
  };
  return { executor, db, run, used };
}

afterEach(() => vi.unstubAllGlobals());

describe('read_thread', () => {
  it('returns a normal body whole', async () => {
    const { run } = setup({ fetchMessage: async () => ({ uid: 1, bodyText: 'short' }) });
    const out = await run('read_thread', { target: { account_id: 'a', uid: 1 } });
    expect(out.bodyText).toBe('short');
    expect(out.body_truncated).toBeUndefined();
  });

  it('caps a very long body and says so', async () => {
    const { run } = setup({ fetchMessage: async () => ({ uid: 1, bodyText: 'x'.repeat(50_000) }) });
    const out = await run('read_thread', { target: { account_id: 'a', uid: 1 } });
    expect(out.bodyText).toHaveLength(20_000);
    expect(out.body_truncated).toBe(true);
    expect(out.body_chars).toBe(50_000);
  });
});

describe('sending a draft', () => {
  const draft = { to: [{ address: 'c@z.com' }], subject: 'S', references: [] };
  const queued = (db: any) =>
    createIntent(db, { account_id: 'a', tool: 'queue_send', params: { draft_id: 5 }, risk: 'high', agent_id: 't' });
  const imap = (bodyText: string) => ({
    getMailboxPath: async () => 'Drafts',
    fetchMessage: async () => ({ ...draft, bodyText }),
  });

  it('sends the whole body, however long', async () => {
    const body = 'y'.repeat(30_000);
    const { executor, db } = setup(imap(body));
    const message = await (executor as any).resolveQueuedSend(queued(db), accounts[0]);
    expect(message.text).toBe(body);
  });

  it('refuses to send a draft whose body could not be read', async () => {
    const { executor, db } = setup(imap('  '));
    await expect((executor as any).resolveQueuedSend(queued(db), accounts[0])).rejects.toThrow(
      'Could not read the body of draft 5'
    );
  });
});

describe('unsubscribe_sender', () => {
  const header = (listUnsubscribe: unknown) => ({ fetchMessage: vi.fn(async () => ({ listUnsubscribe })) });
  const stubFetch = () => {
    const fetchMock = vi.fn(async () => ({ status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('reads the link from the target message and posts the one-click body', async () => {
    const fetchMock = stubFetch();
    const imap = header({ http_url: 'https://e.com/u', mailto: null, one_click: true });
    const { run, used } = setup(imap);
    const out = await run('unsubscribe_sender', { target: { account_id: 'b', uid: 9, mailbox: 'Archive' } }, 'b');

    expect(used).toEqual(['b']);
    expect(imap.fetchMessage).toHaveBeenCalledWith('Archive', 9);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe('https://e.com/u');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('List-Unsubscribe=One-Click');
    expect(out.unsubscribe_url).toBe('https://e.com/u');
    expect(out.warning).toBeUndefined();
  });

  it('warns when the sender does not support one-click', async () => {
    stubFetch();
    const { run } = setup(header({ http_url: 'https://e.com/u', mailto: null, one_click: false }));
    const out = await run('unsubscribe_sender', { target: { account_id: 'a', uid: 9 } });
    expect(out.warning).toContain('confirm it in a browser');
  });

  it('still accepts a URL', async () => {
    const fetchMock = stubFetch();
    const { run } = setup({});
    await run('unsubscribe_sender', { unsubscribe_url: 'https://e.com/given' });
    expect((fetchMock.mock.calls[0] as unknown as [URL])[0].href).toBe('https://e.com/given');
  });

  it.each([
    ['no header', undefined, 'has no List-Unsubscribe header'],
    ['mailto only', { http_url: null, mailto: 'mailto:u@e.com', one_click: false }, 'only offers a mailto'],
  ])('fails without posting: %s', async (_name, value, message) => {
    const fetchMock = stubFetch();
    const { executor } = setup(header(value));
    await expect(
      executor.executeImmediate({
        tool: 'unsubscribe_sender',
        toolParams: { target: { account_id: 'a', uid: 9 } },
        accountId: 'a',
        agentId: 't',
        risk: 'low',
      })
    ).rejects.toThrow(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['both', { target: { account_id: 'a', uid: 9 }, unsubscribe_url: 'https://e.com/u' }],
    ['neither', {}],
  ])('rejects %s of target and url', async (_name, toolParams) => {
    const fetchMock = stubFetch();
    const { executor } = setup({});
    await expect(
      executor.executeImmediate({ tool: 'unsubscribe_sender', toolParams, accountId: 'a', agentId: 't', risk: 'low' })
    ).rejects.toThrow('exactly one of target or unsubscribe_url');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('list_senders', () => {
  const row = (uid: number, address: string, date: string, extra = {}) => ({
    uid,
    envelope: { from: { address }, date },
    list_unsubscribe: null,
    list_id: null,
    ...extra,
  });
  const rows = [
    row(3, 'a@e.com', '2026-03-01T00:00:00Z'),
    row(2, 'a@e.com', '2026-02-01T00:00:00Z'),
    row(1, 'list@e.com', '2026-01-01T00:00:00Z', { list_id: 'News <news.e.com>' }),
  ];

  it('reports what the scan reached', async () => {
    const { run } = setup({ search: async () => rows });
    const out = await run('list_senders', { account_ids: ['a'], scan_limit: 3 });
    expect(out.coverage.a).toEqual({ scanned: 3, truncated: true, oldest_scanned: '2026-01-01T00:00:00Z' });
  });

  it('is not truncated when the scan ended before the cap', async () => {
    const { run } = setup({ search: async () => rows });
    const out = await run('list_senders', { account_ids: ['a'], scan_limit: 500 });
    expect(out.coverage.a.truncated).toBe(false);
  });

  it('counts List-Id mail as list mail', async () => {
    const { run } = setup({ search: async () => rows });
    const out = await run('list_senders', { account_ids: ['a'] });
    const list = out.senders.find((s: { from: string }) => s.from === 'list@e.com');
    expect(list.is_list_mail_ratio).toBe(1);
    expect(list.has_unsubscribe).toBe(false);
  });

  it('returns the busiest senders up to the limit', async () => {
    const { run } = setup({ search: async () => rows });
    const out = await run('list_senders', { account_ids: ['a'], limit: 1 });
    expect(out.senders.map((s: { from: string }) => s.from)).toEqual(['a@e.com']);
    expect(out.senders_total).toBe(2);
  });
});

describe('get_intent', () => {
  function withTargets(db: any, n: number) {
    const intent = createIntent(db, { account_id: 'a', tool: 'hold_messages', params: {}, risk: 'medium', agent_id: 't' });
    const insert = db.prepare(
      'INSERT INTO intent_targets (intent_id, account_id, uid, mailbox, envelope_snapshot) VALUES (?, ?, ?, ?, ?)'
    );
    for (let uid = 1; uid <= n; uid += 1) insert.run(intent.id, 'a', uid, 'INBOX', '{}');
    return intent.id;
  }

  it('returns 50 targets by default with the full count', async () => {
    const { db, run } = setup({});
    const out = await run('get_intent', { intent_id: withTargets(db, 201) });
    expect(out.targets).toHaveLength(50);
    expect(out.targets_total).toBe(201);
  });

  it('honors targets_limit, including zero', async () => {
    const { db, run } = setup({});
    const id = withTargets(db, 201);
    expect((await run('get_intent', { intent_id: id, targets_limit: 201 })).targets).toHaveLength(201);
    expect((await run('get_intent', { intent_id: id, targets_limit: 0 })).targets).toHaveLength(0);
  });
});

describe('search_threads query on the IMAP path', () => {
  it('searches subject and body for a quoted phrase, without its quote marks', async () => {
    const search = vi.fn(async () => []);
    const { run } = setup({ search });
    await run('search_threads', { query: '"paid for by"', account_ids: ['a'] });
    const criteria = search.mock.calls.map((call) => (call as unknown[])[1]);
    expect(criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subject: 'paid for by' }),
        expect.objectContaining({ body: 'paid for by' }),
      ])
    );
  });
});
