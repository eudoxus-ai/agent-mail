import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import type { Database } from '../../src/ledger/sqlite.js';
import { createLogger } from '../../src/logger.js';
import { getIntent } from '../../src/ledger/intents.js';
import { getIntentTargets } from '../../src/ledger/intent-targets.js';
import { Executor } from '../../src/executor/executor.js';
import type { AccountConfig } from '../../src/types.js';

/**
 * These run against a fake server that really holds mail, because the failures
 * they cover are disagreements between what the ledger says and where the mail
 * is. Each test ends by looking at the folders, not at the response.
 */

const HOLDING = 'agent-mail-holding';

const account = (id: string): AccountConfig => ({
  id,
  email: `${id}@example.com`,
  imap: { host: 'h', port: 993, tls: true },
  smtp: { host: 'h', port: 587, tls: true },
});
const accounts = [account('one'), account('two')];

type Step = 'ok' | 'refuse' | 'lose-response';

class FakeServer {
  folders = new Map<string, Map<number, string>>();
  nextUid = 9000;
  /** What happens to each move, in order. Anything past the end succeeds. */
  moves: Step[] = [];
  fetchFails = new Set<string>();

  constructor(mail: Record<string, Record<number, string>>) {
    for (const [name, messages] of Object.entries(mail)) {
      this.folders.set(name, new Map(Object.entries(messages).map(([u, id]) => [Number(u), id])));
    }
    if (!this.folders.has(HOLDING)) this.folders.set(HOLDING, new Map());
  }

  ids(folder: string): string[] {
    return [...(this.folders.get(folder)?.values() ?? [])].sort();
  }

  async getMailboxPath(role: string) {
    return role === 'holding' ? HOLDING : 'INBOX';
  }

  async mailboxSnapshot() {
    return { uidValidity: 42, uidNext: 1000, highestModseq: 10, exists: 5 };
  }

  async fetchEnvelopes(mailbox: string, uids: number[]) {
    if (this.fetchFails.has(mailbox)) throw new Error('connection dropped');
    const folder = this.folders.get(mailbox)!;
    return uids
      .filter((uid) => folder.has(uid))
      .map((uid) => ({
        uid,
        messageId: folder.get(uid)!,
        subject: `Subject ${uid}`,
        from: { address: 'a@example.com', name: null },
        references: [],
      }));
  }

  async existingUids(mailbox: string, uids: number[]) {
    const folder = this.folders.get(mailbox)!;
    return uids.filter((uid) => folder.has(uid));
  }

  async uidsByMessageId(mailbox: string, ids: string[]) {
    const found = new Map<string, number[]>();
    for (const [uid, id] of this.folders.get(mailbox)!) {
      if (ids.includes(id)) found.set(id, [...(found.get(id) ?? []), uid]);
    }
    return found;
  }

  async moveMessages(uids: number[], from: string, to: string) {
    const step = this.moves.shift() ?? 'ok';
    if (step === 'refuse') throw new Error(`Could not move ${uids.length} message(s)`);
    const uidMap = new Map<number, number>();
    const source = this.folders.get(from)!;
    const destination = this.folders.get(to) ?? new Map<number, string>();
    this.folders.set(to, destination);
    for (const uid of uids) {
      const id = source.get(uid);
      if (id === undefined) continue;
      source.delete(uid);
      const next = ++this.nextUid;
      destination.set(next, id);
      uidMap.set(uid, next);
    }
    if (step === 'lose-response') throw new Error('connection dropped');
    return { uidMap };
  }

  async replyThreadIds() {
    return new Set<string>();
  }
}

let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:');
});

function makeExecutor(servers: Record<string, FakeServer>) {
  return new Executor({
    db,
    accounts,
    pool: {
      withConnection: vi.fn(async (id: string, fn: (i: unknown) => Promise<unknown>) =>
        fn(servers[id])
      ),
    } as never,
    logger: createLogger('cli', { minLevel: 'error' }),
  });
}

const t = (uid: number, mailbox?: string, account_id = 'one') => ({
  account_id,
  uid,
  ...(mailbox ? { mailbox } : {}),
});

async function call(executor: Executor, tool: string, toolParams: Record<string, unknown>) {
  const { intent, result } = await executor.executeImmediate({
    tool,
    toolParams,
    accountId: 'one',
    agentId: 'test',
    risk: 'medium',
  });
  return { intent, payload: JSON.parse(result[0].text) };
}

