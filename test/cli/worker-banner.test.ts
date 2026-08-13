import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import type { Database } from '../../src/ledger/sqlite.js';
import { recordWorkerHeartbeat, describeWorkerState } from '../../src/ledger/worker-heartbeat.js';
import { buildWorkerBanner } from '../../src/cli/worker-banner.js';

/**
 * `agent-mail status` is where someone looks when work is not happening.
 *
 * The banner has to come first. Everything else this command prints — launchd
 * state, node version, cache coverage — is detail that only matters once the
 * thing that performs queued work is running, and a user who reads three
 * screens of healthy-looking output before the bad news usually stops at the
 * first screen.
 */

let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:');
});

function enqueue(id: string, ageSeconds = 0): void {
  db.prepare(
    `INSERT INTO intents (id, account_id, tool, params, risk, status, created_at)
     VALUES (?, 'icloud', 'hold_by_sender', '{}', 'medium', 'queued', ?)`
  ).run(id, new Date(Date.now() - ageSeconds * 1000).toISOString());
}

describe('buildWorkerBanner', () => {
  it('shouts when work is queued and nothing is running it', () => {
    enqueue('a', 300);
    const banner = buildWorkerBanner(describeWorkerState(db))!;

    expect(banner).toBeTruthy();
    expect(banner).toContain('2 action(s)'.replace('2', '1'));
    expect(banner).toContain('install-daemon');
    // "Nothing has been lost" is the part that stops someone re-running fifty
    // holds and doubling them up once the daemon comes back.
    expect(banner.toLowerCase()).toContain('nothing has been lost');
  });

  it('says how long the oldest job has been waiting', () => {
    enqueue('a', 600);
    const banner = buildWorkerBanner(describeWorkerState(db))!;
    expect(banner).toMatch(/\b(600|10m|10 m)/);
  });

  it('still mentions a stopped daemon with an empty queue', () => {
    // Quieter, but not silent: someone checking status before filing work
    // deserves to know it will just sit there.
    const banner = buildWorkerBanner(describeWorkerState(db))!;
    expect(banner).toBeTruthy();
    expect(banner).toContain('install-daemon');
  });

  it('says nothing at all when a worker is beating', () => {
    enqueue('a');
    recordWorkerHeartbeat(db, { workerId: 'w', pid: 1 });

    // No banner on a healthy system. A warning that shows up when things are
    // fine is a warning people learn to scroll past.
    expect(buildWorkerBanner(describeWorkerState(db))).toBeNull();
  });
});

/**
 * The ordering, against the real command. Extracting the banner is not enough
 * — it has to be printed before the early return for "daemon not installed",
 * which is the exact situation where the message matters most.
 */
describe('agent-mail status ordering', () => {
  const logs: string[] = [];
  let statusDb: Database;

  beforeEach(() => {
    logs.length = 0;
    statusDb = openDatabase(':memory:');
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('leads with the banner even when the daemon is not installed', async () => {
    statusDb
      .prepare(
        `INSERT INTO intents (id, account_id, tool, params, risk, status)
         VALUES ('a', 'icloud', 'hold_by_sender', '{}', 'medium', 'queued')`
      )
      .run();

    // Only the launchd plist is missing. The ledger has to look present, or
    // the banner short-circuits on "no ledger, nothing to report" and this
    // test would pass for the wrong reason.
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        existsSync: (path: string) => !String(path).endsWith('.plist'),
      };
    });
    vi.doMock('../../src/ledger/db.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/ledger/db.js')>();
      return { ...actual, openDatabase: () => statusDb };
    });

    const { daemonStatus } = await import('../../src/cli/daemon.js');
    await daemonStatus();

    // Not merely present — first. "Daemon: not installed" is the line that
    // would otherwise be mistaken for the whole answer.
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]).toContain('install-daemon');
    expect(logs.join('\n')).toContain('not installed');
  });
});
