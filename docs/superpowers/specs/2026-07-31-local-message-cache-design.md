# Local Message Cache & Index — Design

**Date:** 2026-07-31
**Status:** Proposed, awaiting review
**Scope:** Replace on-demand IMAP reads with a locally synced, full-text-indexed SQLite mirror of mail, so search and browse are local-disk fast instead of network-round-trip slow.

## Problem

agent-mail reads mail over IMAP on every tool call. IMAP has no aggregate operations, so every broad question costs a fan-out of round trips:

- `search_threads` issues an IMAP SEARCH per account, per call.
- `include_snippets` defaults to `false` because each snippet costs **one additional IMAP fetch per result** — the tool description says so outright.
- `get_overview` runs four candidate-set searches × N accounts, then hydrates envelopes for each.

The connection pool (`src/provider/imap-pool.ts`) removed the per-call TLS+AUTH handshake, which was the biggest single win available without local storage. What remains is structural: latency is proportional to how much mail the agent wants to consider, so the agent is trained — by cost — to look at as little as possible. Broad questions ("what did Alice and I decide about pricing", "what's still unanswered from June") are either slow or unanswerable.

Secondary problems that all have the same root cause:

- **No body search.** IMAP `SEARCH BODY` is server-dependent, slow, and unrankable. There is no BM25, no relevance ordering, no snippet-around-match.
- **Threading is per-query.** `buildThreads()` unions only the messages a single search returned, so a reply sitting in Sent doesn't join the thread. This is documented limitation #1 in the April design.
- **No persistent state to derive signals from.** Sender familiarity, participant graphs, and "you usually reply to this person within a day" all need history that IMAP-on-demand can't provide (deferred items in the April design).

## Context: Y → Z

The April design (`2026-04-13-agent-overview-mvp-design.md`) framed the project as **Y** (the IMAP-bound MVP, now shipped) and **Z** (a local-first mail mirror). It deliberately deferred all local storage to Z, and §"Relationship to Z" pre-computed the migration:

| Y component | Z disposition |
|---|---|
| `attention/signals.ts` | Unchanged; fed from local store |
| `MessageSignals` schema | Extended in place |
| `get_overview` / `search_threads` tool surfaces | Unchanged; backend swapped |
| `provider/imap-pool.ts` | Retired |
| `provider/mime.ts` partial snippets | Retired |
| `provider/imap.ts` ordering fix | Retired |

**This document is Z's storage layer.** The tool surfaces do not change. This is a backend swap behind stable contracts, which is why the April work ports rather than gets thrown away.

### What changed since April

The April sketch of Z was "markdown-on-disk storage (via something like QMD), IDLE-based push sync, and on-device LLM via Apfel." Research in July revises one of those three:

1. **QMD is healthy and more capable than assumed** (v2.5.3, hybrid BM25 + `sqlite-vec` + local reranking, incremental update, MCP server, `@tobilu/qmd` library API). The bet was not wrong.
2. **But QMD is a document search engine, not a mail store.** It chunks at ~900 tokens with overlap, models collections as file globs, and has no first-class structured filtering. Mail needs `from`/`to`/date-range/mailbox/flag predicates, stable thread membership, and mutable per-message state that reconciles against a server. Markdown-on-disk as the *canonical* format buys nothing here and costs the ability to query.
3. **The pattern QMD uses internally is the one to adopt directly:** SQLite as the local cache, FTS5 for lexical, `sqlite-vec` for vectors, RRF to fuse. This is the converged 2026 shape for local agent-queryable corpora.
4. **FTS5 is already available.** The literature warns that `node:sqlite` ships without FTS5, which would have forced `better-sqlite3` and a native build — precisely what `src/ledger/sqlite.ts` exists to avoid. Verified locally on Node 22.22.2 (SQLite 3.51.2): `CREATE VIRTUAL TABLE … USING fts5(…)` succeeds, and `loadExtension`/`enableLoadExtension` are present. **No new dependency is required for phase 1.**
5. **Incremental sync is a solved protocol problem.** RFC 7162 (CONDSTORE/QRESYNC) returns "everything that changed since HIGHESTMODSEQ" in a single round trip, with UIDVALIDITY as the cache-invalidation signal. `imapflow` — already a dependency — negotiates CONDSTORE, QRESYNC, and IDLE automatically.
6. **JMAP is not worth targeting.** Better protocol, real momentum, but the implementations are Fastmail/Cyrus/Stalwart/James. Gmail and iCloud — the two providers named in the README — don't speak it. IMAP stays the substrate.

