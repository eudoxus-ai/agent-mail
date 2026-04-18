# MCP triage v3 — safety net, reversibility framing, rename

Date: 2026-04-18
Status: Design approved, ready for implementation plan

## Background

Third round of user feedback on the MCP triage surface. The v2 round (PR #7) added pagination, list headers, HTML snippets, and sender/mailbox tools. Using it for a real triage run surfaced four problem areas:

1. **No per-UID restore path.** Over-quarantining forces a choice between "live with it" and redo the whole batch via `undo_intent`. The user hit this ("Denver Ventures") during the session.
2. **The agent stays cautious across multiple sessions** because the tool surface doesn't consistently signal that every mutation is reversible. "Quarantine" primes caution; reversibility is buried in descriptions; responses don't echo the undo path. The agent recalibrates slowly instead of within one session.
3. **Residual rough edges** from earlier rounds: `quarantine_thread` still present as a deprecated name, `limit` documentation out of date, `list_unsubscribe` returned as raw RFC-encoded text, snippets always empty.
4. **`is_automated` classifier is wrong often enough** that the user now ignores it and relies on `is_list_mail` + sender shape. Meanwhile `list_senders` exists but wasn't discovered — its value proposition isn't surfaced where agents look.

## Goals

- Give agents a reversible, granular path out of the holding folder.
- Make reversibility a first-class, repeatedly-reinforced property of the server — in the server preamble, tool descriptions, tool annotations, and mutation responses.
- Rename "quarantine" → "holding" across tools and mailboxes to stop priming agents for malware-level caution.
- Drop the stale `quarantine_thread` alias, fix outdated `limit` docs, parse `list_unsubscribe`, populate snippets.
- Replace the noisy `is_automated` signal with clean `is_list_mail` surface area, and make `list_senders` obviously the right tool for bulk triage.

## Non-goals

- No new classifier work beyond removing `is_automated`.
- No "one-click unsubscribe" action (we parse the header into structured fields so a future action is cheap, but we don't ship the action itself).
- No deprecation cycle for `quarantine_thread` or `is_automated`. Those are breaking removals; the MCP tool contract is versioned via the tool list.
- Permanent deletion and outbound send stay out of this server's capability surface by design. The server preamble will state this explicitly.

## Design

### Bundle A — Safety net

#### `restore_messages(targets, dry_run?)`

Inverse of `hold_messages` (the new name for `quarantine_messages` — see Bundle D). Accepts the same account-qualified `targets` shape.

- Looks up the ledger row for each target UID to find `original_mailbox` (recorded at hold time). If a target isn't in the ledger (e.g. user manually moved something into the holding mailbox), return an error for that target and continue with the rest — the response surfaces per-target results.
- Moves each UID from the holding mailbox back to its `original_mailbox`.
- Writes a `restore` intent to the ledger with `reverses_intent_id` pointing at the originating hold intent. When a single restore spans multiple hold intents, `reverses_intent_id` is an array.
- Respects `dry_run` the same way `hold_messages` does.
- Response shape mirrors `hold_messages` with `include_summary: true` (see below): `{intent_id, moved: [{uid, account_id, subject, from, destination_mailbox}], errors: [{uid, account_id, reason}], reversible, undo_hint}`.

#### `get_intent(intent_id)`

Returns the full intent record:

```
{
  id: string,
  type: "hold" | "restore" | "label" | ...,
  created_at: ISO8601,
  account_id: string,
  targets: [{uid, mailbox, subject, from}],
  status: "completed" | "reversed" | "partial",
  reverses_intent_id?: string | string[],
  reversed_by_intent_id?: string,
}
```

Target `subject` / `from` come from the envelope snapshot persisted at intent time (see next item). Restore and partial-undo logic works even if the message has since been moved by another path.

#### `hold_messages` gains `include_summary: true`

- Adds `moved: [{uid, account_id, subject, from, original_mailbox}]` to the response.
- These fields are persisted to the ledger (new in this round — the ledger currently records UIDs only). This closes the loop: `get_intent` can return them, and `restore_messages` has the `original_mailbox` it needs.
- Ledger schema change: add `envelope_snapshot JSON` column to the intent-targets table. Backfill not required — old intents predate `restore_messages`, so restore against them is best-effort and may return "original_mailbox unknown" for some targets.

### Bundle B — Reversibility framing

This bundle makes the "everything here is reversible" property consistently legible to agents, so caution recalibrates within a single session instead of across three.

#### Server preamble

Set the MCP server-level `instructions` string (top-level description the client surfaces before any tool call):

> agent-mail design contract. This server is built so that no action it exposes can cause irreversible harm. Every mutation (hold, label, draft) is reversible for 30 days via `undo_intent` or `restore_messages`, and every action is recorded in `get_audit_log`. Sending email and permanent deletion are deliberately not exposed — those operations require a separate human-in-the-loop flow outside this server. Agents should treat this as a low-stakes environment: prefer acting and reconciling afterward over asking permission per action. Over-holding-then-restoring is a normal interaction pattern, not a failure mode.

#### Reversibility-first tool descriptions

Every mutating tool's description leads with its reversibility property, using the "this server cannot" framing where applicable. The negation matters — it reads as a capability constraint, not a feature.

- `hold_messages`: "Move messages to the holding folder. Fully reversible: messages move to `agent-mail-holding` and can be restored via `restore_messages` or `undo_intent` within 30 days. This server cannot permanently delete messages. Operates at the message/UID level — only the UIDs you pass are moved; thread siblings are NOT auto-expanded."
- `label_thread`: "Add or remove a label. Fully reversible via `undo_intent` within 30 days. Applies per-account…"
- `queue_send`: "Queue an email for human review. This server cannot send mail; queued messages require explicit human approval through a separate flow before transmission. You can provide a `draft_id`…"
- `restore_messages`: "Move messages out of the holding folder back to their original mailbox. Fully reversible by re-holding. This server cannot permanently delete messages."
- `unsubscribe_sender`: same treatment — lead with what's reversible, call out what the server cannot do.

#### Response-level reversibility echo

Every mutation response gains two fields:

```
reversible: true,
undo_hint: {
  intent_id: string,
  method: "undo_intent" | "restore_messages",
  window_expires_at: ISO8601,
}
```

- `method` is `restore_messages` for hold intents (more granular inverse available), `undo_intent` for everything else.
- `window_expires_at` = `created_at + 30d`.
- This reinforces the property at the moment agents recalibrate from tool results, and removes the need to reconstruct the intent ID from audit history.

#### MCP tool annotations

Set `annotations` consistently on every tool so well-behaved clients can adjust confirmation UI. Today's clients don't all honor these rigorously, but setting them correctly costs nothing.

| Tool | readOnlyHint | destructiveHint | idempotentHint |
|---|---|---|---|
| `search_threads`, `read_thread`, `list_senders`, `list_mailboxes`, `get_audit_log`, `get_overview`, `get_intent`, `get_pending_actions` | true | false | true |
| `label_thread` | false | false | true |
| `hold_messages` | false | **false** (reversible) | true |
| `restore_messages` | false | false | true |
| `undo_intent` | false | false | true |
| `draft_reply` | false | false | false |
| `queue_send` | false | **true** (once approved by human) | false |
| `unsubscribe_sender` | false | true | false |

`hold_messages` getting `destructiveHint: false` is the machine-readable version of the whole bundle's thesis.

### Bundle C — Rename quarantine → holding

"Quarantine" comes from malware contexts and primes caution. The operation is really "move to a holding folder." Rename across tools, mailboxes, and ledger types.

#### Tool renames

- `quarantine_messages` → `hold_messages`. The old name is **not** kept as a deprecated alias — we're removing `quarantine_thread` in this same release, and carrying another deprecated alias forward would dilute the message. Breaking change; tool list is versioned.
- `quarantine_thread` is dropped entirely (was already planned).

#### Mailbox rename

- Folder name changes from `agent-mail-quarantine` to `agent-mail-holding` on all providers.
- Migration per-account on first server startup after upgrade:
  1. If `agent-mail-holding` exists, do nothing.
  2. Else if `agent-mail-quarantine` exists, attempt IMAP `RENAME agent-mail-quarantine agent-mail-holding`. If that fails (provider doesn't support it on system folders, etc.), create `agent-mail-holding` and move all messages from `agent-mail-quarantine` to `agent-mail-holding`, then delete the old folder.
  3. Else create `agent-mail-holding` on first write.
- Log the migration outcome per account to the audit log as a `migrate` intent.

#### Ledger rename

- Intent type `quarantine` → `hold` in the ledger schema. Existing rows migrated in place on the same startup pass.
- `reverses_intent_id` lookups work across both old and new type names via the migration — after migration the ledger is uniformly `hold`.

#### Folder name used by `get_audit_log` and `get_intent`

- All responses reference `agent-mail-holding` (or whatever the resolved name is per account after migration).

### Bundle D — Polish

#### `limit` semantics

- Update the `limit` parameter description on `search_threads`: "Max results per account (default: 20). When multiple accounts are queried, results are interleaved; use a single `account_id` for a true top-N."
- Add `envelope.per_account_counts: {[account_id: string]: number}` to the response so agents can see the distribution without inferring from results.
- Not adding `total_limit` — a single-account query already expresses it, and per-account semantics are the right default for multi-account triage.

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
4. Preserve `raw` for debugging and edge cases.

#### Snippets

Root cause: we read `BODYSTRUCTURE` to detect HTML but don't fetch a text preview.

Fix:
- Find the first `text/plain` part; fall back to `text/html` stripped of tags.
- Fetch up to ~500 chars of that part via IMAP partial body fetch — no full-message pull.
- Populate `snippet` on `search_threads`, `read_thread`, and anywhere envelopes are returned.
- One worker function so behavior is consistent across tools.

### Bundle E — Classifier cleanup

#### Remove `is_automated`

- Drop the field from all tool outputs (envelope summaries, `list_senders` rows).
- Delete the classifier code.
- `list_senders` currently exposes `is_automated_ratio` — replace with `is_list_mail_ratio` (fraction of rows with `List-*` headers present).

#### `list_senders` discoverability

- Keep the tool name. Problem was discoverability, not naming.
- Update `get_overview` prose to recommend `list_senders` explicitly when an inbox has >30 senders with count >3 (tunable): "You have N senders with K+ messages — `list_senders` will let you make sender-level decisions instead of per-UID."
- Update `list_senders` description to lead with: "Bulk triage: make N sender decisions instead of 10×N UID decisions."

## Data flow / ledger changes

- New intent type: `restore`.
- Intent type rename: `quarantine` → `hold`.
- Intent-targets rows gain `envelope_snapshot` (JSON: `{subject, from, original_mailbox}`) captured at intent time.
- `reverses_intent_id` / `reversed_by_intent_id` are new nullable fields on the intent row. `reverses_intent_id` may be an array when a single restore spans multiple hold intents.
- Hold intents that predate the `envelope_snapshot` column have it as `null`; `restore_messages` falls back to whatever it can read from live IMAP state and returns per-target errors for what it can't.
- Folder migration `agent-mail-quarantine` → `agent-mail-holding` runs per account on first startup; outcome logged as a `migrate` audit entry.

## Testing

- `restore_messages` happy path: hold → restore → message back in INBOX, intent records linked both ways.
- `restore_messages` partial failure: mixed targets where some are in the ledger and some aren't; response reports per-target errors and still moves the ones it can.
- `get_intent`: returns full target list with subjects; works for hold, restore, and label intents.
- `hold_messages` with `include_summary: true`: response includes envelopes; without the flag, response shape is unchanged.
- Every mutation response includes `reversible: true` and a correct `undo_hint` (expiry = created_at + 30d; method matches tool).
- Server `instructions` string is set and returned in the MCP initialize response.
- Tool annotations match the table above for every tool.
- Tool descriptions: every mutating tool leads with a reversibility sentence.
- `list_unsubscribe` parser: RFC 2047 quoted-printable, multiple URIs, http+mailto mix, one-click detection, malformed headers.
- Snippets: plain-text parts, HTML-only messages, multipart/alternative, truncation boundary.
- `list_senders`: `is_list_mail_ratio` replaces `is_automated_ratio`; `is_automated` absent everywhere.
- Tool list: `quarantine_thread` and `quarantine_messages` are gone; `hold_messages` is present.
- Folder migration: with existing `agent-mail-quarantine`, IMAP RENAME path succeeds; when RENAME fails, create+move+delete path succeeds; when neither folder exists, `agent-mail-holding` is created lazily on first write.
- Ledger migration: existing `quarantine` intent rows are rewritten as `hold`; `undo_intent` still works against them.

## Breaking changes

- `quarantine_thread` removed.
- `quarantine_messages` renamed to `hold_messages` with no alias.
- `is_automated` field removed from all outputs.
- `is_automated_ratio` renamed to `is_list_mail_ratio` on `list_senders` rows.
- `list_unsubscribe` field changes from `string` to structured object (old raw value still accessible as `.raw`).
- Folder `agent-mail-quarantine` renamed to `agent-mail-holding` (auto-migrated per account).
- Ledger intent type `quarantine` renamed to `hold` (auto-migrated at startup).

Acceptable — the MCP contract is versioned via the tool list and the product has a single user.

## Implementation order

1. Ledger schema: add `envelope_snapshot`, `reverses_intent_id`, `reversed_by_intent_id`; rename `quarantine` → `hold`. Startup migration for existing rows.
2. Folder migration logic (`agent-mail-quarantine` → `agent-mail-holding`).
3. Bundle C tool rename: `quarantine_messages` → `hold_messages`; drop `quarantine_thread`.
4. Bundle A: `restore_messages`, `get_intent`, `hold_messages` `include_summary`.
5. Bundle B: server preamble, reversibility-first descriptions, `reversible` + `undo_hint` in every mutation response, annotations table.
6. Bundle D: `limit` docs + `per_account_counts`, `list_unsubscribe` parsing, snippets.
7. Bundle E: remove `is_automated`, rename to `is_list_mail_ratio`, `get_overview` prose, `list_senders` description.

## Honest caveat

Even with all of this, an agent coming in cold may still start cautious for the first turn or two — caution is the correct default across the wider universe of tools. What this round does is make recalibration happen within a single session rather than across three.
