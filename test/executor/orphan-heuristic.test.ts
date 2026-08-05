import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import type { Database } from '../../src/ledger/sqlite.js';
import { createLogger } from '../../src/logger.js';
import { updateIntentProgress } from '../../src/ledger/intents.js';
import type { AccountConfig } from '../../src/types.js';

vi.mock('../../src/provider/credentials.js', () => ({
  resolveCredentials: vi.fn((account: any) => ({
    ...account,
    auth: { user: account.email, pass: 'pw' },
  })),
}));

const { Executor } = await import('../../src/executor/executor.js');

/**
 * "Orphaned" must mean orphaned, because the advice attached to it is re-run.
 *
 * Reported from real use: every diagnostics call listed an actively-working
 * job as orphaned — progress updated 1.2 seconds before the report was
 * generated, completed normally moments later — with the message "they will
 * never complete on their own. Re-run them." Following that advice would have
 * duplicated a dozen in-flight sweeps.
 *
 * The old signal was "no IMAP operation in flight on this account", and it is
 * structurally blind now, not merely racy: diagnostics runs in the MCP
 * process and queued jobs execute in the daemon, whose pool this process
 * cannot see. Aliveness lives in the ledger — a live worker lease, or fresh
 * progress — and that is what the verdict has to read.
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

function makeExecutor() {
  return new Executor({
    db,
    accounts,
    pool: {
      withConnection: vi.fn(),
      diagnostics: () => ({
        opened: 1,
        closed: 0,
        live: 1,
        operation_timeout_ms: 300_000,
        accounts: [],
      }),
      stats: () => ({ opened: 1, closed: 0, live: 1 }),
    } as never,
    logger: createLogger('cli', { minLevel: 'error' }),
  });
}

function executing(
  id: string,
  opts: { claimedBy?: string; leaseMs?: number; progressAgeMs?: number } = {}
): void {
  db.prepare(
    `INSERT INTO intents (id, account_id, tool, params, risk, status, claimed_by, lease_expires_at)
     VALUES (?, 'icloud', 'hold_by_sender', '{}', 'medium', 'executing', ?, ?)`
  ).run(
    id,
    opts.claimedBy ?? null,
    opts.leaseMs != null ? new Date(Date.now() + opts.leaseMs).toISOString() : null
  );
  if (opts.progressAgeMs != null) {
    updateIntentProgress(db, id, 'moving', { mailbox: 'INBOX' });
    db.prepare(`UPDATE intents SET progress = json_set(progress, '$.updated_at', ?) WHERE id = ?`)
      .run(new Date(Date.now() - opts.progressAgeMs).toISOString(), id);
  }
}

async function diagnostics() {
  const { result } = await makeExecutor().executeImmediate({
    tool: 'get_diagnostics',
    toolParams: {},
    accountId: 'icloud',
    agentId: 'test',
    risk: 'none',
  });
  return JSON.parse(result[0].text);
}

beforeEach(() => {
  db = openDatabase(':memory:');
});

describe('the orphan verdict', () => {
  it('does not call a job with a live worker lease orphaned', async () => {
    // The daemon claimed it and is heartbeating. This process cannot see the
    // daemon's connection pool, and must not need to.
    executing('claimed', { claimedBy: 'worker-1', leaseMs: 600_000 });

    const payload = await diagnostics();

    expect(payload.orphaned_intents).toEqual([]);
    expect(payload.in_progress_intents.map((i: any) => i.intent_id)).toEqual(['claimed']);
    // "nothing needs re-running" is fine; "Re-run them" is the directive that
    // would have duplicated a dozen sweeps.
    expect(payload.interpretation).not.toMatch(/re-run them|never complete/i);
  });

  it('does not call a job with fresh progress orphaned', async () => {
    // The reported case: progress updated 1.2s before the report, job finished
    // normally moments later, diagnostics said to re-run it.
    executing('working', { progressAgeMs: 1_200 });

    const payload = await diagnostics();

    expect(payload.orphaned_intents).toEqual([]);
    expect(payload.in_progress_intents.map((i: any) => i.intent_id)).toEqual(['working']);
  });

  it('calls a job orphaned only when both signals are dead', async () => {
    // No claim, and progress stale beyond anything a live job produces —
    // updates land at least once per mailbox per pass, well inside the
    // operation timeout.
    executing('dead', { progressAgeMs: 30 * 60_000 });

    const payload = await diagnostics();

    expect(payload.orphaned_intents.map((i: any) => i.intent_id)).toEqual(['dead']);
    expect(payload.in_progress_intents).toEqual([]);
  });

  it('treats an expired lease with stale progress as orphaned', async () => {
    // A lapsed claim alone is reclaim's business — it requeues. But lapsed
    // plus long-stale progress means nothing is coming back for it.
    executing('expired', { claimedBy: 'worker-1', leaseMs: -60_000, progressAgeMs: 30 * 60_000 });

    const payload = await diagnostics();

    expect(payload.orphaned_intents.map((i: any) => i.intent_id)).toEqual(['expired']);
  });

  it('calls a claimless, progressless executing intent orphaned', async () => {
    // The genuine legacy case this report exists for: the old in-process path
    // died mid-action and left nothing behind.
    executing('legacy');

    const payload = await diagnostics();

    expect(payload.orphaned_intents.map((i: any) => i.intent_id)).toEqual(['legacy']);
    expect(payload.interpretation).toMatch(/orphan|never complete/i);
  });

  it('says why each in-progress job is believed alive', async () => {
    executing('claimed', { claimedBy: 'worker-1', leaseMs: 600_000 });
    executing('working', { progressAgeMs: 2_000 });

    const payload = await diagnostics();

    const byId = new Map(
      payload.in_progress_intents.map((i: any) => [i.intent_id, i.alive_because])
    );
    // Without the reason, the next person to distrust this list has nothing to
    // check it against — which is how the last heuristic went unquestioned.
    expect(byId.get('claimed')).toMatch(/lease/i);
    expect(byId.get('working')).toMatch(/progress/i);
  });
});

describe('the two queues stop sharing a name', () => {
  it('names the pool queue as connection-waiting, scoped to this process', async () => {
    const payload = await diagnostics();

    // worker.queued_count is the durable queue; the pool number is operations
    // waiting for this process's IMAP connection. Reading 23 next to 0 as a
    // contradiction was the correct reading of the old names.
    expect(payload.imap_pool.scope).toMatch(/this process/i);
    expect(JSON.stringify(payload)).not.toMatch(/"queue_depth"/);
  });
});
