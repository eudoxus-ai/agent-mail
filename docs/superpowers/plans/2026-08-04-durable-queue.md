# Durable Background Queue — Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax. Each task is write-failing-test → verify it fails → implement → verify it passes → commit. Do not skip the "verify it fails" step: this codebase has already shipped two bugs past green suites because a fake had drifted from the real implementation.

**Goal:** Accepted work survives a process restart. The ledger becomes the queue, the daemon becomes the sole executor of mutations, and a missing daemon is impossible to overlook.

**Spec:** `docs/superpowers/specs/2026-08-04-durable-queue-design.md`

**Tech Stack:** TypeScript, `node:sqlite` (SQLite 3.51 via Node 24.15.0), ImapFlow, Vitest.

**Implementation order:** Phase 1 (UIDVALIDITY safety — standalone, ships alone) → Phase 2 (queue schema + claim) → Phase 3 (worker) → Phase 4 (squawk) → Phase 5 (cut bulk holds over) → Phase 6 (remaining mutations) → Phase 7 (visibility).

Phases 1 and 2–5 are independently shippable. Stop after Phase 5 and the system is strictly better than today; Phase 6 is the part that changes how quick mutations feel and deserves its own review.

---

## File Structure

**Create:**
- `src/ledger/queue.ts` — claim, heartbeat, reclaim, requeue, queue-position queries.
- `src/ledger/worker-heartbeat.ts` — worker liveness record and `isWorkerAlive()`.
- `src/daemon/worker.ts` — the drain loop that claims and executes.
- `test/ledger/queue.test.ts`
- `test/ledger/queue-concurrency.test.ts` — two real connections, one file. Not mocked.
- `test/ledger/uidvalidity-guard.test.ts`
- `test/daemon/worker.test.ts`
- `test/server/daemon-down.test.ts`

**Modify:**
- `src/ledger/migrations.ts` — migrations 7–9.
- `src/ledger/db.ts` — `status` CHECK gains `queued`.
- `src/ledger/intent-targets.ts` — `uidvalidity` column + generation guard.
- `src/executor/executor.ts` — enqueue instead of execute; remove the background cap; UIDVALIDITY check before acting on a target.
- `src/server/middleware.ts` — enqueue path, short-wait path, daemon-down payload.
- `src/reviewer/daemon.ts` — start the worker, write heartbeats.
- `src/server/server.ts` — liveness check at startup; preamble note.
- `src/cli/daemon.ts` — `status` leads with worker liveness.
- `src/tools/*.ts` — descriptions mention `queued`.
- `README.md`

---

## Phase 1 — UIDVALIDITY safety (standalone)

A durable queue is at-least-once: a worker that dies after the IMAP move but before writing `executed` will be reclaimed and re-run. Replaying a move by UID is only meaningful within a `(mailbox, UIDVALIDITY)` generation. `intent_targets` records no generation, so a replay after a UIDVALIDITY change could move mail the user never selected.

This is already latent — `undo_intent` and `restore_messages` replay recorded UIDs today — so it ships on its own regardless of the queue.

### Task 1.1: Record UIDVALIDITY on every target

- [ ] **Step 1: Write the failing test** — `test/ledger/uidvalidity-guard.test.ts`
  - `insertIntentTargets` persists `uidvalidity` and `getIntentTargets` returns it.
  - A target inserted without one reads back `null` (back-compat for rows written before this change).
- [ ] **Step 2: Run, verify it fails**
- [ ] **Step 3: Implement**
  - Migration 7: `ALTER TABLE intent_targets ADD COLUMN uidvalidity INTEGER`.
  - Add `uidvalidity?: number` to `IntentTargetInsert` and `uidvalidity: number | null` to `IntentTargetRow`; thread through insert and read.
- [ ] **Step 4: Verify PASS**
- [ ] **Step 5: Commit**

### Task 1.2: Capture it at hold time

- [ ] **Step 1: Write the failing test** — extend `test/ledger/crash-recoverability.test.ts`
  - A hold records the mailbox's current UIDVALIDITY on each target.
- [ ] **Step 2: Verify it fails**
- [ ] **Step 3: Implement** — `holdTargets` already calls `imap.mailboxSnapshot()` indirectly via the pool; fetch `uidValidity` per mailbox once per batch and pass it into `insertIntentTargets`.
- [ ] **Step 4: Verify PASS**
- [ ] **Step 5: Commit**

### Task 1.3: Refuse to act on a stale generation

- [ ] **Step 1: Write the failing test**
  - `restore_messages` on a target whose recorded `uidvalidity` differs from the mailbox's current value fails with a clear reason and moves nothing.
  - A target with `uidvalidity: null` (pre-migration row) is allowed through, with a warning logged — refusing would break undo for everything recorded before this change.