**Net change from the April sketch: SQLite becomes canonical instead of markdown-on-disk.** Markdown is demoted to an optional export view. Everything else in Z's plan survives.

## Decisions

Two decisions were made before this design and constrain everything below.

### D1: Full body storage — text and HTML, attachment metadata only

Bodies are cached in full so that search covers message content and `read_thread` never touches the network. Attachment *payloads* are not cached by default; attachment *metadata* (filename, MIME type, size, part ID) is, and payloads are fetched on demand through the existing IMAP path.

Rationale is sizing. Attachment payloads dominate mailbox bytes and are rarely the search target:

| What's stored | ~50k messages |
|---|---|
| Envelopes + flags + snippets only | ~50 MB |
| **+ body text and HTML (gzipped)** | **~300–400 MB** |
| + attachment payloads | 3–5 GB |

Configurable per account via `cache.attachments: none | metadata | full`. Default `metadata`.

### D2: Read-path-only cache

**The cache is never authoritative for a write.** Every mutation — hold, restore, label, flag, send — continues to execute IMAP-first through `Executor.performAction`, unchanged. The cache is a derived, disposable artifact: deleting `cache.db` loses nothing and triggers a re-backfill.

After a successful mutation the executor calls into `cache/invalidate.ts`, which does two things:

1. **Applies the known delta locally** (optimistic echo) — e.g. a held message's `mailbox` column flips to `agent-mail-holding` immediately. This exists purely so an agent that holds 20 messages and then searches doesn't see them still in INBOX. It is explicitly non-authoritative and is overwritten by the next sync pass.
2. **Schedules a priority resync** of the affected `(account, mailbox)` pairs, ahead of the normal tick.

The invariant to hold in review: **no code path reads a value from the cache and writes it to IMAP.** Targets for mutations continue to carry `(account_id, mailbox, uid)` explicitly, and the executor re-validates against the server as it does today.

This preserves the property the README leads with — the intent ledger is the record of what happened — and keeps the cache in a category where corruption is an annoyance, not a safety issue.

## Scope

### In scope

