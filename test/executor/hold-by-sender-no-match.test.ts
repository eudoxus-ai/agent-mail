import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import type { Database } from '../../src/ledger/sqlite.js';
import { createLogger } from '../../src/logger.js';
import { getIntentProgress } from '../../src/ledger/intents.js';
import type { AccountConfig } from '../../src/types.js';

vi.mock('../../src/provider/credentials.js', () => ({
  resolveCredentials: vi.fn((account: any) => ({
    ...account,
    auth: { user: account.email, pass: 'pw' },
  })),
}));

const { Executor } = await import('../../src/executor/executor.js');

/**
 * A sweep that matched nothing must not look like a sweep that worked.
 *
 * Reported from real use: `hold_by_sender` on a long sender address returned
 * `executed` with an empty target list, which reads as "swept clean". Ten
 * messages from that sender were still in the inbox. Nothing in the response
 * distinguished it from a genuine no-op, so the caller could not tell the
 * difference and would have reported the mailbox clean.
 *
 * Two very different things produce zero, and the caller needs to know which:
 * the server's FROM search matched nothing at all, or it matched and our own
 * `before` cursor filtered every hit away.
 */

const accounts: AccountConfig[] = [
  {
    id: 'icloud',
    email: 'you@icloud.com',
    imap: { host: 'h', port: 993, tls: true },
    smtp: { host: 'h', port: 587, tls: true },
  },
];

let db: Database;

