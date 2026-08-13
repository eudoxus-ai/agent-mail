import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { openDatabase } from '../../src/ledger/db.js';
import type { Database } from '../../src/ledger/sqlite.js';
import { claimNext } from '../../src/ledger/queue.js';

/**
 * Against a real file, with two real connections.
 *
 * A mocked database cannot exhibit the race this guards. The failure it is
 * looking for — two workers claiming the same job and mutating the same
 * mailbox twice — only exists when two connections contend for one file, so
 * that is what this opens.
 */

let dir: string;
let a: Database;
let b: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-mail-queue-'));
  a = openDatabase(join(dir, 'ledger.db'));
  b = openDatabase(join(dir, 'ledger.db'));
});

afterEach(() => {
  a.close();
  b.close();
  rmSync(dir, { recursive: true, force: true });
});

function queue(db: Database, id: string, accountId: string, createdAt: string): void {
  db.prepare(
    `INSERT INTO intents (id, account_id, tool, params, risk, status, created_at)
     VALUES (?, ?, 'hold_by_sender', '{}', 'medium', 'queued', ?)`
  ).run(id, accountId, createdAt);
}

describe('concurrent claims', () => {
  it('gives one job to exactly one of two claimers', () => {
    queue(a, 'only', 'icloud', '2026-08-04T12:00:00.000Z');

    const first = claimNext(a, 'worker-a', 60_000);
    const second = claimNext(b, 'worker-b', 60_000);

    const winners = [first, second].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.id).toBe('only');

    // And the loser's connection agrees about who owns it.
    const row = b
      .prepare(`SELECT status, claimed_by, attempts FROM intents WHERE id = 'only'`)
      .get() as { status: string; claimed_by: string; attempts: number };
    expect(row.status).toBe('executing');
    expect(row.claimed_by).toBe(winners[0]!.claimed_by);
    // Claimed once means counted once. A second claim would show up here as 2.
    expect(Number(row.attempts)).toBe(1);
  });

  it('claims 50 jobs across two workers exactly once each — no duplicates, no drops', () => {
    // One account per job: the per-account rule would otherwise cap the run at
    // one in-flight job and this would prove nothing about contention.
    const ids = Array.from({ length: 50 }, (_, i) => `job-${i}`);
    ids.forEach((id, i) => {
      queue(
        a,
        id,
        `acct-${i}`,
        new Date(Date.UTC(2026, 7, 4, 12, 0, 0, i)).toISOString()
      );
    });

    const claimedBy = new Map<string, string>();
    // Alternate connections so the two claimers interleave rather than one
    // draining the queue before the other starts.
    for (let round = 0; round < 60; round++) {
      for (const [db, worker] of [
        [a, 'worker-a'],
        [b, 'worker-b'],
      ] as const) {
        const claimed = claimNext(db, worker, 60_000);
        if (!claimed) continue;
        expect(claimedBy.has(claimed.id), `${claimed.id} claimed twice`).toBe(false);
        claimedBy.set(claimed.id, worker);
      }
    }

    expect([...claimedBy.keys()].sort()).toEqual([...ids].sort());

    // Nothing left behind, and nothing counted twice.
    const remaining = a
      .prepare(`SELECT COUNT(*) AS n FROM intents WHERE status = 'queued'`)
      .get() as { n: number };
    expect(Number(remaining.n)).toBe(0);

    const overCounted = a
      .prepare(`SELECT COUNT(*) AS n FROM intents WHERE attempts <> 1`)
      .get() as { n: number };
    expect(Number(overCounted.n)).toBe(0);
  });

  it('lets both workers make progress rather than one starving', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `job-${i}`);
    ids.forEach((id, i) => {
      queue(a, id, `acct-${i}`, new Date(Date.UTC(2026, 7, 4, 12, 0, 0, i)).toISOString());
    });

    const counts = { 'worker-a': 0, 'worker-b': 0 };
    for (let round = 0; round < 10; round++) {
      for (const [db, worker] of [
        [a, 'worker-a'],
        [b, 'worker-b'],
      ] as const) {
        if (claimNext(db, worker, 60_000)) counts[worker]++;
      }
    }

    expect(counts['worker-a']).toBeGreaterThan(0);
    expect(counts['worker-b']).toBeGreaterThan(0);
    expect(counts['worker-a'] + counts['worker-b']).toBe(10);
  });

  it('holds up when the claimers genuinely overlap', { timeout: 60_000, retry: 1 }, async () => {
    // Everything above drives two connections from one thread, so each claim
    // finishes before the next begins — real contention never happens. This
    // spawns separate processes released from a common starting gun, which is
    // the only arrangement in which a read-then-write claim would hand the same
    // job to two workers. Verified: swapping claimNext for a SELECT-then-UPDATE
    // implementation makes this test report 57-77 duplicate claims, on every
    // run — which is why the single retry below cannot mask a real defect. The
    // retry covers the other failure mode: a run where the scheduler never gave
    // the second racer time, so the experiment did not happen.
    //
    // Work is fed in during the race rather than all up front. Pre-seeding the
    // whole queue let whichever racer woke first drain it while its sibling was
    // still being scheduled — an observed 800/0 split, which proves nothing
    // about contention. Feeding it keeps both racers claiming for as long as
    // the feed lasts, however the scheduler treats them.
    const ids = Array.from({ length: 600 }, (_, i) => `job-${i}`);
    const SEEDED = 100;
    const stamp = (i: number) => new Date(Date.UTC(2026, 7, 4, 12, 0, 0, i)).toISOString();
    // One account per job: the per-account rule caps in-flight work at one job
    // per account, and these racers never settle what they claim.
    ids.slice(0, SEEDED).forEach((id, i) => queue(a, id, `acct-${i}`, stamp(i)));

    const dbPath = join(dir, 'ledger.db');
    const racer = join(import.meta.dirname, 'fixtures', 'claim-racer.ts');

    const children = ['racer-1', 'racer-2'].map((workerId) => {
      const child = spawn(process.execPath, ['--import', 'tsx', racer, dbPath, workerId], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));

      const ready = new Promise<void>((resolve, reject) => {
        const check = () => {
          if (out.includes('READY')) resolve();
        };
        child.stdout.on('data', check);
        child.on('error', reject);
        child.on('close', (code) => reject(new Error(`${workerId} exited ${code} early: ${err}`)));
      });

      const done = new Promise<string[]>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => {
          if (code !== 0) return reject(new Error(`${workerId} exited ${code}: ${err}`));
          resolve(
            out
              .split('\n')
              .filter((line) => line.startsWith('CLAIMED '))
              .map((line) => line.slice('CLAIMED '.length))
          );
        });
      });

      return { child, ready, done };
    });

    // Every racer is connected and waiting before any of them may claim.
    await Promise.all(children.map((c) => c.ready));
    for (const { child } of children) child.stdin.end('go\n');

    // Feed the rest in while they run. The racers stop on an idle timeout, so
    // the gaps between batches are fine; running dry for good is what ends it.
    for (let i = SEEDED; i < ids.length; i += 50) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      for (let j = i; j < Math.min(i + 50, ids.length); j++) {
        queue(a, ids[j], `acct-${j}`, stamp(j));
      }
    }

    const runs = await Promise.all(children.map((c) => c.done));

    const all = runs.flat();
    // The claim that matters: every job taken, none taken twice.
    expect(new Set(all).size, `duplicates: ${all.length} claims, ${new Set(all).size} distinct`)
      .toBe(all.length);
    expect([...all].sort()).toEqual([...ids].sort());

    const overCounted = a
      .prepare(`SELECT COUNT(*) AS n FROM intents WHERE attempts <> 1`)
      .get() as { n: number };
    expect(Number(overCounted.n)).toBe(0);

    // And the race was real. Without this the test could pass while one racer
    // quietly drained the queue before the other woke up, which proves nothing
    // about contention — and that is exactly how this test failed before the
    // feed was added. The bar is "both racers were genuinely in it", not a
    // balanced split: the scheduler decides the split, and pinning a percentage
    // to it just makes the test fail on busy machines without finding bugs.
    const bySize = runs.map((r) => r.length).sort((x, y) => y - x);
    expect(bySize[1], `claims by racer: ${bySize.join('/')}`).toBeGreaterThan(10);
  });

  it('sees a claim made on the other connection immediately', () => {
    // WAL readers can lag behind writers. If a worker could not see a claim
    // committed by its sibling, the per-account rule would let two jobs run on
    // one account at once.
    queue(a, 'x', 'icloud', '2026-08-04T12:00:00.000Z');
    queue(a, 'y', 'icloud', '2026-08-04T12:00:01.000Z');

    expect(claimNext(a, 'worker-a', 60_000)?.id).toBe('x');
    expect(claimNext(b, 'worker-b', 60_000)).toBeNull();
  });
});
