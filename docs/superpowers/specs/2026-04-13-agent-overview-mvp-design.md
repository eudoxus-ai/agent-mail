# Agent Overview MVP — Design

**Date:** 2026-04-13
**Status:** Approved, awaiting implementation plan
**Scope:** Fix IMAP foundation + add a fat "attention overview" primitive so general-browsing questions ("what do I need to be aware of this week") work well.

## Problem

agent-mail works acceptably for narrow questions ("find Alice's email about Q2 planning") but fails on broad questions ("look at my email and tell me what I need to be aware of this week"). Two concrete problems drive this:

1. **Ordering bug.** `ImapProvider.search()` iterates IMAP SEARCH results in UID-ascending (oldest-first) order and stops at `limit`. So `{query: "flagged", limit: 20}` returns the oldest 20 flagged messages ever, not the newest. This is a bug, not a feature.
2. **Connection overhead.** Every tool call opens a fresh IMAP connection (TLS handshake + AUTH + LIST + SELECT, ~1–3 seconds on Gmail/iCloud). Broad questions require many tool calls, so the agent pays this cost 5–10 times per question.

A third problem is structural: there's no high-level primitive for "what needs my attention." The agent has to stitch together many `search_threads` calls across accounts, each of which pays the connection cost and returns thin data.

## Context: Y (MVP) vs. Z (vision)

