# Durable Background Queue — Design

**Date:** 2026-08-04
**Status:** Proposed. D2 is decided (all mutations via the daemon); D1 is a recommendation whose stakes D2 raises — see "Decisions".
**Scope:** Make accepted background work survive a process restart.

## Problem

`background: true` returns an `intent_id` immediately and runs the action in an in-memory async closure. The per-account queue is a promise chain in process memory. **Nothing anywhere records "waiting to run."**

So an accepted job is a closure in one process. If the MCP server restarts — Claude Desktop quitting is enough — every queued job vanishes while its intent stays marked `executing` in the ledger forever. The caller holds an `intent_id` for work that will never happen and never fail.

That gap is why background depth is currently capped at 8: the cap is not a throughput control (per-account serialization means a queue of 50 drains at the same rate as a queue of 8) but a bound on how much a restart can strand.

Returning an `intent_id` is a promise the system does not currently keep. This closes that.

## What exists today

Useful groundwork already in place:

- **The ledger is a durable, multi-process store.** SQLite in WAL mode, `busy_timeout`, already shared between MCP servers and the reviewer.
- **Intents already have a lifecycle** with `executing` as an intermediate state, and `checkStuckExecuting` already detects crash-interrupted work at startup.
- **The daemon is already long-lived** and already executes mutations: an approved gated intent runs via `approveAndExecute` inside the reviewer, which is the daemon.
- **Targets are written before the move** (PR #12), so an interrupted action already leaves a restorable record.
- **`get_diagnostics` already reports** queue depth, in-flight operations, and orphaned intents.

The missing piece is only the durable hand-off between "accepted" and "running".

## Decisions

Both are recommendations. Each is isolated enough to change without redesigning the rest.

### D1 (proposed): when the daemon is down, accept and warn loudly

Queue the work durably, return the `intent_id`, and state plainly — in the tool response, in `get_intent`, and in `get_diagnostics` — that nothing will execute until the daemon starts.

Rejected alternatives:

- **Refuse to queue.** Cleanest semantics, but makes the daemon hard-required: if launchd drops it, background holds simply stop working, and the failure lands on the agent rather than on the person who can fix it.
- **Fall back to inline execution.** Best immediate UX, but keeps two execution paths and two IMAP consumers per account permanently — which is what produced the contention this project spent a week debugging. Also means "accepted" means two different things depending on invisible state.

Accepting and warning keeps one execution path and one meaning of "accepted": the work is durably recorded and will run. The cost is that a stopped daemon shows up as work sitting idle rather than as an error, so the warning has to be prominent and `agent-mail status` has to lead with it.

**D2 raises the stakes on this considerably.** With every mutation queued, a stopped daemon means *nothing that changes mail works* — not a label, not a draft, not an undo. Under D1 each of those silently accepts and sits. That is defensible only if the daemon being down is loud and hard to miss:

- The MCP server checks worker liveness on startup and logs an error, not a warning, when the daemon is absent.
- Every queued response while the daemon is down says so in the payload, not just in a log.
- `agent-mail status` leads with it.
- The server preamble tells agents to call `get_diagnostics` when a mutation stays `queued`.

If that still feels too quiet, the alternative is to refuse mutations outright when no worker has heartbeated recently — an explicit, loud failure at the cost of a hard daemon dependency. Worth deciding before implementation rather than after; the failure mode of getting it wrong is a user who thinks they filed fifty holds and filed nothing.

### D2 (decided): every mutation goes through the daemon

All mutating tools queue — `hold_by_sender`, `hold_messages`, `label_thread`, `draft_reply`, `unsubscribe_sender`, `restore_messages`, `undo_intent`. The MCP server becomes write-only-to-the-queue and stops mutating mail entirely. The daemon is the sole IMAP mutator.

**What this genuinely buys**, and it is more than a first pass suggests: MCP server instances multiply. Claude Desktop, Claude Code and a CLI invocation are three processes, each with its own connection pool, each today mutating the same account independently. Routing mutations through the daemon means every write goes through exactly one pool with one per-account serialization queue, no matter how many clients are attached. That is a real reduction in contention on the write path, and it matches how approved gated intents already execute.

**What it does not buy**, and the design should not pretend otherwise: this is not "one IMAP consumer per account". The MCP server still opens IMAP for *reads* whenever the cache is `off`, stale, or lacks coverage for the requested mailbox — the default today. Reads and writes will still contend. The win is on the write path and on collapsing N clients to one writer, not on eliminating the second consumer outright.

That gap closes on its own as the cache reaches `mode: on` with real coverage, at which point reads stop touching IMAP and the daemon genuinely becomes the only consumer.

#### D2a: small mutations wait briefly, so they still feel synchronous

Making a one-message `label_thread` fire-and-forget would be a real regression — the agent would have to poll for every trivial action.

So: everything queues, but for tools flagged as quick (`label_thread`, `draft_reply`, `unsubscribe_sender`) the MCP server polls the ledger for a short window (~10s) and returns the terminal result if it lands in time. Past that window it returns the `intent_id` and the caller polls, exactly like a bulk hold.

The queue stays the single execution path — the wait is only in how the *response* is shaped. Bulk holds (`hold_by_sender`, `hold_messages`) never wait; they return an id immediately as they do now.

Cost: a polling path in the MCP server, and up to ~10s of added latency on a small write when the daemon is busy with a sweep. Acceptable, and visible in `get_diagnostics` when it happens.

## Architecture

**The ledger is the queue.** No new store, no new table for the work itself. A new `queued` status and a few claim columns on `intents`.

```
MCP server                    ledger (SQLite, WAL)             daemon
-----------                   --------------------             ------
background: true
  └─ createIntent ──────────►  status = 'queued'
     return intent_id                  │
                                       │  ◄── claim (CAS: queued → executing)
                                       │      claimed_by, lease_expires_at
                                       │
                                       │  ◄── heartbeat (extend lease)
                                       │  ◄── progress (existing column)
                                       │
                                       ▼
                                 executed | failed
get_intent ◄──────────────────  status + progress + queue_position
```

The MCP server never executes queued work and never claims. It writes a row and returns — immediately for bulk holds, or after a short wait for quick mutations (D2a).

## Schema

```sql
-- status gains 'queued'
CHECK (status IN ('pending','queued','approved','executing','executed','rejected','failed','undone'))

ALTER TABLE intents ADD COLUMN claimed_by        TEXT;      -- worker identity
ALTER TABLE intents ADD COLUMN claimed_at        DATETIME;
ALTER TABLE intents ADD COLUMN lease_expires_at  DATETIME;  -- heartbeat horizon
ALTER TABLE intents ADD COLUMN attempts          INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_intents_queued ON intents(status, created_at)
  WHERE status IN ('queued','executing');
```

Also needed, and independently valuable:

```sql
ALTER TABLE intent_targets ADD COLUMN uidvalidity INTEGER;
```

See "At-least-once and UID safety" for why.

## Claim protocol

A single atomic statement, relying on the `status = 'queued'` guard for the compare-and-swap:

```sql
UPDATE intents
   SET status = 'executing',
       claimed_by = :worker,
       claimed_at = CURRENT_TIMESTAMP,
       lease_expires_at = :now_plus_lease,
       attempts = attempts + 1
 WHERE id = (
   SELECT id FROM intents
    WHERE status = 'queued'
      AND account_id NOT IN (:accounts_already_claimed_by_me)
    ORDER BY created_at
    LIMIT 1
 )
   AND status = 'queued'
RETURNING *;
```

`RETURNING` needs SQLite ≥ 3.35; the pinned Node 24 ships 3.51.

Properties this buys:

- **Safe against a second worker.** The `AND status = 'queued'` guard means a losing claimer updates zero rows and simply tries again. Correct even if someone runs a second daemon by mistake.
- **FIFO within an account**, and **accounts progress independently** — the worker holds at most one claim per account at a time, matching the connection pool's per-account serialization. A slow iCloud sweep no longer blocks a Gmail job.
- **Attempts are counted at claim time,** so a job that crashes the worker still increments and cannot loop forever.

### Lease and reclaim

The worker extends `lease_expires_at` on a heartbeat (say every 30s, lease 2 minutes). A reclaim pass returns expired-lease `executing` intents to `queued`:

```sql
UPDATE intents SET status = 'queued', claimed_by = NULL, lease_expires_at = NULL
 WHERE status = 'executing' AND lease_expires_at < CURRENT_TIMESTAMP;
```

This replaces today's `checkStuckExecuting` warning with actual recovery. An intent that has burned `attempts >= 3` goes to `failed` with a structured `error_detail` rather than being requeued — otherwise a job that reliably kills the worker becomes an infinite restart loop.

Note the lease must outlive the pool's 5-minute operation timeout, or a legitimately slow sweep gets reclaimed underneath itself. Lease ≥ `operationTimeoutMs` + margin, asserted at startup.

## At-least-once, and why UIDVALIDITY matters

A durable queue is at-least-once, not exactly-once. A worker that dies after the IMAP move but before writing `executed` will have its lease reclaimed and the job re-run.

For `hold_by_sender` that is safe — it moves whatever currently matches, so a re-run finds the remainder or nothing.

For `hold_messages` it is **not obviously safe**: it moves explicit UIDs, and UIDs are only meaningful within a `(mailbox, UIDVALIDITY)` generation. If UIDVALIDITY changed between the original attempt and the replay, those UIDs may now identify entirely different messages, and the replay would move mail the user never selected.

This is latent today (the same hazard exists for `undo_intent` and `restore_messages` replaying recorded UIDs), but a durable queue makes replay routine rather than exceptional. So: record `uidvalidity` on each target at capture time, and refuse to act on a target whose recorded generation no longer matches the mailbox. That check belongs in the executor regardless of this work.

## What changes for callers

- **The cap goes away.** A durable queue can be arbitrarily deep, so the 8-job limit and `BackgroundQueueFullError` are removed. Fire all 50. A much higher sanity bound stays to catch runaway loops.
- **`get_intent` gains `queue_position`** for `queued` intents, so "not started yet" is legible.
- **`get_diagnostics` gains a `worker` block**: daemon alive or not, last heartbeat, current claims, queue depth, oldest queued age. If the daemon is down, that is the headline.
- **A new terminal-ish state to explain.** `queued` is a status agents will now see; tool descriptions and the README need it.

## Failure modes

| Situation | Behavior |
|---|---|
| Daemon not running | Work queues; response, `get_intent`, and `status` all say it will not run until the daemon starts (D1) |
| Daemon dies mid-job | Lease expires; job returns to `queued`; another pass re-runs it |
| Job repeatedly kills the worker | `attempts >= 3` → `failed` with detail; not requeued |
| Two daemons running | CAS makes the loser a no-op; only one claims each intent |
| UIDVALIDITY changed before replay | Target refused, intent fails with a clear reason rather than moving the wrong mail |
| Ledger locked by another process | Existing `busy_timeout` applies; claim retries next tick |
| Quick mutation exceeds its short wait | Returns `intent_id` and `status: queued`; caller polls. Not an error |
| Daemon down under D2 | *Every* mutation queues and idles. Liveness is surfaced as an error on startup, in each response, and in `status` |
| Queue grows unboundedly | Sanity bound + `oldest_queued_age` surfaced in diagnostics |

## Testing

The failure modes above are the test list. Specifically worth pinning:

- Two concurrent claimers, one intent → exactly one claim.
- Worker killed mid-job → lease expiry requeues → second run completes.
- Attempts exhausted → `failed`, not requeued.
- Lease shorter than operation timeout → startup assertion fires (guards a misconfiguration that would silently duplicate work).
- Daemon down → queued, warned, and *not* executed by the MCP server.
- Replay after UIDVALIDITY change → refused.

The claim CAS should be tested against a real SQLite file with two connections, not a mock. The lesson from PR #12 is that a fake diverging from the real thing hides exactly this class of bug.

## Phases

| Phase | Contents |
|---|---|
| 1 | `queued` status, claim/lease/heartbeat, daemon worker, reclaim, remove the cap. Bulk holds only, so the mechanism is proven on the tools that already return an id. |
| 2 | `uidvalidity` on targets + generation check on replay |
| 3 | Route the remaining mutations through the queue, plus the short-wait path for quick tools (D2a) |
| 4 | `queue_position`, `worker` block in diagnostics, README and tool-description updates |

Phase 1 stops short of moving every mutation on purpose. The claim protocol, lease recovery and daemon-down handling all want proving on `hold_by_sender` — where an async response is already the contract — before `label_thread` depends on them. Same posture as shadow mode for the cache: get the mechanism trustworthy on the low-stakes path first.

Phase 2 is separable and worth doing even if the queue is deferred.

## Open questions

1. **Cancellation.** Should a `queued` intent be cancellable before it runs? Cheap to add (`queued` → `rejected` via the same CAS) and probably worth it, but it is a new verb on the tool surface.
2. **Ordering across accounts.** FIFO by `created_at` globally, with one claim per account. If one account has 40 queued jobs, another account's newer job still starts promptly — but within an account it is strictly first-come. Adequate; noting it in case priority is ever wanted.
3. **Does the reviewer's approve path join the queue?** Approved gated intents currently execute inline in the daemon. They could become `queued` for uniformity, at the cost of approval no longer being visibly immediate. Leaning no for now.