const hold = (executor: Executor, targets: unknown[]) =>
  call(executor, 'hold_messages', { targets });
const restore = (executor: Executor, targets: unknown[]) =>
  call(executor, 'restore_messages', { targets });

/** The intent a hold that threw left behind. */
function latestIntent(tool: string) {
  const row = db
    .prepare(`SELECT id FROM intents WHERE tool = ? ORDER BY rowid DESC LIMIT 1`)
    .get(tool) as { id: string };
  return getIntent(db, row.id)!;
}

describe('a hold that fails part way', () => {
  it('keeps what the first mailbox moved when the second move is refused', async () => {
    const server = new FakeServer({ INBOX: { 1: '<a>' }, Archive: { 2: '<b>' } });
    server.moves = ['ok', 'refuse'];
    const executor = makeExecutor({ one: server });

    const { intent, payload } = await hold(executor, [t(1, 'INBOX'), t(2, 'Archive')]);

    expect(payload.total_messages).toBe(1);
    expect(payload.moved.map((m: any) => m.uid)).toEqual([1]);
    expect(payload.errors).toEqual([
      expect.objectContaining({ uid: 2, mailbox: 'Archive' }),
    ]);
    expect(getIntent(db, intent.id)?.status).toBe('executed');
    expect(server.ids(HOLDING)).toEqual(['<a>']);
  });

  it('keeps what the first mailbox moved when the second cannot be read', async () => {
    const server = new FakeServer({ INBOX: { 1: '<a>' }, Archive: { 2: '<b>' } });
    server.fetchFails.add('Archive');
    const executor = makeExecutor({ one: server });

    const { intent, payload } = await hold(executor, [t(1, 'INBOX'), t(2, 'Archive')]);

    expect(payload.total_messages).toBe(1);
    expect(payload.per_account_errors).toEqual({ one: 'connection dropped' });
    expect(getIntent(db, intent.id)?.status).toBe('executed');
  });

  it('does not claim nothing was held when a move may have landed', async () => {
    const server = new FakeServer({ INBOX: { 1: '<a>' } });
    server.moves = ['lose-response'];
    const executor = makeExecutor({ one: server });

    const attempt = hold(executor, [t(1, 'INBOX')]);

    await expect(attempt).rejects.toThrow('No message was confirmed as held');
    await expect(attempt).rejects.not.toThrow('Nothing was held');
  });

  it('still says nothing was held when no move was tried', async () => {
    const server = new FakeServer({ INBOX: { 1: '<a>' } });
    server.fetchFails.add('INBOX');
    const executor = makeExecutor({ one: server });

    await expect(hold(executor, [t(1, 'INBOX')])).rejects.toThrow(
      'Nothing was held: connection dropped'
    );
  });

  it('restores a message from a failed hold whose move really landed', async () => {
    const server = new FakeServer({ INBOX: { 1: '<a>' } });
    server.moves = ['lose-response'];
    const executor = makeExecutor({ one: server });
    await expect(hold(executor, [t(1, 'INBOX')])).rejects.toThrow();
    expect(latestIntent('hold_messages').status).toBe('failed');
    expect(server.ids(HOLDING)).toEqual(['<a>']);

    const { payload } = await restore(executor, [t(1)]);

    expect(payload.errors).toEqual([]);
    expect(server.ids('INBOX')).toEqual(['<a>']);
    expect(server.ids(HOLDING)).toEqual([]);
  });

  it('reports a failed hold whose move never landed as not in holding', async () => {
    const server = new FakeServer({ INBOX: { 1: '<a>' } });
    server.moves = ['refuse'];
    const executor = makeExecutor({ one: server });
    await expect(hold(executor, [t(1, 'INBOX')])).rejects.toThrow();

    const { payload } = await restore(executor, [t(1)]);

    expect(payload.moved).toEqual([]);
    expect(payload.errors[0].reason).toContain('not in holding');
    expect(server.ids('INBOX')).toEqual(['<a>']);
  });
});