function fakeImap(opts: { search?: unknown[]; searchUids?: number[] } = {}) {
  return {
    search: vi.fn(async () => opts.search ?? []),
    searchUids: vi.fn(async () => opts.searchUids ?? []),
    getMailboxPath: vi.fn(async () => 'agent-mail-holding'),
    mailboxSnapshot: vi.fn(async () => ({
      uidValidity: 42,
      uidNext: 1000,
      highestModseq: 10,
      exists: 5,
    })),
    fetchEnvelopes: vi.fn(async (_m: string, uids: number[]) =>
      uids.map((uid) => ({
        uid,
        subject: `Subject ${uid}`,
        from: { address: 'alice@example.com', name: null },
      }))
    ),
    moveMessages: vi.fn(async (uids: number[]) => ({
      uidMap: new Map(uids.map((u) => [u, u + 9000])),
    })),
    hasRepliesTo: vi.fn(async () => false),
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

async function sweep(imap: ReturnType<typeof fakeImap>, params: Record<string, unknown> = {}) {
  const { intent, result } = await makeExecutor(imap).executeImmediate({
    tool: 'hold_by_sender',
    toolParams: { from: 'news@example.com', include_summary: false, ...params },
    accountId: 'icloud',
    agentId: 'test',
    risk: 'medium',
  });
  return { intent, payload: JSON.parse(result[0].text) };
}

beforeEach(() => {
  db = openDatabase(':memory:');
});

describe('a sweep that matched nothing', () => {
  it('says so, in a field that cannot be mistaken for success', async () => {
    const { payload } = await sweep(fakeImap());

    expect(payload.matched).toBe(0);
    expect(payload.status).toBe('no_match');
    // `executed` with an empty list is what caused the misread. The count and
    // the status both have to be present and both have to be unambiguous.
    expect(payload.total_messages).toBe(0);
  });

  it('reports exactly what it searched for', async () => {
    const { payload } = await sweep(fakeImap(), {
      from: 'verylongsender@a.fanaticscommerce.com',
      mailbox: 'INBOX',
    });

    // Without this, a zero result gives the caller nothing to vary. Echoing
    // the criteria is what makes "try a shorter substring" an actionable next
    // step rather than a guess.
    expect(payload.searched.from).toBe('verylongsender@a.fanaticscommerce.com');
    expect(payload.searched.mailbox).toBe('INBOX');
  });

  it('distinguishes "the sender never matched" from "the date cursor ate them"', async () => {
    // The server found nothing for this sender under any date.
    const noneAtAll = await sweep(fakeImap({ searchUids: [] }), {
      before: '2026-01-01T00:00:00.000Z',
    });
    expect(noneAtAll.payload.diagnosis).toMatch(/sender/i);
    expect(noneAtAll.payload.diagnosis).not.toMatch(/before/i);

    // The server found plenty; our own `before` filter removed all of them.
    // These are opposite problems with opposite fixes, and both show up as
    // zero.
    const filteredOut = await sweep(fakeImap({ searchUids: [1, 2, 3, 4] }), {
      before: '2026-01-01T00:00:00.000Z',
    });
    expect(filteredOut.payload.diagnosis).toMatch(/before/i);
    expect(filteredOut.payload.diagnosis).toContain('4');
  });

  /**
   * The retry advice has to point at a query shape that can actually work.
   *
   * It used to say "try a shorter distinctive substring (the domain alone,
   * say)". Measured against iCloud, that is backwards. iCloud only matches
   * within roughly the first 29 characters of the sender address:
   *
   *   MattressFirm@email.mattressfirm.com  -> 24
   *   email.mattressfi                     -> 24   (ends at offset 29)
   *   email.mattressfir                    ->  0   (ends at offset 30)
   *   email.mattressfirm.com               ->  0
   *   mattressfirm.com                     ->  0
   *
   * So the bare domain is the *least* reliable form on exactly the senders
   * that provoke a no_match, and an agent following the old advice retried
   * itself straight back into the same zero.
   */
  it('does not send the caller back to the query shape that just failed', async () => {
    const { payload } = await sweep(fakeImap(), {
      from: 'email.mattressfirm.com',
    });

    expect(payload.diagnosis).not.toMatch(/shorter/i);
    expect(payload.diagnosis).not.toMatch(/domain alone/i);
    // The full address, or a prefix of it, is what survives a truncated index.
    expect(payload.diagnosis).toMatch(/full|complete|prefix/i);
  });

  it('does not bother probing when no date cursor was given', async () => {
    // With no `before` there is nothing for the second search to rule out, and
    // an extra IMAP round trip per empty sweep is not free.
    const imap = fakeImap();
    await sweep(imap);
    expect(imap.searchUids).not.toHaveBeenCalled();
  });

  it('survives a probe that fails', async () => {
    const imap = fakeImap();
    imap.searchUids = vi.fn(async () => {
      throw new Error('server hung up');
    });

    const { payload } = await sweep(imap, { before: '2026-01-01T00:00:00.000Z' });

    // A diagnostic that can fail the operation it is diagnosing is worse than
    // no diagnostic.
    expect(payload.matched).toBe(0);
    expect(payload.status).toBe('no_match');
  });

  it('is visible to a poller, which is the only surface a queued sweep has', async () => {
    // Queued work returns an id, not a payload — get_intent is all the caller
    // ever sees. `status: executed, targets: []` there is precisely the
    // ambiguity being fixed, so the outcome has to reach the ledger too.
    const { intent } = await sweep(fakeImap());

    const progress = getIntentProgress(db, intent.id);
    expect(progress?.phase).toBe('no_match');
    expect(progress?.detail?.from).toBe('news@example.com');
  });

  it('leaves a sweep that actually matched alone', async () => {
    const imap = fakeImap({ search: [{ uid: 101 }, { uid: 102 }] });
    const { payload, intent } = await sweep(imap);

    expect(payload.status).not.toBe('no_match');
    expect(payload.matched).toBeUndefined();
    expect(payload.total_messages).toBe(2);
    expect(getIntentProgress(db, intent.id)?.phase).not.toBe('no_match');
  });

  it('is legible to a poller as no_match, not as a successful sweep', async () => {
    // The reproduction from real use: hold_by_sender('fanaticscommerce.com')
    // matched zero while the full address matched 18 — same sender, same
    // mailbox. The response payload said no_match, but a QUEUED sweep's
    // payload is discarded: the caller gets an id and polls get_intent, which
    // showed status "executed" with empty targets — indistinguishable from a
    // clean sweep, on the only surface the queued path has.
    const imap = fakeImap();
    const { intent } = await sweep(imap, { from: 'fanaticscommerce.com' });

    const executor = makeExecutor(imap);
    const { result } = await executor.executeImmediate({
      tool: 'get_intent',
      toolParams: { intent_id: intent.id },
      accountId: 'icloud',
      agentId: 'test',
      risk: 'none',
    });
    const payload = JSON.parse(result[0].text);

    expect(payload.status).toBe('executed');
    // The verdict, at top level — not buried in a progress object the reader
    // has to know to dig into.
    expect(payload.outcome).toMatchObject({ status: 'no_match', matched: 0 });
    expect(payload.outcome.searched.from).toBe('fanaticscommerce.com');
  });

  it('does not stamp an outcome on a sweep that held messages', async () => {
    const imap = fakeImap({ search: [{ uid: 101 }] });
    const { intent } = await sweep(imap);

    const executor = makeExecutor(imap);
    const { result } = await executor.executeImmediate({
      tool: 'get_intent',
      toolParams: { intent_id: intent.id },
      accountId: 'icloud',
      agentId: 'test',
      risk: 'none',
    });
    const payload = JSON.parse(result[0].text);

    expect(payload.outcome).toBeUndefined();
    expect(payload.targets.length).toBeGreaterThan(0);
  });
});
