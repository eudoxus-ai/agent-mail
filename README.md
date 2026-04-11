# agent-mail

An MCP server that gives AI agents guardrailed access to your email. Works with Gmail, iCloud, and any standard IMAP account.

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

## Setup

### Prerequisites

- Node.js 20+
- App-specific passwords for Gmail and iCloud (not your regular password)
  - Gmail: [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
  - iCloud: [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security → App-Specific Passwords

### Install

```bash
git clone <repo-url> && cd agent-mail
npm install
```

### Add your email accounts

```bash
./bin/agent-mail.mjs add-account
```

This will prompt for your email address, auto-detect IMAP/SMTP hosts, ask for your password, and test the connection. Run it once per account.

Everything is stored at `~/.agent-mail/`:

```
~/.agent-mail/
  accounts.yaml      # Your email accounts (chmod 600)
  policy.yaml        # Risk tiers and gating rules
  ledger.db          # Intent ledger + audit log (SQLite)
  reviewer-token     # Bearer token for the reviewer UI
```

### Connect to Claude Desktop

Add this to your Claude Desktop MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

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

Restart Claude Desktop. You should see agent-mail's 10 tools in the tool list.

### Launch the reviewer UI

In a separate terminal:

```bash
./bin/agent-mail.mjs reviewer
```

Opens at `http://localhost:4242`. You'll need the bearer token (printed on startup, also at `~/.agent-mail/reviewer-token`) to approve or reject actions.

## Tools

| Tool | What it does | Risk | Gate |
|------|-------------|------|------|
| `search_threads` | Search emails across accounts | None | Immediate |
| `read_thread` | Read a message by UID | None | Immediate |
| `draft_reply` | Create a draft (saved to Drafts, not sent) | Low | Immediate |
| `label_thread` | Add/remove IMAP flags or move to folders | Low | Immediate |
| `unsubscribe_sender` | HTTP List-Unsubscribe (RFC 2369) | Low | Immediate |
| `get_pending_actions` | Check the approval queue | None | Immediate |
| `get_audit_log` | View action history | None | Immediate |
| `queue_send` | Queue an email for sending | High | **Always requires approval** |
| `quarantine_thread` | Move to quarantine (reversible delete) | Medium | Configurable |
| `undo_intent` | Reverse a previous action | Low | Immediate |

## Policy

Edit `~/.agent-mail/policy.yaml` to customize which actions need approval. The default policy:

- **Ungated:** search, read, draft, label, unsubscribe, undo
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
npm run build         # Compile to dist/
```

## License

MIT