- [ ] **Step 2: Verify it fails**
- [ ] **Step 3: Implement** — a `assertGenerationMatches(imap, mailbox, recorded)` helper in the executor, called before any replay path (`restore_messages`, `undo_intent`, worker retry).
- [ ] **Step 4: Verify PASS**
- [ ] **Step 5: Commit**

**Ship gate:** Phase 1 can merge on its own. Everything below assumes it.

---

## Phase 2 — Queue schema and claim protocol

### Task 2.1: `queued` status and claim columns

- [ ] **Step 1: Write the failing test** — `test/ledger/queue.test.ts`
  - An intent can be created with status `queued`.
  - The CHECK constraint rejects a nonsense status.
  - `claimed_by` / `claimed_at` / `lease_expires_at` / `attempts` round-trip.
- [ ] **Step 2: Verify it fails**
- [ ] **Step 3: Implement**
  - Migration 8: SQLite cannot ALTER a CHECK constraint, so rebuild `intents` the way migration 6 rebuilt `intent_targets` — create `intents_v2` with the widened CHECK and the four new columns, `INSERT … SELECT`, drop, rename. Preserve every existing column including `progress`, `reverses_intent_id`, `reversed_by_intent_id`.
  - Index: `CREATE INDEX idx_intents_queued ON intents(status, created_at) WHERE status IN ('queued','executing')`.
- [ ] **Step 4: Verify PASS** — plus a test that an existing populated ledger survives the rebuild with all rows and columns intact.
- [ ] **Step 5: Commit**

> **Care:** this migration rewrites the ledger's primary table. Test it against a database populated with rows in every status, not an empty one.

### Task 2.2: The claim CAS

- [ ] **Step 1: Write the failing test** — `test/ledger/queue.test.ts`
  - `claimNext(db, workerId, leaseMs)` returns the oldest `queued` intent and flips it to `executing`.
  - It sets `claimed_by`, `lease_expires_at`, and increments `attempts`.
  - It returns `null` when nothing is queued.
  - It skips accounts already claimed by the caller (one in-flight claim per account).
- [ ] **Step 2: Verify it fails**
- [ ] **Step 3: Implement** — `src/ledger/queue.ts`, single statement, guard-as-CAS:
  ```sql
  UPDATE intents
     SET status='executing', claimed_by=?, claimed_at=CURRENT_TIMESTAMP,
         lease_expires_at=?, attempts=attempts+1
   WHERE id = (SELECT id FROM intents
                WHERE status='queued' AND account_id NOT IN (…)
                ORDER BY created_at LIMIT 1)
     AND status='queued'
  RETURNING *
  ```
  `RETURNING` needs SQLite ≥ 3.35; the pinned runtime has 3.51. Verified working.
- [ ] **Step 4: Verify PASS**
- [ ] **Step 5: Commit**

### Task 2.3: Concurrent claim safety — against a real file

- [ ] **Step 1: Write the failing test** — `test/ledger/queue-concurrency.test.ts`
  - Two `DatabaseSync` connections to the **same temp file**, one queued intent, both call `claimNext`. Exactly one gets it; the other gets `null`.
  - Repeat across ~50 intents and two claimers: every intent claimed exactly once, no duplicates, no drops.
- [ ] **Step 2: Verify it fails** (it will pass trivially if you forget the CAS guard — delete the `AND status='queued'` line and confirm the test then fails, so you know it is actually testing something)
- [ ] **Step 3: Implement** — no new code expected; this proves 2.2.
- [ ] **Step 4: Verify PASS**
- [ ] **Step 5: Commit**

> Two real connections on one file, deliberately. A mocked database cannot exhibit the race this is guarding.

### Task 2.4: Lease, heartbeat, reclaim

- [ ] **Step 1: Write the failing test**
  - `heartbeat(db, intentId, workerId, leaseMs)` extends `lease_expires_at`, and only for the owning worker.
  - `reclaimExpired(db)` returns expired-lease `executing` intents to `queued` and clears `claimed_by`.
  - It leaves an unexpired lease alone.
  - An intent at `attempts >= 3` goes to `failed` with a structured `error_detail` instead of being requeued.
- [ ] **Step 2: Verify it fails**
- [ ] **Step 3: Implement** — in `src/ledger/queue.ts`.
- [ ] **Step 4: Verify PASS**
- [ ] **Step 5: Commit**

### Task 2.5: Lease must outlive the operation timeout

- [ ] **Step 1: Write the failing test**
  - Constructing a worker with `leaseMs <= pool.operationTimeoutMs` throws at startup with a message naming both values.
- [ ] **Step 2: Verify it fails**
- [ ] **Step 3: Implement** — assert in the worker constructor.
- [ ] **Step 4: Verify PASS**
- [ ] **Step 5: Commit**