describe('undoing a hold', () => {
  it('finds a message whose move landed without a confirmation', async () => {
    const server = new FakeServer({ INBOX: { 1: '<a>' }, Archive: { 2: '<b>' } });
    server.moves = ['ok', 'lose-response'];
    const executor = makeExecutor({ one: server });
    const { intent } = await hold(executor, [t(1, 'INBOX'), t(2, 'Archive')]);
    expect(server.ids(HOLDING)).toEqual(['<a>', '<b>']);

    const undo = await executor.undoIntent(intent.id);

    expect(undo.success).toBe(true);
    expect(undo.message).not.toContain('could not be located');
    expect(server.ids(HOLDING)).toEqual([]);
  });

  it('does not report success when nothing moved', async () => {
    const server = new FakeServer({ INBOX: { 1: '<a>' } });
    const executor = makeExecutor({ one: server });
    const { intent } = await hold(executor, [t(1, 'INBOX')]);
    server.folders.get(HOLDING)!.clear();

    const undo = await executor.undoIntent(intent.id);

    expect(undo.success).toBe(false);
    expect(undo.message).toContain('in holding');
    expect(getIntent(db, intent.id)?.status).toBe('executed');
  });

  it('reports a message it could not find while undoing the rest', async () => {
    const server = new FakeServer({ INBOX: { 1: '<a>', 2: '<b>' } });
    const executor = makeExecutor({ one: server });
    const { intent } = await hold(executor, [t(1, 'INBOX'), t(2, 'INBOX')]);
    const held = server.folders.get(HOLDING)!;
    held.delete([...held.keys()][0]);

    const undo = await executor.undoIntent(intent.id);

    expect(undo.success).toBe(true);
    expect(undo.message).toContain('1 target(s) could not be located');
    expect(held.size).toBe(0);
  });

  it('can be run again after one account fails, and says what happened', async () => {
    const one = new FakeServer({ INBOX: { 1: '<a>' } });
    const two = new FakeServer({ INBOX: { 2: '<b>' } });
    const executor = makeExecutor({ one, two });
    const { intent } = await hold(executor, [
      t(1, 'INBOX', 'one'),
      t(2, 'INBOX', 'two'),
    ]);
    two.moves = ['refuse'];

    const first = await executor.undoIntent(intent.id);

    expect(first.success).toBe(false);
    expect(first.message).toContain('Undid 1 of 2');
    expect(getIntent(db, intent.id)?.status).toBe('executed');
    expect(one.ids('INBOX')).toEqual(['<a>']);

    const second = await executor.undoIntent(intent.id);

    expect(second.success).toBe(true);
    expect(getIntent(db, intent.id)?.status).toBe('undone');
    expect(two.ids('INBOX')).toEqual(['<b>']);
  });

  it('copes with a target recorded before Message-Ids were kept', async () => {
    const server = new FakeServer({ INBOX: { 1: '<a>', 2: '<b>' } });
    server.moves = ['ok'];
    const executor = makeExecutor({ one: server });
    const { intent } = await hold(executor, [t(1, 'INBOX'), t(2, 'INBOX')]);
    db.prepare(
      `UPDATE intent_targets
          SET envelope_snapshot = json_remove(envelope_snapshot, '$.message_id'),
              destination_uid = NULL
        WHERE intent_id = ? AND uid = 2`
    ).run(intent.id);

    const undo = await executor.undoIntent(intent.id);

    expect(undo.success).toBe(true);
    expect(undo.message).toContain('1 target(s) could not be located');
    expect(server.ids(HOLDING)).toEqual(['<b>']);
  });
});

