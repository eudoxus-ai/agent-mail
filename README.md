# agent-mail

An MCP server that gives AI agents guardrailed access to your email on macOS. Works with Gmail, iCloud, and any standard IMAP account.

## What's different

Every other email MCP server gives agents raw access to your inbox. agent-mail reshapes the API surface so dangerous actions don't exist:

- **"Delete" becomes a hold.** Messages move to `agent-mail-holding`. Fully reversible for 30 days via `restore_messages` or `undo_intent`.
- **"Send" requires approval.** Every outbound email goes through a human review queue.
- **"Unsubscribe" just works.** Low-risk actions run immediately, no friction.
- **Everything is logged.** Full audit trail of every action, by every agent, across every account.

The safety isn't in the AI's prompt. It's in the application. The agent literally cannot send an email without your approval, because the "send" tool creates a pending intent, not an SMTP connection. This is deterministic safety, not probabilistic guardrails.

### Local-first

Your email credentials, message content, and audit log never leave your machine. No cloud service, no proxy, no "we don't persist it, promise." It's an npm package that runs on your computer and talks to your email provider directly via IMAP/SMTP.

### Multi-account

One MCP server manages all your email accounts. Gmail, iCloud, work IMAP, whatever. Same guardrails, same audit log, same approval queue.

## How it works

```
┌─────────────────────────────────────────┐
│  Claude / ChatGPT / any MCP client      │
└────────────────┬────────────────────────┘
                 │ MCP (stdio)
┌────────────────▼────────────────────────┐
│          agent-mail MCP server          │
│                                         │
│  Tools ─► Policy Engine ─► Intent Ledger│
│                    │                    │
│              Shared Executor            │
│                    │                    │
│          IMAP/SMTP (all accounts)       │
└─────────────────────────────────────────┘
         ┌───────────┘
┌────────▼────────┐
│  Reviewer UI    │
│  localhost:4242  │
└─────────────────┘
```

1. The agent calls a tool (e.g. `queue_send`).
2. The **policy engine** checks `policy.yaml` to decide: execute immediately, or gate for approval?
3. If gated, the **intent ledger** (SQLite) stores the pending action. The agent gets back `{status: "pending", intent_id: "..."}`.
4. You open the **reviewer UI** at `localhost:4242`, see the pending email, and click Approve or Reject.
5. The **shared executor** sends the email via SMTP. The audit log records everything.

## Getting Started

If you already have Claude Desktop and you just want the email tools working, follow this section first. It is the shortest path. The more technical reference material is in `Setup` below.