> A lease shorter than the IMAP timeout means a legitimately slow sweep gets reclaimed and re-run underneath itself — silent duplicate mutation. Fail loudly at startup instead.

---

## Phase 3 — The worker

### Task 3.1: Drain loop

- [ ] **Step 1: Write the failing test** — `test/daemon/worker.test.ts`, executor stubbed
  - A queued intent is claimed, executed, and ends `executed`.
  - A failing intent ends `failed` with `error_detail`, and the loop continues.
  - Two accounts progress concurrently; one account's queue is FIFO.
  - `stop()` finishes the in-flight job and claims nothing further.
- [ ] **Step 2: Verify it fails**
- [ ] **Step 3: Implement** — `src/daemon/worker.ts`. Tick on an interval; per tick, claim while capacity remains (one per account), run `executor.performQueued(intent)`, heartbeat on a timer for the duration, settle status. Never let a rejection escape — an unhandled rejection here kills the daemon.
- [ ] **Step 4: Verify PASS**
- [ ] **Step 5: Commit**

### Task 3.2: Crash recovery end to end

- [ ] **Step 1: Write the failing test**
  - Claim an intent, then simulate the worker vanishing (stop heartbeating, do not settle). After the lease expires, `reclaimExpired` requeues it and a second worker completes it.
  - Assert `attempts` is 2 and the terminal status is `executed`.
- [ ] **Step 2: Verify it fails**
- [ ] **Step 3: Implement** — call `reclaimExpired` at daemon startup and on each tick.
- [ ] **Step 4: Verify PASS**
- [ ] **Step 5: Commit**

### Task 3.3: Wire into the daemon

- [ ] **Step 1: Write the failing test** — worker starts with the daemon and stops on shutdown.
- [ ] **Step 2: Verify it fails**
- [ ] **Step 3: Implement** — construct in `src/reviewer/daemon.ts` alongside `SyncLoop`; add to the shutdown path.
- [ ] **Step 4: Verify PASS**
- [ ] **Step 5: Commit**

---

## Phase 4 — Squawk when the daemon is absent (D1)

The bar: **a user must never believe they filed fifty holds and have filed none.**

### Task 4.1: Worker heartbeat record

- [ ] **Step 1: Write the failing test** — `test/ledger/queue.test.ts`
  - `recordWorkerHeartbeat` writes worker id, pid, and timestamp.
  - `isWorkerAlive(db, staleAfterMs)` is true just after a heartbeat, false once stale, false when none was ever written.
- [ ] **Step 2: Verify it fails**
- [ ] **Step 3: Implement** — migration 9 adds a single-row `worker_heartbeat` table; helpers in `src/ledger/worker-heartbeat.ts`. Daemon heartbeats every 15s; stale after 60s.
- [ ] **Step 4: Verify PASS**
- [ ] **Step 5: Commit**

### Task 4.2: Say so in every affected surface

- [ ] **Step 1: Write the failing tests** — `test/server/daemon-down.test.ts`
  - With no live worker, a queued mutation response includes `daemon_running: false` and a `warning` naming the fix (`agent-mail install-daemon`).
  - With a live worker, neither field is present.
  - `get_intent` on a `queued` intent reports the same when the worker is down.
  - `get_diagnostics` leads with it: `worker.alive: false` plus `queued_count` and `oldest_queued_age_seconds`.
- [ ] **Step 2: Verify they fail**
- [ ] **Step 3: Implement** — a shared `describeWorkerState(db)` used by all three, so the wording cannot drift between them.
- [ ] **Step 4: Verify PASS**
- [ ] **Step 5: Commit**

### Task 4.3: CLI and startup

- [ ] **Step 1: Write the failing test** — `agent-mail status` prints a worker-down banner *before* anything else when the worker is stale and work is queued.
- [ ] **Step 2: Verify it fails**
- [ ] **Step 3: Implement**
  - `daemonStatus()` leads with the banner.
  - MCP server logs at **error** level on startup when no live worker is found — not warn.
  - Server preamble gains one line: if a mutation stays `queued`, call `get_diagnostics`.
- [ ] **Step 4: Verify PASS**
- [ ] **Step 5: Commit**

---

## Phase 5 — Cut bulk holds over

### Task 5.1: Enqueue instead of executing in-process

- [ ] **Step 1: Write the failing tests** — extend `test/server/background-execution.test.ts`
  - `hold_by_sender` creates an intent at `queued` and returns its id.
  - The MCP-side executor does **not** run the action (no IMAP calls).
  - The response keeps `intent_id`, `how_to_check`, `how_to_undo`.