describe('restoring more than once', () => {
  it('restore, undo, restore puts the message back', async () => {
    const server = new FakeServer({ INBOX: { 1: '<a>' } });
    const executor = makeExecutor({ one: server });
    await hold(executor, [t(1, 'INBOX')]);

    const first = await restore(executor, [t(1)]);
    const undo = await executor.undoIntent(first.intent.id);
    expect(undo.success).toBe(true);
    expect(server.ids(HOLDING)).toEqual(['<a>']);

    const second = await restore(executor, [t(1)]);

    expect(second.payload.moved).toHaveLength(1);
    expect(server.ids('INBOX')).toEqual(['<a>']);
    expect(server.ids(HOLDING)).toEqual([]);
  });

  it('does the same for a hold recorded before Message-Ids were kept', async () => {
    const server = new FakeServer({ INBOX: { 1: '<a>' } });
    const executor = makeExecutor({ one: server });
    const { intent } = await hold(executor, [t(1, 'INBOX')]);
    db.prepare(
      `UPDATE intent_targets SET envelope_snapshot = json_remove(envelope_snapshot, '$.message_id')
        WHERE intent_id = ?`
    ).run(intent.id);

    const first = await restore(executor, [t(1)]);
    await executor.undoIntent(first.intent.id);
    await restore(executor, [t(1)]);

    expect(server.ids('INBOX')).toEqual(['<a>']);
    expect(server.ids(HOLDING)).toEqual([]);
  });

  it('records the new holding UID when a restore is undone', async () => {
    const server = new FakeServer({ INBOX: { 1: '<a>' } });
    const executor = makeExecutor({ one: server });
    const { intent } = await hold(executor, [t(1, 'INBOX')]);

    const first = await restore(executor, [t(1)]);
    await executor.undoIntent(first.intent.id);

    const [row] = getIntentTargets(db, intent.id);
    expect(server.folders.get(HOLDING)!.has(row.destination_uid!)).toBe(true);
  });

  it('does not report a second restore as moved', async () => {
    const server = new FakeServer({ INBOX: { 1: '<a>' } });
    const executor = makeExecutor({ one: server });
    await hold(executor, [t(1, 'INBOX')]);
    await restore(executor, [t(1)]);

    const { payload } = await restore(executor, [t(1)]);

    expect(payload.moved).toEqual([]);
    expect(payload.errors[0].reason).toContain('not in holding');
  });

  it('refuses to undo a restore when nothing moved', async () => {
    const server = new FakeServer({ INBOX: { 1: '<a>' } });
    const executor = makeExecutor({ one: server });
    await hold(executor, [t(1, 'INBOX')]);
    const { intent } = await restore(executor, [t(1)]);
    server.folders.get('INBOX')!.clear();

    const undo = await executor.undoIntent(intent.id);

    expect(undo.success).toBe(false);
    expect(getIntent(db, intent.id)?.status).toBe('executed');
  });
});

describe('the same UID in two mailboxes', () => {
  function heldFromBoth() {
    const server = new FakeServer({ INBOX: { 5: '<inbox>' }, Archive: { 5: '<archive>' } });
    return { server, executor: makeExecutor({ one: server }) };
  }

  it('records each message at its own destination', async () => {
    const { server, executor } = heldFromBoth();
    const { intent } = await hold(executor, [t(5, 'INBOX'), t(5, 'Archive')]);

    const held = server.folders.get(HOLDING)!;
    const rows = getIntentTargets(db, intent.id);
    const landed = (mailbox: string) =>
      held.get(rows.find((r) => r.mailbox === mailbox)!.destination_uid!);
    expect(landed('INBOX')).toBe('<inbox>');
    expect(landed('Archive')).toBe('<archive>');
  });

  it('restores the one the caller named', async () => {
    const { server, executor } = heldFromBoth();
    await hold(executor, [t(5, 'INBOX'), t(5, 'Archive')]);

    await restore(executor, [t(5, 'Archive')]);

    expect(server.ids('Archive')).toEqual(['<archive>']);
    expect(server.ids('INBOX')).toEqual([]);
    expect(server.ids(HOLDING)).toEqual(['<inbox>']);
  });

  it('asks which one when the caller did not say', async () => {
    const { server, executor } = heldFromBoth();
    await hold(executor, [t(5, 'INBOX'), t(5, 'Archive')]);

    const { payload } = await restore(executor, [t(5)]);

    expect(payload.moved).toEqual([]);
    expect(payload.errors[0].reason).toContain('more than one mailbox');
    expect(server.ids(HOLDING)).toEqual(['<archive>', '<inbox>']);
  });

  it('refuses a mailbox the UID was not held from', async () => {
    const server = new FakeServer({ Archive: { 5: '<archive>' }, INBOX: {} });
    const executor = makeExecutor({ one: server });
    await hold(executor, [t(5, 'Archive')]);

    const { payload } = await restore(executor, [t(5, 'INBOX')]);

    expect(payload.moved).toEqual([]);
    expect(payload.errors[0].reason).toContain('in INBOX');
    expect(server.ids(HOLDING)).toEqual(['<archive>']);
  });

  it('treats naming holding as not saying which one', async () => {
    const { server, executor } = heldFromBoth();
    await hold(executor, [t(5, 'INBOX'), t(5, 'Archive')]);

    const { payload } = await restore(executor, [t(5, HOLDING)]);

    expect(payload.errors[0].reason).toContain('more than one mailbox');
    expect(server.ids(HOLDING)).toEqual(['<archive>', '<inbox>']);
  });

  it('undoes both', async () => {
    const { server, executor } = heldFromBoth();
    const { intent } = await hold(executor, [t(5, 'INBOX'), t(5, 'Archive')]);

    const undo = await executor.undoIntent(intent.id);

    expect(undo.success).toBe(true);
    expect(server.ids(HOLDING)).toEqual([]);
  });
});