This project is the "Y" MVP of a longer arc toward a full "email client for AI agents" ("Z"). Z is a local-first mail mirror with markdown-on-disk storage (via something like [QMD](https://github.com/tobi/qmd)), IDLE-based push sync, and on-device LLM (Apple Foundation Models via [Apfel](https://github.com/Arthur-Ficial/apfel)) for hard attention signals.

Y is deliberately scoped to improvements that (a) make the immediate experience substantially better and (b) port to Z without being thrown away. No local storage, no LLM calls, no sync layer — those are Z.

## Scope

### In scope

1. Fix the ordering bug in `ImapProvider.search()`.
2. Connection pooling — one persistent `ImapFlow` per account, process-scoped, shared across tool calls.
3. Readable snippets via minimal MIME parsing of partial-source fetches.
4. `since` parameter on `search_threads`.
5. New tool: `get_overview` — one call, all accounts, rich attention-tagged view of recent mail.
6. Attention signal computation module (`src/attention/`) — cheap heuristics only, extensible schema.
7. Stable `Message-Id` surfaced in responses alongside UID + mailbox (back-compat preserved).

### Out of scope

- Local storage / mirror / sync (Z).
- Markdown-on-disk (Z).
- LLM-based attention signals — `has_deadline_language`, `mentions_you_by_name`, `urgency_score` (Z, via Apfel).
- Sender familiarity / cross-thread participant graph (Z — requires persistent state).
- Semantic search / embeddings (Z).
- IMAP IDLE / push (Z).
- Reviewer UI, intent ledger, policy engine changes.
- Multi-agent coordination, session memory.

## Architecture

### Module layout

```
src/
  provider/
    imap.ts              # MODIFIED: fix search ordering, add snippet extraction
    imap-pool.ts         # NEW: per-account connection pool, keepalive
    mime.ts              # NEW: partial-source snippet extraction
  attention/
    signals.ts           # NEW: compute MessageSignals (pure function)
  tools/
    search-threads.ts    # MODIFIED: add `since`, return Message-Id + signals
    read-thread.ts       # MODIFIED: return Message-Id
    get-overview.ts      # NEW: the fat primitive
  executor/
    executor.ts          # MODIFIED: borrow from pool instead of per-call connect
  server/
    # Wire-up changes to construct pool at startup, close at shutdown
```

### Boundaries

- **`attention/signals.ts` knows nothing about IMAP or tool wiring.** It takes an `EmailMessage` plus thread context, returns a `MessageSignals` object. Pure function. Z reuses it unchanged by feeding messages from the local store.
- **`provider/imap-pool.ts` knows nothing about tools or attention.** It manages `ImapProvider` instances and exposes `withConnection(accountId, fn)`.
- **`tools/get-overview.ts` is orchestration only.** It composes the pool, the IMAP provider, the attention module, and the existing threading module. No business logic lives here that couldn't be tested independently elsewhere.

## Component: Connection pool

New module `src/provider/imap-pool.ts`.

```ts
class ImapConnectionPool {
  constructor(deps: { accounts: AccountConfig[]; logger: Logger });
  async withConnection<T>(
    accountId: string,
    fn: (imap: ImapProvider) => Promise<T>
  ): Promise<T>;
  async closeAll(): Promise<void>;
}
```

### Behaviors

- **Lazy connect.** First `withConnection` for an account triggers connect + login. Subsequent calls reuse.
- **Keepalive.** Background `NOOP` every 60 seconds on each live connection.
- **Reconnect-once on drop.** If a `withConnection` call catches `ImapFlow` disconnect errors (`NoConnection`, socket close, unexpected `BYE`), the pool tears down the dead client, reconnects, retries the callback exactly once. Second failure propagates.
- **Per-account serialization.** `imapflow` is not safe for concurrent use on one connection. The pool maintains a per-account async queue so concurrent `withConnection` calls on the same account execute sequentially. Different accounts run in parallel.
- **Shutdown.** `closeAll()` waits for in-flight borrows (up to 5s), then logs out each live connection.

### Executor change

Every `new ImapProvider(); connect(); …; disconnect()` block in `executor.ts` becomes:

```ts
await pool.withConnection(accountId, async (imap) => { … });
```

`ImapProvider` itself is almost unchanged. The pool owns connect/disconnect; the provider owns the IMAP operations.

### Server wire-up

The MCP server initialization (currently stateless between calls) constructs the pool at startup, passes it to the executor, and registers a shutdown hook that calls `closeAll()`.

## Component: IMAP ordering fix

Current bug in `ImapProvider.search()`: streams `client.fetch(query)` in UID order, breaks at `limit`. Returns the oldest N.

### Fix

```
1. const uids = await client.search(query)           // returns all matching UIDs
2. if (uids.length === 0) return []                  // short-circuit (some servers reject empty fetch)
3. const tail = uids.slice(-limit)                   // newest N (UID order is chronological)
4. const results = await fetch(tail, { ... })        // hydrate envelopes/snippets
5. return results.sort((a, b) => b.date - a.date)    // descending date order
```

Two round trips instead of one, but the first is a tiny SEARCH (UIDs only) and the second fetches exactly N messages. Net cost is equivalent or better than current (which over-fetches streaming data until break). On Gmail with 50k flagged messages, the new path is dramatically faster.

### Breaking-change posture

This is a bug fix, not a versioned behavior change. No opt-in flag. Agents that happened to rely on the old (broken) behavior pick up the fix on next server restart.

## Component: Snippet extraction

New module `src/provider/mime.ts`.

```ts
// Extract a ~200 char preview from a (possibly partial) message source.
// Handles text/plain at root, multipart with text/plain first part,
// common encodings (7bit, 8bit, quoted-printable, base64), common charsets.
// Returns empty string on unrecognized structure — never throws.
export function extractSnippet(source: Buffer | string): string;
```

### Strategy (Option A from brainstorm — lean)

- Keep the existing `ImapFlow` partial-source fetch (`source: { start: 0, maxLength: 2048 }`).
- Parse headers from the partial source (we already do this for threading).
- Find the `Content-Type` and, for multipart, the first `text/plain` part boundary if it falls within the partial.
- Decode and strip quoted-reply tails (`^> `, `^On .* wrote:`) and signatures (`^-- $`).
- Return the first 200 chars of actual body text.
- On any parse failure, return `"(no preview available)"`. Signals still compute normally.

`read_thread` is out of scope for body-extraction changes in this project. Its current naive body extraction (`imap.ts` splits on blank line) stays as-is. This module only handles the partial-source snippet case used by `search_threads` and `get_overview`.

### Known weakness

HTML-only messages (no `text/plain` part) will produce empty snippets from the partial fetch, and `read_thread` on the same message will return empty or garbled body text. This is a Y limitation inherited from the existing code, not a regression. Z will pre-render snippets and bodies at ingest time and eliminate the issue.

## Component: Attention signals

New module `src/attention/signals.ts`.

### Type

```ts
interface Participant {
  address: string;    // lowercased, trimmed
  name: string | null;
}

interface MessageSignals {
  // ─── Recipient signals ───
  direct_to_me: boolean;
  cc_to_me: boolean;
  is_bulk: boolean;

  // ─── Sender signals ───
  is_list_mail: boolean;
  is_automated: boolean;

  // ─── Thread signals ───
  thread_state: 'new' | 'awaiting_you' | 'awaiting_them' | 'resolved';
  in_reply_to_your_message: boolean;
  is_reply_in_thread_you_started: boolean;

  // ─── Network signals ───
  thread_participants: Participant[];
  thread_participant_count: number;
  thread_message_count: number;
  is_small_group: boolean;
  is_broadcast: boolean;

  // ─── Reserved for Z (Apfel) — always null in this MVP ───
  has_deadline_language: boolean | null;
  mentions_you_by_name: boolean | null;
  urgency_score: number | null;
}
```

The three `null` fields are the extensibility hook. Y computes them as `null`; Z fills them in at ingest time. The tool response shape never changes.

### Signature

```ts
export function computeSignals(
  msg: EmailMessage,
  context: {
    accountEmail: string;
    threadMessages: EmailMessage[];  // ordered oldest → newest, may be empty
  }
): MessageSignals;
```

Pure function. No I/O. Fully unit-testable via fixtures.

### Signal derivations

| Signal | Source |
|---|---|
| `direct_to_me`, `cc_to_me`, `is_bulk` | Envelope `to`/`cc`/`bcc` vs. `accountEmail` |
| `is_list_mail` | Presence of `List-Id` or `List-Unsubscribe` header |
| `is_automated` | Regex on sender address (`noreply@`, `no-reply@`, `notifications@`, `mailer-daemon@`, etc.) |
| `thread_state` | Direction of last message in `threadMessages`, relative to `accountEmail`; overridden to `'new'` if `is_list_mail` or `is_automated` |
| `in_reply_to_your_message` | Current message's `In-Reply-To` header matches a prior thread message authored by `accountEmail` |
| `is_reply_in_thread_you_started` | First message in `threadMessages` was authored by `accountEmail` |
| `thread_participants` | Union of `from`/`to`/`cc` across all `threadMessages`, normalized to lowercase, ordered by first appearance |
| `thread_participant_count` | `thread_participants.length` |
| `thread_message_count` | `threadMessages.length` |
| `is_small_group` | `thread_participant_count <= 4` |
| `is_broadcast` | Current message has `>= 10` recipients in `to`+`cc` |

### Notification heuristic nuance

GitHub-style notifications aren't "awaiting you" in the reply sense even if you've never responded. The rule:

```ts
if (is_list_mail || is_automated) thread_state = 'new';
```

Applied regardless of direction analysis.

### What's deferred to Z

- **Sender familiarity** (needs persistent state — scan of Sent + incremental tracking).
- **Cross-thread participant graph** ("Alice and Bob are on 40% of your important threads").
- **LLM-derived signals** (deadline language, named mentions, urgency scoring) — these need Apfel, which lives in Z.
- **Plus-addressing / alias handling** — MVP supports primary account email only.
- **Cross-mailbox thread reconstruction** — MVP does single-mailbox threading. Sent-folder replies may cause wrong `thread_state`. Documented limitation.

## Component: `get_overview` tool

New tool at `src/tools/get-overview.ts`.

### Input schema

```ts
z.object({
  accounts: z.array(z.string()).optional()
    .describe('Account IDs to include. Omit for all accounts.'),
  since: z.string().optional()
    .describe('ISO8601 datetime. Defaults to 7 days ago.'),
  mailboxes: z.array(z.string()).optional()
    .describe('Mailboxes to scan per account. Defaults to [INBOX].'),
  include: z.array(z.enum(['unread', 'flagged', 'recent_direct', 'awaiting_you']))
    .optional()
    .describe('Which candidate sets to include. Defaults to all four.'),
  limit_per_category: z.number().optional()
    .describe('Max threads per category per account. Default 25.'),
})
```

### Candidate sets

| Name | IMAP query | What it catches |
|---|---|---|
| `unread` | `UNSEEN SINCE <date>` | Fresh inbound you haven't looked at |
| `flagged` | `FLAGGED` (no date — flags persist) | Things you explicitly marked |
| `recent_direct` | `SINCE <date>` + post-filter `direct_to_me` | Mail addressed specifically to you |
| `awaiting_you` | `SINCE <date> UNANSWERED` + post-filter `thread_state === 'awaiting_you'` | Threads where you owe a reply |

Categories intentionally overlap. Response dedupes by thread and tags each thread with every category it matched.

### Response shape

```ts
{
  generated_at: string,                 // ISO8601
  window: { since: string, until: string },
  accounts: Array<{
    account_id: string,
    email: string,
    error: string | null,                // per-account failure isolation
    threads: Array<{
      thread_id: string,                 // hash of root Message-Id (stable)
      account_id: string,
      mailbox: string,
      categories: Array<'unread' | 'flagged' | 'recent_direct' | 'awaiting_you'>,
      latest_message: {
        message_id: string,
        uid: number,
        from: Participant,
        to: Participant[],
        cc: Participant[],
        date: string,
        subject: string,
        snippet: string,
        flags: string[],
      },
      thread: {
        message_count: number,
        first_date: string,
        latest_date: string,
        truncated: boolean,              // true if we only fetched the tail
      },
      signals: MessageSignals,
    }>,
  }>,
  summary: {
    total_threads: number,
    by_category: Record<string, number>,
    by_account: Record<string, number>,
  },
}
```

### Rationale

- **Thread-first.** The atomic unit is a thread. Each conversation appears once, even if three of its messages hit the categories.
- **`latest_message` is the action target.** When the agent wants to draft a reply, quarantine, or read the thread, it uses `latest_message.uid`. Full thread history only arrives via a follow-up `read_thread` call.
- **`thread_id` is a hash of the root `Message-Id`.** Stable across UID changes, portable. Introduces stable addressing without breaking UID back-compat.
- **Per-account error isolation.** Failed accounts return `error` + empty `threads`. Others still succeed.
- **Inline `summary`** saves the agent from counting.

### Execution plan

```
1. Resolve `accounts` list (default: all configured)
2. For each account, IN PARALLEL (Promise.allSettled):
   a. pool.withConnection(accountId, async imap => {
      i.   For each mailbox in `mailboxes`:
           - Run the (subset of) 4 IMAP searches, each returning UIDs
           - Union the UID sets, tracking which categories each UID hit
      ii.  Fetch envelopes + partial source for union UIDs (one fetch call)
      iii. Group into threads via In-Reply-To/References chasing;
           fetch additional thread-context messages as needed.
           Truncate long threads at 5 tail messages (thread.truncated = true).
      iv.  Compute signals per thread
      v.   Return { account_id, email, threads }
   })
3. Merge account bundles, setting error: null on success,
   error: errorMessage on rejection
4. Build summary
```

Inside an account, operations are serialized by the pool. Across accounts, they run in parallel.

### What `get_overview` does not do

- **No summarization.** Returns structured data; the LLM writes prose.
- **No ranking / scoring.** Agent sorts and filters based on signals.
- **No action suggestions.** Signals are raw data; the agent decides.
- **No pagination / streaming.** Snapshot only, bounded by `limit_per_category`.

## Error handling

### Pool

- **First-borrow connect fails:** propagate to caller. Pool stays disconnected for that account; next borrow retries.
- **Connection drops mid-operation:** catch disconnect error, tear down, reconnect, retry callback once. Second failure propagates. No retry loops.
- **Keepalive `NOOP` fails:** mark connection dead silently. Next borrow reconnects.
- **Shutdown mid-borrow:** `closeAll()` waits up to 5s for in-flight operations before logging out.

### `get_overview` partial failure

One account's failure cannot fail the whole call. `Promise.allSettled` over accounts; rejected accounts appear in the response with `error: <message>` and `threads: []`. Agents can surface "your work account is unreachable" while still showing the rest of the overview.

### Thread reconstruction

- **Orphan message** (no threading headers) → thread of 1.
- **Broken `References` chain** → use what's reconstructable; `truncated` stays false (we got everything available).
- **Cycles in headers** → cap thread walking at 50 messages.
- **Cross-mailbox threads** → single-mailbox reconstruction only. Replies sent from another client may cause wrong `thread_state`. Documented limitation.

### Signals

- **No `to:` at all** → `direct_to_me: false`, `is_bulk: true`.
- **Automated sender false positives** → accepted. Signal is a hint, not a verdict.
- **Multiple account aliases** → MVP checks primary email only.

### Snippets

- **Partial fetch has no body** → `"(no preview available)"`.
- **Unknown charset** → utf-8 → latin-1 → empty. Never throws.
- **HTML-only** → empty snippet in MVP.

### Time windows

- **`since` in the future** → empty result, no error.
- **`since` very old** → honored; bounded by `limit_per_category`.
- **Clock drift** → all date comparisons use IMAP server timestamps, not client clock.

### Empty search short-circuit

The ordering fix must handle `search()` returning zero UIDs cleanly — short-circuit to `return []` before any fetch call, since some servers reject empty fetch sets.

### What is not handled

- **Credential revocation mid-session.** Auth failures propagate; user restarts the server after fixing.
- **Mailbox renames.** Out of scope.
- **Provider rate limiting.** With one persistent connection per account and no polling, we're far from limits. If hit, errors propagate with no automatic backoff.

## Testing

### Unit tests

**`src/attention/signals.test.ts`**

Pure-function, fixture-driven. Fixtures cover:

- Direct / cc / bulk / bcc recipient shapes
- `List-Id` / `List-Unsubscribe` / neither
- `noreply@` / normal human sender
- Thread with last message from you, last from them, no thread
- Threads with 1, 3, 10, 50 participants
- Broken `References` chain
- Reply-in-thread-you-started
- Notification heuristic: automated + last-message-theirs → `thread_state: 'new'`, not `'awaiting_you'`

Table-driven with `test.each` where possible.

**`src/provider/mime.test.ts`**

Fixture-driven snippet extraction:

- Plain text at root
- Multipart text+html (prefer text)
- HTML-only (empty snippet OK, must not throw)
- Quoted-printable encoding
- Charset declaration
- Truncated partial fetch (headers + 100 bytes)

Asserts extracted text, not byte equality.

### Mocked-integration tests

**`src/provider/imap-pool.test.ts`** (matches existing imapflow mocking pattern)

- First borrow connects; second borrow reuses
- Connection drop → reconnect → retry once; second failure propagates
- Two concurrent borrows on same account execute sequentially
- Parallel borrows on different accounts execute concurrently
- `closeAll()` waits for in-flight borrows then logs out

**`src/tools/get-overview.test.ts`**

- 2 accounts, mixed categories, shared-between-category threads → correct dedup and category tagging
- Account failure → that account has `error`, other account still returns
- Long thread (50 messages) → `truncated: true`, signals still compute
- Cross-mailbox thread → asserts documented (wrong) behavior so a future fix breaks the test and we notice

**`src/provider/imap.test.ts`** (amended)

- Ordering fix: search with more matches than `limit` returns newest N in descending date order
- Empty search result short-circuits without empty fetch call
- Partial-source snippet happy path

### Fixtures

New directory `test/fixtures/mail/` with `.eml` files for:

- Typical human-to-human email
- GitHub notification
- Mailing-list post
- Marketing email with `List-Unsubscribe`
- Multipart text+html
- Long thread (50 messages, script-generated, committed)

Loaded into `EmailMessage` shape by a test helper, reused across all test files.

### Not tested

- Live IMAP integration (flaky, slow, coupled to the user's real inbox).
- Real 60-second keepalive timing (test the scheduler and handler in isolation).
- Full MIME long tail (delegated to whichever parser library we rely on).

### Verification

Before claiming any slice complete:

```
npm run typecheck
npm test
```

Both green = done. No verbal confirmations without output.

## Known limitations (documented, fixed in Z)

1. **Cross-mailbox thread reconstruction.** Single-mailbox only. Replies from another client may cause wrong `thread_state`.
2. **Plus-addressing / aliases.** Primary email only.
3. **HTML-only message bodies.** Snippets are empty and `read_thread` returns empty/garbled text (inherited from existing `extractBodyText`). Not regressed in Y; fixed in Z.
4. **Sender familiarity.** Not computed in Y. The field doesn't exist in the schema until Z adds it.
5. **Cross-thread participant graph.** Per-thread participants only in Y.
6. **IDLE / push.** Overview is always on-demand, never pushed.

## Migration / back-compat

- `search_threads` ordering change: treated as bug fix, not versioned.
- `search_threads` and `read_thread` gain `message_id` in responses. Additive; doesn't break existing callers.
- No changes to the intent ledger schema, policy engine, or reviewer UI.

## Relationship to Z

Every component in this project ports to Z either unchanged or as a drop-in replacement:

| Y component | Z disposition |
|---|---|
| `attention/signals.ts` | Unchanged; fed from local store instead of IMAP |
| `MessageSignals` schema | Extended in place (reserved `null` fields fill in) |
| `get_overview` tool surface | Unchanged; data source becomes local store |
| `tools/search-threads.ts` with `since` and `message_id` | Unchanged; backend swapped |
| `provider/imap-pool.ts` | Retired (local store doesn't need it) |
| `provider/mime.ts` (partial snippets) | Retired (Z pre-renders snippets at ingest) |
| `provider/imap.ts` ordering fix | Retired (local store uses SQL/QMD ordering) |

The pool and partial-snippet code is the only work that gets thrown away, and both are small. Everything else is forward-compatible with the Z architecture (markdown + QMD + Apfel).
