# Multi-account triage safety

## Background

Agent-mail's read and destructive tools currently default to a single account and return no signal that other accounts exist. An agent asked to "clean out my inbox" can silently process 80 messages from one account while a second account with 100+ unread sits untouched. Every triage decision is made on an unacknowledged subset of the user's mail.

Two related correctness problems compound this:

- `quarantine_thread` accepts bare `uids`. UIDs are IMAP-scoped per mailbox per account, so a batch built from results that came from multiple accounts could hit the wrong inbox.
- The destructive response is `"Moved 16 message(s)"` — a thread-level tool reporting at the message level with no breakdown. The agent (and user) cannot see how thread expansion turned the call into actual moves.

This spec fixes the silent-failure class of bugs in agent-mail's read and destructive surface. Bulk-classification ergonomics (a `list_threads` primitive, header exposure, `is_automated` filtering, lean projections) are deferred to a follow-up spec.

## Goals

1. Cross-account by default. Every read/list tool fans out to all configured accounts unless the caller scopes down.
2. Account-qualified message references. Tools that act on specific messages take `{account_id, uid, mailbox?}` tuples, not bare uids.
3. Destructive-action preview. `quarantine_thread` gains `dry_run` and a structured blast-radius report.

## Non-goals

- New bulk-classification primitive (`list_threads`).
- Header exposure in snippets (`List-Unsubscribe`, `List-Id`).
- Filtering by `is_automated` / `has_list_unsubscribe`.
- `from` substring matching.
- Lean projections / `fields` parameter on `get_overview`.

These are tracked for a follow-up spec.

## Cross-account semantics

### Scoping parameter

The existing `account_id?: string` parameter is removed from all tools. It is replaced with `account_ids?: string[]`:

- Omitted → fan out to all configured accounts.
- `[]` → reject as a programming error (use omit to mean "all").
- `["a@x.com"]` → single-account scope.
- `["a@x.com", "b@y.com"]` → two-account scope.

Pre-1.0, this is a one-way break. The README and CLI examples will be updated.

### Response envelope

Every multi-account-capable tool returns its payload inside this envelope:

```json
{
  "accounts_searched": ["a@x.com", "b@y.com"],
  "accounts_available": ["a@x.com", "b@y.com"],
  "per_account_errors": { "b@y.com": "auth failed" },
  "results": [ /* tool-specific payload */ ]
}
```

- `accounts_searched`: accounts the call actually touched.
- `accounts_available`: all accounts the server knows about. Lets the agent notice when a scoped call covers a slice.
- `per_account_errors`: present only when at least one account failed. Maps `account_id` → error message. The call as a whole still succeeds with partial results.
- `results`: tool-specific payload (search hits, overview, audit rows, etc.).

### Pagination

`limit` applies per account, then results are merged, globally re-sorted (newest-first for search/overview), and truncated to `limit`. This rules out one chatty account drowning out the others.

### Tools affected (read/list)

- `search_threads`
- `get_overview`
- `get_audit_log`
- `get_pending_actions`

## Account-qualified message references

### Target shape

Tools that act on specific messages take a `targets` array:

```json
{
  "targets": [
    { "account_id": "a@x.com", "uid": 1234, "mailbox": "INBOX" },
    { "account_id": "b@y.com", "uid": 5678 }
  ]
}
```

`mailbox` defaults to `INBOX` per target. Each target is independent — no cross-target inference of `account_id` or `mailbox`.

### Search results carry the same shape

Every result in `search_threads` and `get_overview` includes top-level `account_id`, `mailbox`, and `uid` so the agent can pass results back into destructive tools verbatim. No re-keying step where the account can be lost.

### Tools affected (per-message)

- `quarantine_thread`: `uids` → `targets`.
- `label_thread`: `uids` → `targets`.
- `read_thread`: `{uid, account_id?}` → `target: {account_id, uid, mailbox?}` (single target — returns one message body).

### Validation

Reject any target whose `account_id` is not in the configured accounts list with a clear error. Do not silently skip.

## Dry-run and blast-radius reporting (`quarantine_thread`)

### Parameter

`dry_run: boolean` (default `false`).

### Response shape (always structured, dry-run and real run identical)

```json
{
  "accounts_searched": ["a@x.com", "b@y.com"],
  "accounts_available": ["a@x.com", "b@y.com"],
  "per_account_errors": {},
  "dry_run": true,
  "total_messages": 47,
  "total_threads": 12,
  "per_account": [
    {
      "account_id": "b@y.com",
      "mailbox": "INBOX",
      "thread_count": 8,
      "message_count": 31,
      "threads": [
        {
          "thread_id": "...",
          "subject": "...",
          "message_count": 4,
          "uids": [1234, 1235, 1236, 1237]
        }
      ]
    }
  ]
}
```

### Dry-run semantics

Skips the IMAP `MOVE`. Still resolves targets — opens the mailbox, expands threads to UIDs, computes the report. The agent gets the same `total_messages` it would see on a real run, so previewing is faithful.

### Thread expansion is explicit

If a target is the root of a 4-message thread, the report shows `message_count: 4` and lists all 4 uids. No more "I passed 16 uids and 16 got moved but 47 messages vanished."

### No confirm-token

Dry-run is advisory; the agent decides whether to run for real. Quarantine's 30-day reversibility is the real safety net. A confirm-token flow is reserved for irreversible actions like `queue_send`.

### Audit log

Dry-runs are logged as intent records with `dry_run: true`. They do not enter the undo ledger.

## Architecture

### Schema layer (`src/tools/*.ts`)

Update zod schemas:

- Replace `account_id?: string` with `account_ids?: string[]` on `search_threads`, `get_overview`, `get_audit_log`, `get_pending_actions`.
- Replace `uids: number[]` with `targets: Target[]` on `quarantine_thread`, `label_thread`.
- Replace `{uid, account_id?}` with `target: Target` on `read_thread`.
- Add `dry_run?: boolean` on `quarantine_thread`.

`Target` is a shared zod schema: `{ account_id: string; uid: number; mailbox?: string }`.

### Executor (`src/executor/executor.ts`)

Today the executor takes a single `intent.account_id` and runs one IMAP block. Changes:

- Add a `fanOut(accountIds, fn)` helper that runs `fn(account, imap)` per account in parallel via the existing pool, catches per-account errors into the `per_account_errors` map, and returns merged results.
- For target-based tools, group `intent.params.targets` by `account_id` first, then fan out per group.
- Wrap each tool's payload in the standard envelope (`accounts_searched`, `accounts_available`, `per_account_errors`).

### Pool (`src/provider/imap-pool.ts`)

No structural change — already keyed by account. Verify it handles parallel `withConnection` calls per account during fan-out (it almost certainly does; add a test).

### Policy engine

If `policy.yaml` gates by `account_id`, gating now considers all touched accounts. A multi-account call where any one account is gated causes the whole call to gate. Confirm during planning that this is the desired behavior.

### Audit ledger

One intent record per call (not per account). Intent records the `account_ids` list and per-account outcomes in the result blob. One user-intended action = one row.

### Tests

- Integration tests use a second account fixture.
- Unit tests for the fan-out helper: partial failure, all-fail, single-account scoping, empty-results merging.
- Dry-run tests verify no IMAP `MOVE` is issued and that thread expansion in the report matches what a real run would produce.

## Migration

Pre-1.0. Breaking changes are accepted. Update README tool-shape examples and any CLI install instructions that show `account_id`. No data migration required.