1. `cache.db` — a second SQLite database, separate from `ledger.db`, with schema + migrations.
2. Ingest: `EmailMessage` → cache rows + FTS index.
3. Sync engine: mailbox discovery, newest-first resumable backfill, QRESYNC/CONDSTORE delta, UIDVALIDITY invalidation.
4. Query layer: cache-backed implementations of the reads behind `search_threads` and `get_overview`.
5. Global persistent threading (fixes documented limitation #1).
6. Post-mutation invalidation hooks.
7. Coverage/freshness reporting so the agent knows what the cache does and doesn't have.
8. Rollout control: `off | shadow | on`.

### Out of scope

- Embeddings / semantic search / `sqlite-vec` — phase 3, designed for but not built.
- IDLE push — phase 3. Sync is tick-driven plus on-demand until then.
- LLM-derived attention signals (Apfel) — unchanged from April, still deferred.
- OAuth migration. Real and time-sensitive (Gmail is phasing out app passwords; Microsoft's basic-auth deadline has passed), but orthogonal — it's an auth change, not a storage change. Tracked separately.
- Markdown export view.
- Any change to the intent ledger, policy engine, or reviewer UI.

## Architecture

### Module layout

```
src/
  cache/
    db.ts           # NEW: open cache.db, PRAGMAs, schema
    schema.ts       # NEW: DDL
    migrations.ts   # NEW: additive migrations, mirrors ledger/migrations.ts
    ingest.ts       # NEW: EmailMessage -> rows + FTS (pure, testable)
    sync.ts         # NEW: SyncEngine — backfill, delta, uidvalidity handling
    query.ts        # NEW: cache-backed search/overview reads
    coverage.ts     # NEW: what's cached, how fresh
    invalidate.ts   # NEW: post-mutation hooks
    threading.ts    # NEW: persistent union-find over message ids
  executor/
    executor.ts     # MODIFIED: route reads to cache, call invalidate after writes
  provider/
    imap.ts         # MODIFIED: add fetchRange/fetchBodies for bulk ingest
  cli/
    daemon.ts       # MODIFIED: run the sync engine
```

### Boundaries

- **`cache/ingest.ts` knows nothing about IMAP or SQL.** It takes an `EmailMessage` and returns row objects. Pure function, trivially testable, same posture as `attention/signals.ts`.
- **`cache/sync.ts` knows nothing about tools.** It owns `(uidvalidity, highestmodseq)` bookkeeping and drives `ImapProvider` through the existing pool.
- **`cache/query.ts` knows nothing about IMAP.** It reads SQLite and returns the same shapes `searchThreadsMulti` and `get-overview` already produce.
- **The executor stays the only thing that writes to IMAP.** The cache modules never mutate the server.

### Process model

Sync runs in the **daemon** (`src/cli/daemon.ts`), not in the MCP server. Multiple MCP server instances can be alive at once (Claude Desktop, Claude Code, a CLI invocation); if each ran its own sync they would duplicate every fetch and contend on writes.

- **Daemon = single writer.** Owns backfill and delta sync.
- **MCP servers = readers.** Open `cache.db` read-only.
- WAL mode, `busy_timeout = 5000`, same discipline the ledger already uses.
- **If the daemon isn't running,** the MCP server detects a stale `last_delta_at`, reports degraded freshness in the response envelope, and falls back to IMAP for that call. The cache is an optimization, never a hard dependency.

## Component: cache database

New file at `~/.agent-mail/cache.db`, created 0600 in the existing 0700 directory.

```sql
CREATE TABLE messages (
  id            INTEGER PRIMARY KEY,
  account_id    TEXT    NOT NULL,
  mailbox       TEXT    NOT NULL,
  uid           INTEGER NOT NULL,
  uidvalidity   INTEGER NOT NULL,
  modseq        INTEGER,
  message_id    TEXT,               -- RFC822 Message-Id; may be absent or non-unique
  thread_id     TEXT,               -- persistent root, see threading
  in_reply_to   TEXT,
  refs          JSON,
  from_address  TEXT,
  from_name     TEXT,
  to_json       JSON,
  cc_json       JSON,
  date          INTEGER NOT NULL,   -- epoch ms; INTERNALDATE when Date: is missing/bogus
  subject       TEXT,
  snippet       TEXT,               -- precomputed at ingest, no longer costs a fetch
  flags         JSON,
  seen          INTEGER NOT NULL DEFAULT 0,   -- denormalized hot filters
  flagged       INTEGER NOT NULL DEFAULT 0,
  answered      INTEGER NOT NULL DEFAULT 0,
  list_id       TEXT,
  list_unsub    JSON,
  is_list_mail  INTEGER NOT NULL DEFAULT 0,
  category      TEXT,               -- from attention/category.ts, computed at ingest
  size          INTEGER,
  has_attach    INTEGER NOT NULL DEFAULT 0,
  body_state    TEXT NOT NULL DEFAULT 'pending',  -- pending | fetched | failed | skipped
  UNIQUE (account_id, mailbox, uidvalidity, uid)
);

CREATE INDEX idx_msg_recent  ON messages(account_id, date DESC);
CREATE INDEX idx_msg_thread  ON messages(account_id, thread_id, date);
CREATE INDEX idx_msg_sender  ON messages(account_id, from_address, date DESC);
CREATE INDEX idx_msg_mid     ON messages(message_id);
CREATE INDEX idx_msg_pending ON messages(body_state) WHERE body_state = 'pending';

CREATE TABLE bodies (
  message_id_fk INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  body_text     TEXT,      -- plain text; HTML-stripped when no text/plain part exists
  body_html_gz  BLOB,      -- gzipped original HTML, nullable
  charset       TEXT
);

CREATE TABLE attachments (
  message_id_fk INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  part_id       TEXT NOT NULL,
  filename      TEXT,
  mime_type     TEXT,
  size          INTEGER,
  PRIMARY KEY (message_id_fk, part_id)
);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject, body, participants, attachment_names,
  content='', contentless_delete=1,
  tokenize='porter unicode61 remove_diacritics 2'
);

CREATE TABLE mailbox_state (
  account_id        TEXT NOT NULL,
  mailbox           TEXT NOT NULL,
  uidvalidity       INTEGER,
  highestmodseq     INTEGER,
  uidnext           INTEGER,
  backfill_complete INTEGER NOT NULL DEFAULT 0,
  backfill_cursor   INTEGER,        -- lowest UID ingested so far
  oldest_date       INTEGER,        -- for coverage reporting
  last_delta_at     INTEGER,
  last_error        TEXT,
  PRIMARY KEY (account_id, mailbox)
);
```

**Notes on choices:**

- `messages_fts` is **contentless** with `contentless_delete=1` (SQLite ≥3.43; we have 3.51). External-content FTS5 would need triggers spanning `messages` and `bodies`, which is more machinery for the same result. `messages_fts.rowid` = `messages.id`; ingest and delete write both in one transaction.
- **Denormalized `seen`/`flagged`/`answered`** alongside the `flags` JSON. Flag filtering is the hottest predicate in `get_overview`'s candidate sets and shouldn't require JSON extraction.
- **`uidvalidity` is part of the uniqueness key**, not just state. A UIDVALIDITY change means UIDs were reassigned; keeping it in the key makes stale rows inert rather than wrong.
- **`body_state`** decouples envelope backfill from body backfill. Envelopes land fast and make the cache useful; bodies stream in behind them.
- `category` is computed at ingest by the existing `attention/category.ts`, so bulk triage stops recomputing it per call.

## Component: sync engine

`SyncEngine` in `src/cache/sync.ts`, driven by the daemon.

### Phase 1 — Discover

`LIST` mailboxes per account, upsert into `mailbox_state`. Default synced set: `INBOX`, Sent, Archive/All Mail, and `agent-mail-holding`. Configurable per account; special-use flags (`\Sent`, `\Archive`, `\All`) resolve provider naming differences.

### Phase 2 — Backfill (newest-first, resumable)

```
1. SELECT mailbox, record UIDVALIDITY / UIDNEXT / HIGHESTMODSEQ
2. UID SEARCH ALL -> full UID list
3. Walk the list from the highest UID down, in batches of 500:
     a. fetch envelopes + BODYSTRUCTURE + flags for the batch
     b. ingest rows + FTS in one transaction
     c. update backfill_cursor
4. Separately drain body_state='pending' in batches of 50:
     a. BODYSTRUCTURE-driven fetch of text/plain + text/html parts only
     b. gzip HTML, normalize text, ingest into bodies + update FTS
5. When cursor reaches the lowest UID: backfill_complete = 1
```

Newest-first matters: the cache is useful for recent mail within seconds, and stays useful while the long tail fills in. Interrupting the daemon mid-backfill loses at most one batch.

Optional `cache.backfill_days` bounds how far back to go; default unbounded.

### Phase 3 — Delta

On each tick (default 60s) and on daemon start, per mailbox:

```
1. SELECT (QRESYNC: uidvalidity, highestmodseq, known uids)
2. If returned UIDVALIDITY != stored:
     -> purge all rows for (account, mailbox), reset state, re-backfill. Stop.
3. Server returns VANISHED (expunged UIDs) + FETCH for messages whose
   MODSEQ > stored highestmodseq (flag changes and new arrivals)
4. Apply: delete vanished rows (+FTS), update changed flags,
   ingest new messages, enqueue their bodies
5. Store new HIGHESTMODSEQ, stamp last_delta_at
```

**Fallback for servers without CONDSTORE:** `UID SEARCH UID <stored_uidnext>:*` for arrivals, plus a periodic full flag resync (UID FETCH FLAGS for all known UIDs, cheap — flags-only). Slower and coarser, but correct. Capability is detected once per connection and recorded.

### Phase 4 — IDLE (deferred to phase 3 of rollout)

The pool already holds live connections. IDLE on INBOX turns the 60s tick into push. Deliberately not in the first cut: tick-driven sync is simpler to reason about, and 60s staleness on a cache that also echoes local mutations is not the bottleneck.

## Component: persistent threading

Today `buildThreads()` unions only what one search returned. In the cache, threading becomes global and persistent.

At ingest, for each message, union its `message_id` with `in_reply_to` and every entry in `references`, in a persisted table:

```sql
CREATE TABLE thread_links (
  message_id TEXT PRIMARY KEY,
  root_id    TEXT NOT NULL
);
CREATE INDEX idx_thread_root ON thread_links(root_id);
```

Path-compressed union-find, same algorithm as `provider/threading.ts` — that module's logic is reused, with the map backed by SQLite instead of memory. `messages.thread_id` is denormalized from `root_id` for fast grouping, and rewritten when a late-arriving message merges two previously-disjoint threads (bounded: only the smaller side is rewritten).

**This fixes documented limitation #1** — a reply sitting in Sent now joins its thread, because Sent is synced and threading is global. `thread_state` (`awaiting_you` vs `awaiting_them`) becomes correct rather than best-effort.

## Component: query layer

`src/cache/query.ts` returns the shapes the tools already emit. No tool schema changes.

**Lexical search** fuses FTS5 with structured predicates in one statement:

```sql
SELECT m.*, bm25(messages_fts, 8.0, 1.0, 4.0, 2.0) AS rank
FROM messages_fts
JOIN messages m ON m.id = messages_fts.rowid
WHERE messages_fts MATCH :query
  AND m.account_id IN (...)
  AND m.date >= :since AND m.date < :before
  AND m.mailbox = :mailbox
ORDER BY rank, m.date DESC
LIMIT :limit;
```

Column weights boost subject over body, participants over attachment names. When `query` is absent the FTS join drops and it's a plain indexed scan ordered by `date DESC` — which is also what makes cursor pagination exact instead of the current UID-order approximation.

**`get_overview`'s four candidate sets** become four indexed queries against one local DB instead of four IMAP searches × N accounts:

| Set | Cache query |
|---|---|
| `unread` | `seen = 0 AND date >= :since` |
| `flagged` | `flagged = 1` |
| `recent_direct` | `date >= :since` + `to_json` contains account email |
| `awaiting_you` | `answered = 0 AND date >= :since` + thread_state from `thread_id` grouping |

**Snippets become free.** They're materialized at ingest, so `include_snippets` stops being a cost knob. The parameter stays for back-compat and becomes a no-op that always populates.

### Coverage reporting

Every cache-backed response carries freshness in the existing multi-account envelope, so the agent can reason about what it's looking at rather than silently trusting a partial mirror:

```json
{
  "cache": {
    "state": "fresh",
    "last_synced_at": "2026-07-31T18:04:11Z",
    "coverage": { "INBOX": { "complete": true, "oldest": "2019-03-02T…" } }
  }
}
```

`state` is `fresh` (delta < 5 min), `stale` (delta older, daemon may be down), `backfilling` (usable but incomplete), or `unavailable` (fell back to IMAP).

## Component: invalidation

`src/cache/invalidate.ts`, called from `Executor.performAction` after each successful mutating branch — the single funnel every IMAP write already passes through.

```ts
invalidate(cache, {
  account_id: string,
  mailbox: string,
  uids: number[],
  effect: 'moved' | 'flags_changed' | 'deleted' | 'appended',
  detail?: { to_mailbox?: string; flags_added?: string[]; flags_removed?: string[] },
});
```

Applies the optimistic echo (D2), marks the mailbox for priority resync. Failures here are logged and swallowed — a failed cache update must never fail a successful mail operation.

## Rollout

Config key `cache.mode`:

- **`off`** — current behavior. Sync still runs if the daemon is up, so the cache warms without being read.
- **`shadow`** — reads run against **both** cache and IMAP; the IMAP result is returned, the two are diffed, divergences are logged with enough detail to reproduce. This is how we earn confidence that the cache doesn't lose or duplicate messages.
- **`on`** — cache serves reads, IMAP is the fallback when coverage or freshness is insufficient.

Phased:

| Phase | Contents |
|---|---|
| 1 | Schema, ingest, backfill, delta sync, `search_threads` in shadow → on |
| 2 | `get_overview` from cache, persistent threading, sender familiarity signals |
| 3 | IDLE push, `sqlite-vec` embeddings + RRF hybrid search |

## Error handling

- **UIDVALIDITY change** — purge that mailbox's rows, reset state, re-backfill. Logged loudly; it should be rare.
- **Sync failure for one account** — isolated. Other accounts keep syncing; `mailbox_state.last_error` records it; coverage reports `stale` for that account only. Mirrors the existing `per_account_errors` posture.
- **Body fetch failure** — `body_state = 'failed'`, retried with backoff up to 3 times, then left alone. The envelope row stays valid and searchable.
- **Corrupt cache / failed migration** — delete and re-backfill. Safe by construction (D2). The daemon does this automatically on `SQLITE_CORRUPT`.
- **Disk pressure** — `cache.max_bytes` (default unset). When exceeded, evict oldest bodies first (`body_state = 'skipped'`), never envelopes. Bodies are re-fetchable on demand.
- **Daemon down** — MCP servers detect stale `last_delta_at` and fall back to IMAP, reporting `state: "stale"`.

## Testing

**Unit (pure, no I/O):**
- `ingest.ts` — `EmailMessage` → rows, including missing `Message-Id`, bogus `Date:`, HTML-only bodies, non-UTF8 charsets.
- `threading.ts` — union-find over persisted links; late-arriving message merging two threads; cross-mailbox reply.
- `query.ts` — BM25 ordering, structured predicate combinations, cursor pagination exactness.

**Mocked-integration (fake `ImapFlow`):**
- Backfill resumes correctly after interruption at an arbitrary batch.
- Delta applies VANISHED + flag changes + arrivals.
- UIDVALIDITY change triggers purge and re-backfill.
- CONDSTORE-absent server takes the fallback path and converges to the same state.
- Invalidation echo is overwritten by the next delta.

**Shadow-mode divergence:** a fixture mailbox where cache and IMAP results must match exactly for a battery of queries. This is the real acceptance gate for flipping `on`.

**Sizing:** ingest a 10k-message synthetic corpus, assert `cache.db` stays within the D1 budget.

## Migration / back-compat

- **No tool schema changes.** `search_threads` and `get_overview` inputs and outputs are unchanged except for the additive `cache` envelope key.
- **No ledger changes.** `cache.db` is a separate file; `ledger.db` is untouched.
- **`include_snippets`** becomes a no-op (always populated). Additive, not breaking.
- **Ordering improves.** Results become exactly date-ordered rather than UID-ordered. Same posture as the April ordering fix: a bug fix, not a version.
- Uninstall: `rm ~/.agent-mail/cache.db`.

## Limitations retired by this work

From the April design's "Known limitations (fixed in Z)":

| # | Limitation | Status after this |
|---|---|---|
| 1 | Cross-mailbox thread reconstruction | **Fixed** — global persistent threading |
| 3 | HTML-only bodies produce empty snippets | **Fixed** — full HTML stored and stripped at ingest |
| 4 | Sender familiarity not computed | **Unblocked** — history is now local (phase 2) |
| 5 | Cross-thread participant graph | **Unblocked** — phase 2 |
| 6 | IDLE / push | **Unblocked** — phase 3 |
| 2 | Plus-addressing / aliases | Unchanged, still primary-email only |

## Open questions

1. **Which mailboxes by default?** INBOX + Sent + Archive is the useful minimum. Gmail's All Mail duplicates everything and would roughly double the cache — probably exclude by default and let it be opted in.
2. **Backfill depth.** Unbounded is the honest default for a search tool, but the first sync of a decade-old Gmail account is a multi-hour, multi-GB operation. A `backfill_days` default of ~730 with explicit "go deeper" may be the better first-run experience.
3. **Does the daemon become mandatory?** Today it's optional (reviewer notifications only). Sync makes it load-bearing for the good experience. That's a setup-docs and install-flow change, not just code.
