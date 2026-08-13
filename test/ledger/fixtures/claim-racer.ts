/**
 * Claims from a ledger as fast as it can, in its own process.
 *
 * Spawned several at a time by queue-concurrency.test.ts so that claims
 * genuinely overlap. Two connections driven from one thread cannot interleave —
 * each call finishes before the next begins — so a single-threaded test would
 * pass against a claim that reads and then writes in two statements, which is
 * exactly the bug worth catching.
 *
 * Usage: claim-racer.ts <dbPath> <workerId>
 * Prints `READY`, waits for any byte on stdin, then prints one claimed intent
 * id per line. The stdin handshake is the starting gun: a wall-clock deadline
 * drifts under load and lets one racer drain the queue before its siblings
 * finish starting up, which turns a race test into a coin flip.
 */
import { openDatabase } from '../../../src/ledger/db.js';
import { claimNext } from '../../../src/ledger/queue.js';

const [dbPath, workerId] = process.argv.slice(2);

const db = openDatabase(dbPath);

process.stdout.write('READY\n');
await new Promise<void>((resolve) => {
  process.stdin.once('data', () => resolve());
});

const IDLE_EXIT_MS = 1_500;

const claimed: string[] = [];
// Quit on idle time, not on a count of empty polls. The parent keeps feeding
// the queue during the race, so an empty poll means "nothing right now", not
// "nothing ever" — and a poll-count limit would expire during a feed gap.
let lastClaimAt = Date.now();
while (Date.now() - lastClaimAt < IDLE_EXIT_MS) {
  const intent = claimNext(db, workerId, 60_000);
  if (intent) {
    claimed.push(intent.id);
    lastClaimAt = Date.now();
  }
  // Yield between claims. A racer that never yields runs its whole loop inside
  // one scheduling quantum and drains the queue before its sibling is ever
  // scheduled — the observed failure was a clean 800/0 split, which is not a
  // race at all. Yielding keeps both processes cycling against the same file,
  // which is the condition the test exists to create.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

process.stdout.write(claimed.map((id) => `CLAIMED ${id}\n`).join(''));
db.close();
