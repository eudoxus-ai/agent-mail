# Deferred Work

Goals split off from the 2026-06-08 "level up the MCP server" intake (Claude inbox-cleanup
feedback). First goal chosen: **Reliability / async scans (#1)**. The items below are
deferred, not dropped. Each is independently shippable. Evidence references are from the
2026-06-08 capability audit.

## Precision & economy bundle (feedback #2, #3, #4, #8)
- **Unread filter** — expose `unread_only` on `search_threads` (IMAP already supports `unseen`,
  `imap.ts:172,219`; just not in the tool schema). Split read/unread counts in `list_senders`
  (currently combined, `executor.ts:733`).
- **`search_threads` discoverability (#3)** — the flat, date-bounded, paginated,
  subjects-via-`fields` primitive already exists; the agent never found it. Sharpen the tool
  description so it's the obvious choice for "list messages between X and Y."
- **Symmetric `since` on `hold_by_sender` (#4)** — currently `before`-only
  (`hold-by-sender.ts:12`). Trivial schema + executor addition.
- **`compact`/`fields` mode on `get_overview` (#8)** — today always returns full signals +
  participant list; add a lean projection.

## Batch hold_by_filter (feedback #5)
New tool: hold all messages matching a filter (e.g. `is_list_mail` + `has_unsubscribe`,
date-bounded) in one call. Collapses ~25 round-trips into one; also relieves the timeout
exposure behind #1. More valuable than a plural-array variant of `hold_by_sender`.

## Coarse category surfacing & filtering (feedback #6, cheap half)
A classifier (newsletter/promotional/transactional/notification/personal) already exists
(`category.ts`) and is wired into `search_threads` — surface it in `get_overview` output and
make it filterable. NOTE: `urgency_score` / `has_deadline_language` / `mentions_you_by_name`
are deliberately stubbed ("Reserved for Z (Apfel)", `signals.ts:24`) — leave to that owner.

## From async-scan-jobs review (2026-06-08) — conscious non-goals to revisit
- **Per-agent authorization on `get_scan_result`** — `scan_jobs.agent_id` is stored but not enforced;
  any agent session can poll any `job_id`. Deferred because this is a single-user local-first server
  (any agent can already read all mail directly) and enforcing could break a legitimate reconnect that
  polls with a different `agent_id`. Revisit if a true multi-tenant model is ever introduced.
- **Hard cancellation of a timed-out IMAP scan** — `withTimeout` returns control to the agent but does
  NOT abort the in-flight imapflow op, so a multi-mailbox/multi-account `get_overview` can keep its
  per-account connection until the (bounded) fetch drains. Future enhancement: thread an `AbortSignal`
  through `pool.withConnection` → `fetchEnvelopes` to free connections immediately on timeout.

## Persistent triage rules (feedback #7)
Allowlist/holdlist subsystem: enforced "never touch" set (Cori, client domains, financial/legal)
+ saved "always hold" senders. New ledger table + eval hook in the hold path. Largest new
build; strongest architectural fit (safety-as-architecture, an enforced guardrail rather than
re-reasoned each run).
