# agent-mail

An MCP server that gives AI agents guardrailed access to your email on macOS. Works with Gmail, iCloud, and any standard IMAP account.

## What's different

Every other email MCP server gives agents raw access to your inbox. agent-mail reshapes the API surface so dangerous actions don't exist:

- **"Delete" becomes quarantine.** Messages move to a review folder. Reversible for 30 days.
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

Restart Claude Desktop. You should see agent-mail's 11 tools in the tool list.

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
| `get_overview` | Cross-account summary of recent mail that needs attention | None | Immediate |
| `draft_reply` | Create a draft (saved to Drafts, not sent) | Low | Immediate |
| `label_thread` | Add/remove IMAP flags on `targets: [{account_id, uid}]` | Low | Immediate |
| `unsubscribe_sender` | HTTP List-Unsubscribe (RFC 2369) | Low | Immediate |
| `get_pending_actions` | Check the approval queue (cross-account) | None | Immediate |
| `get_audit_log` | View action history (cross-account) | None | Immediate |
| `queue_send` | Queue an email for sending | High | **Always requires approval** |
| `quarantine_thread` | Move targets to quarantine; supports `dry_run: true` to preview | Medium | Configurable |
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

Tools that act on specific messages (`read_thread`, `label_thread`, `quarantine_thread`) take account-qualified `Target` references:

```json
{
  "targets": [
    { "account_id": "cameron@example.com", "uid": 1234 },
    { "account_id": "cameron@me.com", "uid": 5678, "mailbox": "Archive" }
  ]
}
```

`mailbox` defaults to `INBOX` per target. A single call can act across accounts; the executor groups by account internally.

### Dry-run quarantine

`quarantine_thread` accepts `dry_run: true` to preview what would happen without moving anything. The response shape is identical to a real run — same `total_messages`, same per-account/per-mailbox breakdown — so you can see the blast radius before committing. Dry-runs are recorded in the audit log (flagged with `dry_run: true`) but don't enter the undo ledger.

## Policy

Edit `~/.agent-mail/policy.yaml` to customize which actions need approval. The default policy:

- **Ungated:** search, read, overview, draft, label, unsubscribe, pending-actions, audit-log, undo
- **Always gated:** send (every outbound email needs your approval)
- **Configurable:** quarantine (ungated by default, gated when the thread has replies)

Example: to require approval for all quarantine actions:

```yaml
quarantine_thread:
  risk: medium
  gate: always_gated
```

## Architecture

**Intent Ledger.** Every action is an intent stored in SQLite. Intents go through a lifecycle: `pending` → `approved` → `executing` → `executed` (or `rejected`, `failed`, `undone`). The `executing` intermediate status prevents duplicate execution on crash.

**Single executor.** One code path for all IMAP/SMTP operations, shared by the MCP server (for ungated tools) and the reviewer UI (for approved intents). No divergent behavior between the two entry points.

**IMAP threading.** Threads are reconstructed from `In-Reply-To` and `References` headers (RFC 2822). No provider-specific thread support needed.

**SQLite WAL.** Multiple processes (MCP server instances + reviewer UI) share one database file with WAL mode, `busy_timeout(5000)`, and `wal_autocheckpoint(1000)`.

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
