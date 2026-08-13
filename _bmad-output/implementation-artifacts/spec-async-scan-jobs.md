---
title: 'Async scan jobs — long reads return a pollable handle instead of hanging'
type: 'feature'
created: '2026-06-08'
status: 'done'
baseline_commit: 'd4b7c5da86ce4b5f4b6cd1a0eca13a6c590edcde'
context: ['{project-root}/_bmad-output/project-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Heavy read scans (`get_overview`, `list_senders`, `search_threads`) run synchronously and hold the per-account IMAP connection while the MCP request blocks — large windows produced 4-minute client timeouts and an apparently-dead server. The biggest offender is `get_overview`'s unbounded `fetchEnvelopes(allUids)`.

**Approach:** Add an opt-in `async` mode: a long scan registers a `scan_jobs` ledger row, returns a `{ job_id, status: "running" }` handle immediately, and runs the *same* scan function as a background promise on the long-lived stdio process, writing its result back to the row. A new read-only `get_scan_result` tool lets the agent poll. Protect the synchronous path too: bound `get_overview`'s envelope fetch and add a fail-fast per-call timeout so a sync call errors with "retry with async:true" instead of hanging.

## Boundaries & Constraints

**Always:**
- Tools stay thin declarations; the runner + scan logic live under `src/executor/` (project-context architecture rule).
- New `get_scan_result` tool gets accurate MCP annotations (`readOnlyHint: true`) **and** a `src/policy/defaults.ts` entry (`risk: none`, ungated) so it isn't gated conservatively.
- Schema change goes through `src/ledger/migrations.ts` (idempotent column/table check), schema declared in `src/ledger/db.ts`.
- Background scans run in-process on the shared `pool`/`db` singletons via `pool.withConnection`; results persist to the ledger (survives the poll gap, not just memory).
- `.js` import extensions everywhere; `strict` null handling.
- `async` defaults to `false` — existing synchronous calls behave exactly as today (back-compat).

**Ask First:**
- Changing any existing default window/limit constant (`DEFAULT_WINDOW_DAYS`, `DEFAULT_LIMIT_PER_CATEGORY`, `scan_limit`, search `limit`). Bounding the *fetch* is in scope; changing user-facing defaults is not without approval.
- The default timeout value if you want it to differ from 30s.

**Never:**
- Don't make reads gated or route them through the intent/approval flow — scans are reads, they use `scan_jobs`, not the `intents` table.
- Don't spin up a separate daemon/process for background scans — run inside the MCP server process.
- Don't introduce any cloud call, queue, or telemetry (local-first hard constraint).
- Don't abandon a job's result to memory only — a completed job must be readable after the fact.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Sync small scan | `async` omitted/false | Inline results, identical to today | N/A |
| Async scan start | `async: true` | Returns `{ job_id, status: "running" }` immediately; scan runs in background | N/A |
| Poll while running | `get_scan_result{job_id}` mid-run | `{ status: "running" }` | N/A |
| Poll when done | job completed | `{ status: "done", result: <same payload sync would return> }` | N/A |
| Poll failed job | scan threw | `{ status: "failed", error: <message> }` | Error surfaced, not thrown |
| Unknown job_id | bad/absent id | Tool error "scan job not found" | Clear error text |
| Sync scan exceeds timeout | heavy sync call | Fails fast with error advising `async: true` | Returns control; bounded op finishes & frees connection |
| get_overview large UID set | window with many msgs | Envelope fetch capped at the bound; no unbounded fetch | N/A |
| Process restart mid-scan | `running` rows orphaned at boot | Marked `failed` (stale) on startup | Poll returns `failed`, agent re-issues |

</frozen-after-approval>

## Code Map

- `src/ledger/db.ts` -- add `scan_jobs` `CREATE TABLE IF NOT EXISTS` to schema.
- `src/ledger/migrations.ts` -- idempotently create `scan_jobs` for existing DBs (mirror existing column-check pattern).
- `src/ledger/scan-jobs.ts` -- NEW DAO: `createScanJob`, `completeScanJob`, `failScanJob`, `getScanJob`, `failStaleRunningJobs`. Mirror `intent-targets.ts` prepared-statement style.
- `src/executor/scan-jobs-runner.ts` -- NEW `ScanJobRunner`: `start(tool, params, agentId, work)` → inserts `running` row, fires `work()` background promise, writes `done`/`failed` on settle. Holds `db` + a timeout wrapper helper.
- `src/executor/executor.ts` -- expose a public `runRead(tool, params, accountIds)` returning the raw payload (reuse `searchThreadsMulti`/`listSendersMulti` without creating an intent); add a `withTimeout` guard usable by the sync path.
- `src/tools/get-overview.ts` -- add `async` param; bound the `fetchEnvelopes` UID set in `collectAccountBundle`.
- `src/tools/list-senders.ts`, `src/tools/search-threads.ts` -- add `async` param to schemas + description guidance ("for large scans pass async:true, poll get_scan_result").
- `src/tools/get-scan-result.ts` -- NEW read-only tool def (`{ job_id }`).
- `src/policy/defaults.ts` -- add `get_scan_result` entry (`risk: none`, ungated, non-reversible).
- `src/server/server.ts` -- async branch for the 3 read tools (→ `ScanJobRunner.start` → handle); special-case `get_scan_result` as a DB read (like `get_pending_actions`); register it in the tool list.
- `src/server/startup.ts` -- call `failStaleRunningJobs(db)` at boot (mirror `checkStuckExecuting`).

## Tasks & Acceptance

**Execution:**
- [x] `src/ledger/db.ts` -- declare `scan_jobs` (id PK, tool, params JSON, status CHECK('running','done','failed'), result JSON null, error_detail JSON null, agent_id, created_at, completed_at).
- [x] `src/ledger/migrations.ts` -- create `scan_jobs` if absent so existing ledgers upgrade in place.
- [x] `src/ledger/scan-jobs.ts` -- DAO + `failStaleRunningJobs` (running → failed with a "server restarted" detail).
- [x] `src/executor/scan-jobs-runner.ts` -- `ScanJobRunner.start(...)`; background settle writes result/error; never rejects to the caller.
- [x] `src/executor/executor.ts` -- public `runRead(...)` (no-intent read path) + reusable `withTimeout` (lives in scan-jobs-runner.ts, used by the sync path).
- [x] `src/tools/get-overview.ts` -- `async` param + bounded envelope fetch.
- [x] `src/tools/list-senders.ts`, `src/tools/search-threads.ts` -- `async` param + description.
- [x] `src/tools/get-scan-result.ts` + `src/policy/defaults.ts` -- new tool + policy default.
- [x] `src/server/server.ts` -- async dispatch branch + `get_scan_result` handler + registration.
- [x] `src/server/startup.ts` -- stale-job cleanup at boot.
- [x] `test/**` -- mirror each new module 1:1; cover every I/O Matrix row (async start, poll running/done/failed, unknown id, timeout fail-fast, stale-on-restart, bounded fetch).

**Acceptance Criteria:**
- Given `async: true` on any of the three read tools, when called, then the MCP response returns within ~1s carrying a `job_id` while the scan continues in the background.
- Given a completed async job, when `get_scan_result` is polled, then it returns the byte-identical payload the synchronous form would have produced.
- Given a synchronous scan that exceeds the timeout, when it trips, then the caller gets a fast error naming `async: true` rather than a multi-minute hang, and the IMAP connection is released for the next call.
- Given the server restarts while a job is `running`, when it boots, then that job is marked `failed` and a poll reports `failed` (no permanent `running` zombie).
- Given `npm run validate`, when run, then typecheck + tests + audit pass.

## Design Notes

**Why a new `scan_jobs` table, not the `intents` ledger:** intents model gated/reversible *side effects* with a CHECK-constrained status machine, undo tokens, and audit transitions. Scans are idempotent reads with a result blob — overloading `intents` would pollute its enums/audit semantics. Separate table keeps both clean (project-context: keep TS types and SQL CHECK lists in sync).

**Background lifetime:** the stdio MCP process is long-lived and the pool's keepalive timer is `unref()`'d, so a detached `work()` promise survives between tool calls. The promise itself holds the `db`/`pool` refs. No new event loop needed.

**Timeout caveat:** imapflow can't always abort an in-flight fetch, so `withTimeout` returns control to the agent while the (now-bounded, therefore fast) op drains and frees the connection — a fail-fast guard, not a hard kill. Bounding `get_overview`'s fetch is the primary fix; the timeout is the safety net. `ScanJobRunner.start` inserts the `running` row, then attaches `.then/.catch` to `work()` to write `done`/`failed` — it never rejects to the caller.

## Verification

**Commands:**
- `npm run validate` -- expected: typecheck + vitest + `npm audit --audit-level=high` all green.

**Manual checks:**
- Run `npm run serve`, call `get_overview` with `async:true` on a wide window → immediate `job_id`; poll `get_scan_result` → eventually `done` with the overview payload. Confirm the server stays responsive to other tool calls during the scan.

## Suggested Review Order

**Design intent — async dispatch seam**

- Start here: the `async: true` branch that returns a job handle vs. the timed sync path — the whole feature's shape.
  [`server.ts:202`](../../src/server/server.ts#L202)
- Same seam for the executor-routed read tools (`list_senders`/`search_threads`), incl. the sync `withTimeout` guard.
  [`server.ts:323`](../../src/server/server.ts#L323)

**Background runner & timeout guard**

- `ScanJobRunner.start` — inserts `running`, fires the detached `work()`, settle-writes are crash-proofed.
  [`scan-jobs-runner.ts:64`](../../src/executor/scan-jobs-runner.ts#L64)
- `withTimeout` — fail-fast guard that advises `async: true`; deliberately not a hard kill.
  [`scan-jobs-runner.ts:21`](../../src/executor/scan-jobs-runner.ts#L21)
- `runRead` — no-intent read path reusing the same scan methods so async output is byte-identical to sync.
  [`executor.ts:215`](../../src/executor/executor.ts#L215)

**Persistence — scan_jobs ledger**

- DAO with CAS-guarded settles (`WHERE status='running'`) so a late settle can't clobber a terminal row.
  [`scan-jobs.ts:45`](../../src/ledger/scan-jobs.ts#L45)
- Boot reaper (`running`→`failed`) + 7-day prune of terminal rows — no zombies, no unbounded growth.
  [`scan-jobs.ts:86`](../../src/ledger/scan-jobs.ts#L86)
- Schema declared inline and mirrored idempotently in migrations (codebase convention).
  [`db.ts:34`](../../src/ledger/db.ts#L34)
  [`migrations.ts:42`](../../src/ledger/migrations.ts#L42)

**Tool surface**

- New read-only poll tool — thin declaration, DB-read only.
  [`get-scan-result.ts:6`](../../src/tools/get-scan-result.ts#L6)
- Bounded fetch, now per-category so a high `limit_per_category` can't starve a category.
  [`get-overview.ts:260`](../../src/tools/get-overview.ts#L260)
- `async` param added to the two executor-routed read tools.
  [`list-senders.ts:16`](../../src/tools/list-senders.ts#L16)
  [`search-threads.ts:47`](../../src/tools/search-threads.ts#L47)
- Policy default for the new tool (`risk: none`, ungated) so it isn't gated conservatively.
  [`defaults.ts:20`](../../src/policy/defaults.ts#L20)

**Boot wiring & tests (peripheral)**

- Stale-reap + prune invoked at server construction.
  [`startup.ts:17`](../../src/server/startup.ts#L17)
  [`server.ts:123`](../../src/server/server.ts#L123)
- New test modules mirror each new unit and cover every I/O Matrix row.
  [`scan-jobs.test.ts`](../../test/ledger/scan-jobs.test.ts) · [`scan-jobs-runner.test.ts`](../../test/executor/scan-jobs-runner.test.ts) · [`run-read.test.ts`](../../test/executor/run-read.test.ts) · [`get-scan-result.test.ts`](../../test/tools/get-scan-result.test.ts) · [`get-overview-bounded-fetch.test.ts`](../../test/tools/get-overview-bounded-fetch.test.ts) · [`scan-cleanup-on-start.test.ts`](../../test/server/scan-cleanup-on-start.test.ts)