1. Install Node.js 22 or newer from [nodejs.org](https://nodejs.org/). If you are not sure which one to choose, install the current LTS version.
2. Download this project to your Mac and unzip it somewhere easy to find, like `Downloads` or `Documents`.
3. Open the Terminal app. The fastest way is to press `Command-Space`, type `Terminal`, and press Return.
4. In Terminal, type `cd ` with a space after it, then drag the unzipped `agent-mail` folder into the Terminal window and press Return. That moves Terminal into the right folder.
5. Copy and paste these commands, one at a time:

```bash
npm install
npm run build
./bin/agent-mail.mjs add-account
```

6. When `add-account` asks for your password, use an app-specific password for Gmail or iCloud, not your normal inbox password.
7. Start the reviewer window by pasting this command into the same Terminal window:

```bash
./bin/agent-mail.mjs reviewer
```

8. Open `http://127.0.0.1:4242` in your browser. The reviewer UI is local-only, so there is no separate sign-in step.
9. The easiest way to add `agent-mail` to Claude Desktop is to run:

```bash
./bin/agent-mail.mjs install
```

10. If you prefer to edit Claude Desktop config yourself, use this file on your Mac:

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

Paste this into the `mcpServers` section, replacing `/absolute/path/to/agent-mail` with the real folder you downloaded:

```json
{
  "mcpServers": {
    "agent-mail": {
      "command": "/absolute/path/to/agent-mail/bin/agent-mail.mjs",
      "args": ["serve"]
    }
  }
}
```

11. Fully quit Claude Desktop and open it again. You should now see the `agent-mail` tools.
12. If you want macOS notifications whenever Claude needs approval to send email, go back to Terminal and run:

```bash
./bin/agent-mail.mjs install-daemon
```

After that, `agent-mail` can keep the approval daemon running for you in the background.

## Setup

### Prerequisites

- macOS
- Node.js 22+
- App-specific passwords for Gmail and iCloud (not your regular password)
  - Gmail: [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
  - iCloud: [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security → App-Specific Passwords

### Install from source

```bash
git clone <repo-url> && cd agent-mail
npm install
npm run build
```

`agent-mail` now uses macOS's built-in Notification Center through `osascript`. There is no bundled `terminal-notifier` binary to install, patch, or remove on macOS 14+.

### Add your email accounts

```bash
./bin/agent-mail.mjs add-account
```

This will prompt for your email address, auto-detect IMAP/SMTP hosts, ask for your password, test the IMAP connection, and then store the password in the macOS Keychain. Run it once per account.

Local files are stored at `~/.agent-mail/`:

```
~/.agent-mail/
  accounts.yaml      # Your email account metadata (hosts, ports, email, account ID)
  policy.yaml        # Risk tiers and gating rules
  ledger.db          # Intent ledger + audit log (SQLite)
```

Passwords are not stored in `~/.agent-mail/`. They are stored in the macOS Keychain under service name `agent-mail`.

### Connect to Claude Desktop

The easiest option is:

```bash
./bin/agent-mail.mjs install
```

That updates `~/Library/Application Support/Claude/claude_desktop_config.json` for you after showing the change.

If you prefer to inspect the exact JSON first:

```bash
./bin/agent-mail.mjs config
```

If you want to edit the file manually, add this to your Claude Desktop MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "agent-mail": {
      "command": "/absolute/path/to/agent-mail/bin/agent-mail.mjs",
      "args": ["serve"]
    }
  }
}
```

Or if you prefer npx (after `npm link`):

```json
{
  "mcpServers": {
    "agent-mail": {
      "command": "npx",
      "args": ["agent-mail", "serve"]
    }
  }
}
```

Restart Claude Desktop. You should see agent-mail's 13 tools in the tool list.

### Launch the reviewer UI once

In a separate terminal:

```bash
./bin/agent-mail.mjs reviewer
```

Opens at `http://127.0.0.1:4242`.

The reviewer UI does not use a bearer token. It is protected by only listening on localhost and rejecting cross-origin state-changing requests from non-localhost sites.

### Install the background reviewer daemon

If you want notifications without manually starting the reviewer every time, install the launchd job:

```bash
./bin/agent-mail.mjs install-daemon
```

This writes `~/Library/LaunchAgents/com.agent-mail.reviewer.plist`, starts the daemon immediately, and logs to:

```text
~/.agent-mail/daemon.log
~/.agent-mail/daemon-error.log
```

Useful lifecycle commands:

```bash
./bin/agent-mail.mjs status
./bin/agent-mail.mjs uninstall-daemon
```

`install-daemon` prefers the compiled build in `dist/`. If you skip `npm run build`, the source checkout path requires a globally available `tsx`.

### Notification behavior on macOS 14+

Notifications are posted with `osascript` instead of `node-notifier`/`terminal-notifier`. That avoids the stale bundled binary path that has known compatibility issues on newer macOS releases. The notification tells you which local reviewer URL to open.

## Tools

| Tool | What it does | Risk | Gate |
|------|-------------|------|------|
| `search_threads` | Search emails across all accounts (or scoped via `account_ids`) | None | Immediate |
| `read_thread` | Read a single message identified by `target: {account_id, uid}` | None | Immediate |
| `get_attachment` | Download one attachment to a private staging directory and return its path | Low | Immediate |
| `get_overview` | Cross-account summary of recent mail that needs attention | None | Immediate |
| `draft_reply` | Create a draft (saved to Drafts, not sent) | Low | Immediate |
| `label_thread` | Add/remove IMAP flags on `targets: [{account_id, uid}]` | Low | Immediate |
| `unsubscribe_sender` | HTTP List-Unsubscribe (RFC 2369) | Low | Immediate |
| `get_pending_actions` | Check the approval queue (cross-account) | None | Immediate |
| `get_audit_log` | View action history (cross-account) | None | Immediate |
| `queue_send` | Queue an email for sending | High | **Always requires approval** |
| `hold_messages` | Move targets to `agent-mail-holding`; reversible for 30 days; supports `dry_run: true`, `include_summary: true`, `background: true` | Medium | Configurable |
| `restore_messages` | Move held messages back to their original mailbox using the ledger snapshot captured at hold time | Low | Immediate |
| `get_intent` | Return the full record of a past intent: targets with captured subject/from, status, and reversal links; useful for partial-restore workflows | None | Immediate |
| `undo_intent` | Reverse a previous action | Low | Immediate |

### Multi-account by default

Read tools (`search_threads`, `get_overview`, `get_audit_log`, `get_pending_actions`) fan out to every configured account unless you pass `account_ids: [...]` to scope them. Every response includes an envelope so the agent can see what was actually queried:

```json
{
  "accounts_searched": ["cameron@example.com", "cameron@me.com"],
  "accounts_available": ["cameron@example.com", "cameron@me.com"],
  "per_account_errors": { "cameron@me.com": "auth failed" },
  "results": [ ... ]
}
```

`per_account_errors` is only present when at least one account failed — the rest of the call still succeeds with partial results.

### Account-qualified targets

Tools that act on specific messages (`read_thread`, `label_thread`, `hold_messages`, `restore_messages`) take account-qualified `Target` references:

```json
{
  "targets": [
    { "account_id": "cameron@example.com", "uid": 1234 },
    { "account_id": "cameron@me.com", "uid": 5678, "mailbox": "Archive" }
  ]
}
```

`mailbox` defaults to `INBOX` per target. A single call can act across accounts; the executor groups by account internally.

### Dry-run hold

`hold_messages` accepts `dry_run: true` to preview what would happen without moving anything. The response shape is identical to a real run — same `total_messages`, same per-account/per-mailbox breakdown — so you can see the blast radius before committing. Dry-runs are recorded in the audit log (flagged with `dry_run: true`) but don't enter the undo ledger.

Pass `include_summary: true` (with or without `dry_run`) to receive a `moved` array with each message's `uid`, `account_id`, `subject`, `from`, and `original_mailbox` in the response.

### Partial restore with `get_intent`

After a `hold_messages` call you can restore just a subset of the held messages without undoing the whole batch:

1. Call `get_intent` with the hold's `intent_id`. The response lists every target with its captured `subject` and `from`.
2. Pick the UIDs you want to restore back to the inbox.
3. Call `restore_messages` with only those targets. The response includes `reversible: true` and `undo_hint.method === 'undo_intent'`.

`get_intent` also surfaces `reversed_by_intent_id` once a restore intent links back to the hold, so you can track the full reversal chain.

### Long bulk sweeps

`hold_messages` and `hold_by_sender` accept `background: true`. The call returns an `intent_id` right away and the move runs in the background:

```json
{
  "status": "executing",
  "intent_id": "3f9a…",
  "how_to_check": "Poll get_intent with intent_id \"3f9a…\" until status is \"executed\" or \"failed\".",
  "how_to_undo": "undo_intent with intent_id \"3f9a…\" once it reports \"executed\"."
}
```

Use it for full-history sweeps — anything with no `since` floor over a large mailbox, especially on iCloud. A synchronous call that outruns the client's patience gives you a timeout, and a timeout tells you nothing: the move may have completed with the response lost, or never have run at all. Worse, you get no `intent_id`, so the batch can't be undone. With `background: true` the id exists before any mail moves, so the outcome is always knowable and always reversible.

Targets are recorded in the ledger *before* each move and confirmed after, so even a sweep interrupted partway leaves a restorable record. `agent-mail status` lists any actions that died mid-execution, with the intent id to undo them.

## Policy

Edit `~/.agent-mail/policy.yaml` to customize which actions need approval. The default policy:

- **Ungated:** search, read, overview, draft, label, unsubscribe, pending-actions, audit-log, get-intent, restore, undo
- **Always gated:** send (every outbound email needs your approval)
- **Configurable:** hold (ungated by default, gated when the thread has replies)

Example: to require approval for all hold actions:

```yaml
hold_messages:
  risk: medium
  gate: always_gated
```

## Local cache

By default agent-mail reads everything over IMAP, live. That is correct but slow: IMAP has no aggregate operations, so a broad question ("what's still unanswered from June") costs one network round trip per account per query, and body search is either unavailable or unrankable.

The optional local cache mirrors your mail into a SQLite database on your Mac and serves searches from disk instead.

### What gets stored, and where

`~/.agent-mail/cache.db`, created `0600` inside the `0700` agent-mail directory. It holds message envelopes, flags, **full message bodies** (text and HTML), and attachment *metadata* — filename, type and size. Attachment payloads are not stored; `get_attachment` fetches those on demand.

Be aware of what that means: **two years of your full message bodies sit at rest in a file on your disk.** Nothing leaves your machine — the same local-first guarantee as the rest of agent-mail — but this is meaningfully more of your mail sitting in one readable place than before. Budget roughly 300–400 MB per account for a two-year window.

To delete it, stop the daemon and `rm ~/.agent-mail/cache.db`. Nothing is lost: the cache is derived from your mail server and rebuilds itself. The intent ledger, which is the actual record of what agents did, is a separate file and is untouched.

### Turning it on

Create `~/.agent-mail/cache.yaml`:

```yaml
cache:
  mode: shadow    # off (default) | shadow | on
```

- **`off`** — the cache is never read. The daemon still syncs it in the background, so it warms up.
- **`shadow`** — every search runs against both the cache and IMAP. IMAP's answer is what you get; the two are compared and any difference is logged to `~/.agent-mail/agent-mail.log`. Run here for a few days first.
- **`on`** — searches are served from the cache, falling back to IMAP when the cache is stale or a mailbox hasn't finished backfilling.

Shadow mode exists because the failure that matters for a mail cache is silently *missing* a message. Watch the log for `cache: shadow divergence` before switching to `on`.

### The daemon does the syncing

Sync runs in the background daemon, not in the MCP server — several MCP servers can be running at once (Claude Desktop, Claude Code, a CLI invocation), and each one syncing would duplicate every fetch. So the cache needs the daemon installed:

```bash
./bin/agent-mail.mjs install-daemon
```

If the daemon isn't running, searches report `cache.state: "stale"` and fall back to IMAP. Degraded, not broken.

### First sync

The first backfill walks your mail newest-first, so recent mail is searchable within seconds while older mail fills in behind it. Responses carry a coverage block so an agent can tell "nothing matched" from "nothing matched in what I have locally":

```json
"cache": {
  "state": "backfilling",
  "last_synced_at": "2026-07-31T18:04:11Z",
  "coverage": { "work": { "INBOX": { "complete": false, "oldest": "2025-02-14T…", "messages": 8412 } } }
}
```

Check progress any time with `./bin/agent-mail.mjs status`.

### Settings

```yaml
cache:
  mode: off

  # Entries starting with a backslash are IMAP special-use flags, resolved per
  # provider — Gmail's "[Gmail]/Sent Mail" and iCloud's "Sent Messages" both
  # match "\Sent".
  #
  # Gmail's All Mail ("\All") is excluded on purpose: it holds a near-copy of
  # every message, roughly doubling cache size and backfill time for very
  # little extra reach. Add "\All" if you want it anyway.
  mailboxes: [INBOX, "\Sent", "\Archive", agent-mail-holding]

  # How far back to backfill. null means your entire mail history — a
  # decade-old account can take hours and several GB.
  backfill_days: 730

  attachments: metadata          # none | metadata | full
  max_attachment_bytes: 26214400 # 25 MB
  sync_interval_seconds: 60
```

### Attachments

Attachment payloads are never cached, so `get_attachment` always fetches from the server. By default it writes the file to `~/.agent-mail/attachments/<date>/<random>/` and returns the path — your agent can open it with its own file tools, and a large PDF doesn't get base64'd into the conversation. Staged files are written `0600`, never executable regardless of type, and deleted after 7 days.

## Architecture

**Intent Ledger.** Every action is an intent stored in SQLite. Intents go through a lifecycle: `pending` → `approved` → `executing` → `executed` (or `rejected`, `failed`, `undone`). The `executing` intermediate status prevents duplicate execution on crash.

**Single executor.** One code path for all IMAP/SMTP operations, shared by the MCP server (for ungated tools) and the reviewer UI (for approved intents). No divergent behavior between the two entry points.

**IMAP threading.** Threads are reconstructed from `In-Reply-To` and `References` headers (RFC 2822). No provider-specific thread support needed.

**SQLite WAL.** Multiple processes (MCP server instances + reviewer UI) share one database file with WAL mode, `busy_timeout(5000)`, and `wal_autocheckpoint(1000)`.

**Local cache (optional).** A second SQLite database, `cache.db`, mirrors mail for fast local search with an FTS5 full-text index. It is strictly derived state: the daemon is its only writer, MCP servers open it read-only, and every mutation still executes against IMAP first. Deleting it loses nothing. See [Local cache](#local-cache).

## Development

```bash
npm test              # Run tests (vitest)
npm run typecheck     # TypeScript type checking
npm run audit         # Dependency vulnerability check
npm run validate      # Full local validation
npm run build         # Compile to dist/
```

## Uninstall

To remove the background daemon:

```bash
./bin/agent-mail.mjs uninstall-daemon
```

That stops cache syncing but leaves the cached mail on disk. To remove that too:

```bash
rm ~/.agent-mail/cache.db
rm -rf ~/.agent-mail/attachments
```

To remove local files after uninstalling the daemon:

```bash
rm -rf ~/.agent-mail
```

To remove the Claude Desktop integration, delete the `agent-mail` entry from `~/Library/Application Support/Claude/claude_desktop_config.json`.

To remove saved passwords from the macOS Keychain, run one command per configured account ID:

```bash
security delete-generic-password -s agent-mail -a <account-id>
```

## License

MIT
