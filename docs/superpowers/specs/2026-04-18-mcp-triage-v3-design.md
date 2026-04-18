# MCP triage v3 — safety net, polish, classifier cleanup

Date: 2026-04-18
Status: Design approved, ready for implementation plan

## Background

Third round of user feedback on the MCP triage surface. The v2 round (PR #7) added pagination, list headers, HTML snippets, and sender/mailbox tools. Using it for a real triage run surfaced three problem areas:

1. **No per-UID restore path.** Over-quarantining forces a choice between "live with it" and redo the whole batch via `undo_intent`. The user actually hit this ("Denver Ventures") during the session.
2. **Residual rough edges** from earlier rounds: `quarantine_thread` still present as a deprecated name, `limit` documentation out of date, `list_unsubscribe` returned as raw RFC-encoded text, snippets always empty.
3. **`is_automated` classifier is wrong often enough** that the user now ignores it and relies on `is_list_mail` + sender shape. Meanwhile `list_senders` exists but wasn't discovered — its value proposition isn't surfaced where agents look.

## Goals

- Give agents a reversible, granular path out of quarantine.
- Finish the `quarantine_thread` → `quarantine_messages` rename and clean up outdated docs.
- Replace the noisy `is_automated` signal with clean `is_list_mail` surface area.
- Make `list_senders` obviously the right tool for bulk triage.

## Non-goals

- No new classifier work beyond removing `is_automated`.
- No "one-click unsubscribe" action (we parse the header into structured fields so a future action is cheap, but we don't ship the action itself).
- No deprecation cycle for removed surface (`quarantine_thread`, `is_automated`). This is a breaking MCP change; the contract is versioned via the tool list.

## Design

### Bundle A — Safety net

#### `restore_messages(targets, dry_run?)`

Inverse of `quarantine_messages`. Accepts the same account-qualified `targets` shape.

- Looks up the ledger row for each target UID to find `original_mailbox` (recorded at quarantine time). If a target isn't in the ledger (e.g. user manually moved something into the quarantine mailbox), return an error for that target and continue with the rest — the response surfaces per-target results.
- Moves each UID from the quarantine mailbox back to its `original_mailbox`.
- Writes a `restore` intent to the ledger with `reverses_intent_id` pointing at the originating quarantine intent (nullable — a restore can span multiple source intents; in that case `reverses_intent_id` is an array).
- Respects `dry_run` the same way quarantine does.
- Response shape mirrors `quarantine_messages` with `include_summary: true` (see below): `{intent_id, moved: [{uid, account_id, subject, from, destination_mailbox}], errors: [{uid, account_id, reason}]}`.

#### `get_intent(intent_id)`

Returns the full intent record:

```
{
  id: string,
  type: "quarantine" | "restore" | "label" | ...,
  created_at: ISO8601,
  account_id: string,
  targets: [{uid, mailbox, subject, from}],
  status: "completed" | "reversed" | "partial",
  reverses_intent_id?: string | string[],
  reversed_by_intent_id?: string,
}
```

Target `subject`/`from` come from the envelope snapshot persisted at intent time (see next item). This means restore/partial-undo logic works even if the message has since been moved or deleted by another path.

#### `quarantine_messages` gains `include_summary: true`

- Adds `moved: [{uid, account_id, subject, from, original_mailbox}]` to the response.
- These fields are **already persisted to the ledger** (new in this round — the ledger currently records UIDs only). This closes the loop: `get_intent` can return them, and `restore_messages` has the `original_mailbox` it needs.
- Ledger schema change: add `envelope_snapshot JSON` column to the intent-targets table. Backfill not required — old intents existed before `restore_messages` did, so `restore` against them is best-effort and may return "original_mailbox unknown" errors for some targets.

### Bundle B — Renames & polish

#### Drop `quarantine_thread` entirely

Remove the deprecated alias from the tool list. Callers must use `quarantine_messages`.

#### `limit` semantics

- Update the `limit` parameter description on `search_threads`: `"Max results per account (default: 20). When multiple accounts are queried, results are interleaved; use a single account_id for a true top-N."`
- Add `envelope.per_account_counts: {[account_id: string]: number}` to the response so agents can see the distribution without inferring from the results.
- **Not adding** `total_limit` — a single-account query already expresses it, and the per-account semantics are the right default for multi-account triage.

#### `list_unsubscribe` parsing

Where we currently return the raw header value, return:

```
unsubscribe: {
  http_url?: string,
  mailto?: string,
  one_click?: boolean,   // true if RFC 8058 List-Unsubscribe-Post present
  raw: string,
}
```

Parsing:
1. MIME-decode (RFC 2047) the raw header to strip `=?us-ascii?Q?...?=` wrappers.
2. Parse the RFC 2369 comma-separated `<uri>` list. First matching `https?:` → `http_url`; first matching `mailto:` → `mailto`.
3. If the message also has `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, set `one_click: true`.
4. Preserve `raw` for debugging / edge cases.

#### Snippets

Root cause: we're reading `BODYSTRUCTURE` to detect HTML but not fetching a text preview.

Fix:
- Find the first `text/plain` part; fall back to `text/html` stripped of tags.
- Fetch up to ~500 chars of that part (IMAP partial body fetch — no full-message pull).
- Populate `snippet` on `search_threads`, `read_thread`, and anywhere envelopes are returned.
- One worker function so behavior is consistent across tools.

### Bundle C — Classifier cleanup

#### Remove `is_automated`

- Drop the field from all tool outputs (envelope summaries, `list_senders` rows).
- Delete the classifier code.
- `list_senders` currently exposes `is_automated_ratio` — replace with `is_list_mail_ratio` (fraction of rows with `List-*` headers present).

#### `list_senders` discoverability

- Keep the tool name. Problem was discoverability, not naming.
- Update `get_overview` prose to recommend `list_senders` explicitly when an inbox has >30 senders with count >3 (tunable): "You have N senders with K+ messages — `list_senders` will let you make sender-level decisions instead of per-UID."
- Update `list_senders` description to emphasize the triage use case: leading sentence should be "Bulk triage: make N sender decisions instead of 10×N UID decisions."

## Data flow / ledger changes

- New intent type: `restore`.
- Intent-targets rows gain `envelope_snapshot` (JSON: `{subject, from, original_mailbox}`) captured at intent time.
- `reverses_intent_id` / `reversed_by_intent_id` are new nullable fields on the intent row. `reverses_intent_id` may be an array when a single restore spans multiple quarantine intents.
- Quarantine intents that predate this schema change have `envelope_snapshot = null`; `restore_messages` falls back to whatever it can get from the live IMAP state, and returns per-target errors for what it can't.

## Testing

- `restore_messages` happy path: quarantine → restore → message back in INBOX, intent records linked both ways.
- `restore_messages` partial failure: mixed targets where some are in the ledger and some aren't; response reports per-target errors and still moves the ones it can.
- `get_intent`: returns full target list with subjects; works for quarantine, restore, and label intents.
- `quarantine_messages` with `include_summary: true`: response includes envelopes; without the flag, response shape is unchanged.
- `list_unsubscribe` parser: RFC 2047 quoted-printable, multiple URIs, http+mailto mix, one-click detection, malformed headers.
- Snippets: plain-text parts, HTML-only messages, multipart/alternative, truncation boundary.
- `list_senders`: `is_list_mail_ratio` replaces `is_automated_ratio`; `is_automated` absent everywhere.
- Tool list: `quarantine_thread` is gone.

## Breaking changes

- `quarantine_thread` removed.
- `is_automated` field removed from all outputs.
- `is_automated_ratio` renamed to `is_list_mail_ratio` on `list_senders` rows.
- `list_unsubscribe` field changes from `string` to structured object (old raw value still accessible as `.raw`).

All acceptable — MCP tool contract is versioned via the tool list, and the tool is early enough that the user is the only consumer.

## Open questions

None remaining after the scoping pass. Implementation order recommendation: ledger schema + `envelope_snapshot` first (unblocks A), then Bundle A, then B, then C. Bundle B snippets work is the largest single chunk within B.
