# Approval UX Redesign

## Problem

The reviewer approval flow has three UX problems:

1. **Auth friction** — user must run a server, copy a 64-char bearer token from the filesystem, paste it into the UI, and repeat on refresh.
2. **Opaque pending intents** — items awaiting approval show tool names and raw JSON params instead of human-readable sender names, subjects, and email previews.
3. **Unreadable audit log** — events display raw action enums (`"executed"`, `"approved"`) with null detail fields, giving no indication of what was actually done.

## Design

### 1. Policy Engine: Reversible vs. Irreversible Actions

Add a `reversible` axis to the policy engine. Actions that can be undone are auto-approved; only irreversible actions require human approval via a gated intent.

| Tool | Action | Reversible? | Gate |
|------|--------|-------------|------|
| `move_message` | Move to any folder | Yes (move back) | `auto_approve` |
| `quarantine_thread` | Move to Quarantine folder | Yes (move back) | `auto_approve` |
| `archive_message` | Move to Archive | Yes (move back) | `auto_approve` |
| `label_message` | Add/remove label | Yes (remove/add) | `auto_approve` |
| `queue_send` | Send email | No | `always_gated` |
| `permanent_delete` | Delete from Quarantine | No | `always_gated` |

Auto-approved intents are still recorded in the intent ledger with full details (source folder, destination folder, message UIDs) — enough to reconstruct the undo action. The ledger is the safety net, not the gate.

### 2. Remove Bearer Token Auth

Since the reviewer server runs on localhost and is only accessible from the local machine, the network boundary is the auth boundary. Remove the bearer token requirement entirely:

- Delete `~/.agent-mail/reviewer-token` generation and file storage.
- Remove `authMiddleware` from POST/PUT/DELETE routes.
- Remove token prompt and localStorage persistence from the frontend.
- All API endpoints (GET and POST) are unauthenticated.

### 3. Notification Architecture

The reviewer server becomes a **launchd daemon** with two responsibilities:

1. **Watcher** — polls the SQLite intent ledger every 2-3 seconds for new gated intents. When one appears, fires a macOS notification via `node-notifier`.
2. **Web server** — Express app on `localhost:4242` (no auth). Serves detail pages when the user clicks a notification.

#### Notification flow: Send Email (gated)

```
New gated intent (queue_send) appears in ledger
  → Watcher detects it
  → macOS notification: "agent-mail: Send email to alice@example.com — Re: Meeting notes"
  → Click notification → opens localhost:4242/intent/<id>
  → Detail page: formatted email preview with editable To/Subject/Body, thread context, Approve/Reject buttons
  → User optionally edits the draft
  → Approve (with edits) → POST /api/intent/:id/approve with edited params
  → Executor sends the email
```

#### Notification flow: Batch Quarantine Review

```
Daily (configurable), watcher checks Quarantine folder item count
  → If items exist, fires notification: "agent-mail: 23 items in Quarantine — review?"
  → Click notification → opens localhost:4242/quarantine
  → Page fetches email headers (sender, subject, date) via IMAP from the Quarantine folder
  → Shows all items as a checklist, all checked by default (marked for deletion)
  → User unchecks items to rescue (moved back to original folder)
  → "Delete selected" → creates a gated intent for permanent_delete
  → Approve → items permanently deleted
```

The quarantine page can also be opened manually at any time via `localhost:4242/quarantine`.

#### Reversible action flow (no notification)

```
Agent calls move_message / quarantine_thread / archive / label
  → Policy engine evaluates: reversible → auto_approve
  → Intent created with status: executed (immediate)
  → Ledger records: tool, params (source folder, dest folder, UIDs), timestamp
  → No notification fired
  → User can query ledger or undo via conversation with Claude
```

### 4. Rich Detail Pages

#### Send Email Detail (`/intent/:id`)

When the user clicks a send-email notification, the detail page shows:

- **Header**: "Claude wants to send an email from you@gmail.com" + timestamp
- **Editable fields**: To, Subject, Body — pre-filled from intent params, user can modify before approving
- **Thread context**: "Replying to" section showing the original email's sender, date, and snippet (fetched via IMAP using `in_reply_to` header from intent params)
- **Actions**: Approve & Send (submits with any edits), Reject

Edits are submitted as updated params in the approve request. The executor sends the email with the edited content, not the original params.

#### Quarantine Review (`/quarantine`)

- **Header**: item count + age of oldest item
- **Checklist**: each quarantined item shows sender name, sender email, subject snippet, date. Checkbox is checked (= delete) by default.
- **Uncheck to rescue**: unchecked items are moved back to their original folder (recorded in ledger)
- **Status bar**: live count of selected vs. unchecked items
- **Actions**: Delete Selected (creates gated permanent_delete intent), Keep All

### 5. Audit Log: Human-Readable Events

Enrich the `detail` field at write time with a human-readable `summary` and key metadata:

| Intent | Action | Detail |
|--------|--------|--------|
| `queue_send` | executed | `{ summary: "Sent email to alice@example.com: Re: Meeting notes", to: "alice@example.com", subject: "Re: Meeting notes" }` |
| `quarantine_thread` | executed | `{ summary: "Quarantined 3 messages from linkedin.com", count: 3, sender_domain: "linkedin.com" }` |
| `permanent_delete` | executed | `{ summary: "Deleted 22 quarantined items", count: 22 }` |
| `move_message` | executed | `{ summary: "Moved 5 messages to Receipts", count: 5, destination: "Receipts" }` |
| Any | approved | `{ summary: "Approved: Send email to alice@example.com" }` |
| Any | rejected | `{ summary: "Rejected: Send email to alice@example.com", reason: "..." }` |

The audit log UI displays the `summary` as the primary text. The raw action enum becomes a secondary badge/status indicator.

Before: `executed by user (user@gmail.com) — Apr 14, 2:30 PM`

After: **Sent email to alice@example.com: Re: Meeting notes** — executed · Apr 14, 2:30 PM

### 6. Daemon Lifecycle

The reviewer daemon is managed via CLI commands:

- **`npx agent-mail install-daemon`** — writes launchd plist to `~/Library/LaunchAgents/com.agent-mail.reviewer.plist`, loads it. Starts on login, restarts on crash.
- **`npx agent-mail uninstall-daemon`** — unloads and removes the plist.
- **`npx agent-mail status`** — shows whether daemon is running, count of pending intents, last notification time.

The daemon runs the Express web server and ledger watcher in a single Node process. Logs to `~/.agent-mail/reviewer.log`, rotated by size.

## Out of Scope

- Browser push notifications (decided against — native macOS notifications are better fit)
- In-conversation approval (decided against — guardrails must be deterministic and outside Claude)
- Expiry-based auto-delete of quarantined items
- Cross-platform support (macOS only for now — launchd, node-notifier, osascript)
- Multi-user auth or remote access