- [ ] **Step 2: Verify they fail**
- [ ] **Step 3: Implement** — replace `executeInBackground`'s in-memory IIFE with a `queued` insert. Delete the fire-and-forget closure entirely; it must not survive as a fallback.
- [ ] **Step 4: Verify PASS**
- [ ] **Step 5: Commit**

### Task 5.2: Remove the background cap

- [ ] **Step 1: Write the failing test** — 50 queued holds all succeed; no `queue_full`.
- [ ] **Step 2: Verify it fails**
- [ ] **Step 3: Implement** — delete `BackgroundQueueFullError`, `backgroundInFlight`, `AGENT_MAIL_MAX_BACKGROUND`, and the `queue_full` branch. Keep a much higher sanity bound (say 1000 queued) purely as a runaway-loop backstop, with its own distinct error.
- [ ] **Step 4: Verify PASS** — and delete the now-obsolete cap tests rather than leaving them asserting removed behavior.
- [ ] **Step 5: Commit**

### Task 5.3: End-to-end, real SQLite

- [ ] **Step 1: Write the failing test**
  - Enqueue via the middleware, run a worker against the same database file, assert the intent reaches `executed` and targets are recorded.
  - Restart simulation: enqueue 5, run the worker for one job, drop it, start a new worker, assert all 5 finish. **This is the test that would have caught the original bug.**
- [ ] **Step 2: Verify it fails**
- [ ] **Step 3: Implement** — no new code expected.
- [ ] **Step 4: Verify PASS**
- [ ] **Step 5: Commit**

**Ship gate:** merge here. Bulk holds are durable, the cap is gone, a missing daemon is loud.

---

## Phase 6 — Remaining mutations (separate review)

### Task 6.1: Route the rest through the queue

- [ ] **Step 1: Write failing tests** — `label_thread`, `draft_reply`, `unsubscribe_sender`, `restore_messages`, `undo_intent` each create a `queued` intent and are not executed by the MCP process.
- [ ] **Step 2: Verify they fail**
- [ ] **Step 3: Implement** — extend the enqueue path to all of `MUTATING_TOOLS` except `queue_send`, which is always gated and already returns an id up front.
- [ ] **Step 4: Verify PASS**
- [ ] **Step 5: Commit**

### Task 6.2: Short wait for quick mutations (D2a)

- [ ] **Step 1: Write failing tests**
  - A quick tool whose intent reaches `executed` within the window returns the terminal result, not an id.
  - One that does not returns `intent_id` and `status: queued` — not an error.
  - The poll stops immediately on a terminal status rather than always burning the full window.
- [ ] **Step 2: Verify they fail**
- [ ] **Step 3: Implement** — `QUICK_TOOLS` set; poll the ledger (~200ms interval, ~10s ceiling, both configurable).
- [ ] **Step 4: Verify PASS**
- [ ] **Step 5: Commit**

---

## Phase 7 — Visibility and docs

### Task 7.1: `queue_position`

- [ ] **Step 1: Write the failing test** — `get_intent` on a `queued` intent reports its position; the oldest is 1; an `executing` intent has none.
- [ ] **Step 2–5:** implement, verify, commit.

### Task 7.2: Diagnostics worker block

- [ ] **Step 1: Write the failing test** — `get_diagnostics` reports `worker: {alive, last_heartbeat, claims}` and `queue: {queued, oldest_queued_age_seconds}`, and the `interpretation` names a stopped worker as the cause when work is queued and nothing is claimed.
- [ ] **Step 2–5:** implement, verify, commit.

### Task 7.3: Docs

- [ ] Tool descriptions mention `queued` and how to poll.
- [ ] README: a "How work is executed" section — the daemon is the executor, what `queued` means, what happens when it is down, and how to check.
- [ ] Update the spec's Status to Implemented.

---

## Verification

Both must be green before each commit:

```bash
npm run typecheck
npm test
```

Before the Phase 5 and Phase 6 ship gates, additionally:

```bash
npm run build
./bin/agent-mail.mjs status   # worker banner behaves as intended
```

`npm run audit` currently fails on pre-existing transitive dev-dependency advisories unrelated to this work; do not treat it as a gate unless it regresses.

## Risks

| Risk | Mitigation |
|---|---|
| Migration 8 rewrites `intents` | Test against a ledger populated in every status; verify row count and every column after |
| Lease shorter than IMAP timeout duplicates work | Startup assertion (Task 2.5) |
| At-least-once replays a move | Phase 1 generation guard; `hold_by_sender` is naturally idempotent |
| Worker dies repeatedly on one job | `attempts >= 3` → `failed`, not requeued |
| Daemon down goes unnoticed | Phase 4, four surfaces, shared wording |
| A fake diverges from the real implementation | Claim and end-to-end tests run against real SQLite files, not mocks |
