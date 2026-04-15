# Approval UX Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual copy-paste-token reviewer workflow with notification-driven approvals, auto-approve reversible actions, enrich the audit log with human-readable summaries, and add rich detail pages for send-email and quarantine review.

**Architecture:** The policy engine gains a `reversible` property per tool, allowing auto-approval of undoable actions while gating irreversible ones. The reviewer server becomes a launchd daemon that watches the intent ledger and fires macOS notifications via `node-notifier`. Bearer token auth is removed (localhost-only). Audit log events are enriched with human-readable summaries at write time.

**Tech Stack:** TypeScript, Express, SQLite (better-sqlite3), node-notifier, launchd, vitest

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/types.ts` | Add `reversible` field to `ToolPolicy` |
| `src/policy/defaults.ts` | Add `reversible: true/false` to each tool's policy YAML |
| `src/policy/engine.ts` | Return `reversible` in `PolicyResult` |
| `src/reviewer/auth.ts` | Delete (or gut) — remove token generation and middleware |
| `src/reviewer/app.ts` | Remove auth middleware from API routes, remove `token` dep |
| `src/reviewer/routes.ts` | Accept edited params on approve; add `/quarantine` route |
| `src/reviewer/static/index.html` | Remove auth bar; add intent detail and quarantine pages |
| `src/reviewer/static/app.js` | Remove token logic; add rich rendering, edit, quarantine UI |
| `src/cli/reviewer.ts` | Remove token loading/printing |
| `src/config.ts` | Remove `REVIEWER_TOKEN_PATH` |
| `src/ledger/audit-summary.ts` | **New** — `buildAuditSummary()` helper |
| `src/executor/executor.ts` | Pass enriched `detail` to every `logAudit` call |
| `src/reviewer/watcher.ts` | **New** — polls ledger for pending intents, fires notifications |
| `src/reviewer/daemon.ts` | **New** — combines watcher + Express server in one process |
| `src/cli/daemon.ts` | **New** — `install-daemon`, `uninstall-daemon`, `status` commands |
| `test/policy/engine.test.ts` | Tests for `reversible` field |
| `test/reviewer/app.test.ts` | Update to remove auth expectations |
| `test/ledger/audit-summary.test.ts` | **New** — tests for `buildAuditSummary()` |
| `test/reviewer/watcher.test.ts` | **New** — tests for notification watcher |

---

### Task 1: Add `reversible` to Policy Types and Defaults

**Files:**
- Modify: `src/types.ts:82-89`
- Modify: `src/policy/defaults.ts:4-45`
- Modify: `src/policy/engine.ts:28-70`
- Test: `test/policy/engine.test.ts`

- [ ] **Step 1: Write failing tests for `reversible` field in policy result**

Add to the bottom of `test/policy/engine.test.ts`:

```typescript
describe('reversible policy axis', () => {
  it('queue_send is not reversible', () => {
    const result = evaluatePolicy(policy, 'queue_send');
    expect(result.reversible).toBe(false);
  });

  it('quarantine_thread is reversible', () => {
    const result = evaluatePolicy(policy, 'quarantine_thread');
    expect(result.reversible).toBe(true);
  });

  it('label_thread is reversible', () => {
    const result = evaluatePolicy(policy, 'label_thread');
    expect(result.reversible).toBe(true);
  });

  it('unknown tools default to not reversible', () => {
    const result = evaluatePolicy(policy, 'nonexistent_tool');
    expect(result.reversible).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/policy/engine.test.ts`
Expected: FAIL — `reversible` property does not exist on `PolicyResult`

- [ ] **Step 3: Add `reversible` to types**

In `src/types.ts`, add `reversible` to `PolicyResult` and `ToolPolicy`:

```typescript
// Replace the PolicyResult interface (lines 76-80):
export interface PolicyResult {
  decision: PolicyDecision;
  risk: RiskLevel;
  reason: string;
  reversible: boolean;
}

// Replace the ToolPolicy interface (lines 82-89):
export interface ToolPolicy {
  risk: RiskLevel;
  gate: GateType;
  default?: 'ungated' | 'approval_required';
  override?: Record<string, 'approval_required' | 'ungated'>;
  note?: string;
  auto_approve_after?: number | null;
  reversible?: boolean;
}
```

- [ ] **Step 4: Add `reversible` to default policy YAML**

In `src/policy/defaults.ts`, replace the `DEFAULT_POLICY_YAML` string with:

```typescript
export const DEFAULT_POLICY_YAML = `# agent-mail policy configuration
# Risk levels: none, low, medium, high
# Gate types: ungated, configurable, always_gated
# reversible: whether the action can be undone (defaults to false)

tools:
  search_threads:      { risk: none, gate: ungated, reversible: false }
  read_thread:         { risk: none, gate: ungated, reversible: false }
  get_overview:        { risk: none, gate: ungated, reversible: false }
  draft_reply:         { risk: low, gate: ungated, reversible: false }
  label_thread:        { risk: low, gate: ungated, reversible: true }
  get_pending_actions: { risk: none, gate: ungated, reversible: false }
  get_audit_log:       { risk: none, gate: ungated, reversible: false }
  undo_intent:         { risk: low, gate: ungated, reversible: false }

  unsubscribe_sender:
    risk: low
    gate: ungated
    reversible: false
    note: "HTTP List-Unsubscribe only. Mailto-based unsubscribes route through queue_send."

  quarantine_thread:
    risk: medium
    gate: configurable
    default: ungated
    reversible: true
    override:
      when_thread_has_replies: approval_required

  queue_send:
    risk: high
    gate: always_gated
    reversible: false
    auto_approve_after: null

notifications:
  channels:
    - type: system_notification
      enabled: true
`;
```

- [ ] **Step 5: Update `evaluatePolicy` to return `reversible`**

In `src/policy/engine.ts`, update the function. Every `return` statement needs `reversible` added. The value comes from `(toolPolicy as ToolPolicy).reversible ?? false`, or `false` for unknown tools:

```typescript
export function evaluatePolicy(
  policy: PolicyConfig,
  toolName: string,
  context?: PolicyContext
): PolicyResult {
  const toolPolicy = policy.tools[toolName] as ToolPolicy | undefined;

  if (!toolPolicy) {
    return { decision: 'gate', risk: 'high', reason: 'Unknown tool, gating by default', reversible: false };
  }

  const risk = toolPolicy.risk;
  const gate: GateType = toolPolicy.gate;
  const reversible = toolPolicy.reversible ?? false;

  if (gate === 'ungated') {
    return { decision: 'execute', risk, reason: 'Policy: ungated', reversible };
  }

  if (gate === 'always_gated') {
    return { decision: 'gate', risk, reason: 'Policy: always gated', reversible };
  }

  // gate === 'configurable'
  const defaultGate = toolPolicy.default ?? 'ungated';
  const overrides = toolPolicy.override ?? {};

  for (const [condition, result] of Object.entries(overrides)) {
    if (condition === 'when_thread_has_replies' && context?.threadHasReplies) {
      if (result === 'approval_required') {
        return { decision: 'gate', risk, reason: `Override: ${condition}`, reversible };
      }
    }
  }

  if (defaultGate === 'approval_required') {
    return { decision: 'gate', risk, reason: 'Policy: configurable, default gated', reversible };
  }

  return { decision: 'execute', risk, reason: 'Policy: configurable, default ungated', reversible };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/policy/engine.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/policy/defaults.ts src/policy/engine.ts test/policy/engine.test.ts
git commit -m "feat: add reversible axis to policy engine"
```

---

### Task 2: Remove Bearer Token Auth

**Files:**
- Modify: `src/reviewer/auth.ts`
- Modify: `src/reviewer/app.ts:12-58`
- Modify: `src/cli/reviewer.ts:11-52`
- Modify: `src/config.ts:9`
- Modify: `src/reviewer/static/index.html`
- Modify: `src/reviewer/static/app.js`
- Test: `test/reviewer/app.test.ts`

- [ ] **Step 1: Write failing test — API should be accessible without auth**

Replace the entire test in `test/reviewer/app.test.ts`:

```typescript
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { openDatabase } from '../../src/ledger/db.js';
import { createReviewerApp } from '../../src/reviewer/app.js';
import { createLogger } from '../../src/logger.js';

let server: Server | null = null;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    server = null;
  }
});

describe('reviewer app', () => {
  it('allows unauthenticated access to all API routes', async () => {
    const db = openDatabase(':memory:');
    const app = createReviewerApp({
      db,
      executor: {
        approveAndExecute: async () => {
          throw new Error('not used');
        },
        rejectIntent: async () => {
          throw new Error('not used');
        },
      } as any,
      logger: createLogger('cli', { minLevel: 'error' }),
    });

    server = await new Promise<Server>((resolve) => {
      const started = app.listen(0, '127.0.0.1', () => resolve(started));
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve reviewer test server address');
    }

    const baseUrl = `http://127.0.0.1:${address.port}`;

    const shell = await fetch(baseUrl);
    expect(shell.status).toBe(200);

    const pending = await fetch(`${baseUrl}/api/pending`);
    expect(pending.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/reviewer/app.test.ts`
Expected: FAIL — `createReviewerApp` expects a `token` property

- [ ] **Step 3: Gut `src/reviewer/auth.ts`**

Remove everything except `authMiddleware` export (which may be imported elsewhere). Replace the entire file with:

```typescript
// Auth removed — localhost-only server, network boundary is the auth boundary.
// This file is kept as a placeholder to avoid broken imports during transition.
```

- [ ] **Step 4: Update `src/reviewer/app.ts` — remove auth middleware and `token` dep**

Replace the `createReviewerApp` function signature and the auth middleware line:

```typescript
export function createReviewerApp(deps: {
  db: Database;
  executor: Executor;
  logger: Logger;
}): express.Application {
```

And replace the API route line (line 34):

```typescript
  // API routes — no auth (localhost-only)
  app.use('/api', createRouter(deps));
```

Remove the `import { authMiddleware } from './auth.js';` line and the `token` parameter.

- [ ] **Step 5: Update `src/cli/reviewer.ts` — remove token loading**

Replace the `startReviewer` function body. Remove the `loadReviewerToken` import and `token` usage:

```typescript
import { existsSync } from 'node:fs';
import { openDatabase } from '../ledger/db.js';
import { loadAccounts } from '../provider/accounts.js';
import { ImapConnectionPool } from '../provider/imap-pool.js';
import { Executor } from '../executor/executor.js';
import { createReviewerApp } from '../reviewer/app.js';
import { createLogger } from '../logger.js';
import { ACCOUNTS_YAML_PATH, LEDGER_DB_PATH } from '../config.js';

export async function startReviewer(port: number = 4242): Promise<void> {
  const logger = createLogger('cli');
  const host = '127.0.0.1';

  if (!existsSync(ACCOUNTS_YAML_PATH)) {
    logger.error(
      "No accounts configured. Run 'npx agent-mail add-account' first."
    );
    process.exit(1);
  }

  if (!existsSync(LEDGER_DB_PATH)) {
    logger.error(
      "No database found. Run 'npx agent-mail add-account' first."
    );
    process.exit(1);
  }

  const db = openDatabase();
  const accounts = loadAccounts();
  const pool = new ImapConnectionPool({ accounts, logger });
  const executor = new Executor({ db, accounts, pool, logger });
  const app = createReviewerApp({ db, executor, logger });

  const shutdown = async (code = 0) => {
    try {
      await pool.closeAll();
    } catch {
      // best-effort
    }
    process.exit(code);
  };
  process.once('SIGINT', () => void shutdown(0));
  process.once('SIGTERM', () => void shutdown(0));

  app.listen(port, host, () => {
    logger.info(`agent-mail reviewer running at http://${host}:${port}`);
    logger.info(`${accounts.length} account(s) configured`);
  });
}
```

- [ ] **Step 6: Remove `REVIEWER_TOKEN_PATH` from `src/config.ts`**

Delete line 9: `export const REVIEWER_TOKEN_PATH = join(AGENT_MAIL_DIR, 'reviewer-token');`

- [ ] **Step 7: Remove auth bar from `src/reviewer/static/index.html`**

Remove the auth-bar div and the subtitle below it (lines 16-22). The file should go from `</header>` directly to `<div class="tabs">`:

```html
    </header>

    <div class="tabs">
```

- [ ] **Step 8: Remove token logic from `src/reviewer/static/app.js`**

Remove:
- Line 1: `let bearerToken = '';`
- The `setToken()` function (lines 62-67)
- The `apiFetch` helper — replace with a simpler version that doesn't add Authorization headers:

```javascript
async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(path, { ...options, headers });
}
```

- The `bearerToken` check in the auto-refresh interval (lines 284-291) — remove the `bearerToken &&` condition:

```javascript
setInterval(() => {
  if (document.getElementById('pending-tab').classList.contains('active')) {
    void loadPending();
  }
}, 5000);
```

- The Enter key handler for the token input (lines 267-272)
- Any `if (!bearerToken)` guards in `loadPending`, `loadAudit`, etc.

- [ ] **Step 9: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS. If any tests reference `token` or auth, fix them.

- [ ] **Step 10: Commit**

```bash
git add src/reviewer/auth.ts src/reviewer/app.ts src/cli/reviewer.ts src/config.ts src/reviewer/static/index.html src/reviewer/static/app.js test/reviewer/app.test.ts
git commit -m "feat: remove bearer token auth (localhost-only)"
```

---

### Task 3: Enrich Audit Log with Human-Readable Summaries

**Files:**
- Create: `src/ledger/audit-summary.ts`
- Modify: `src/executor/executor.ts`
- Test: `test/ledger/audit-summary.test.ts`

- [ ] **Step 1: Write failing tests for `buildAuditSummary`**

Create `test/ledger/audit-summary.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildAuditSummary } from '../../src/ledger/audit-summary.js';

describe('buildAuditSummary', () => {
  it('summarizes queue_send execution', () => {
    const detail = buildAuditSummary('queue_send', 'executed', {
      to: 'alice@example.com',
      subject: 'Re: Meeting notes',
      body: 'Thanks for the update.',
    });
    expect(detail.summary).toBe('Sent email to alice@example.com: Re: Meeting notes');
    expect(detail.to).toBe('alice@example.com');
    expect(detail.subject).toBe('Re: Meeting notes');
  });

  it('summarizes queue_send approval', () => {
    const detail = buildAuditSummary('queue_send', 'approved', {
      to: 'alice@example.com',
      subject: 'Re: Meeting notes',
    });
    expect(detail.summary).toBe('Approved: Send email to alice@example.com: Re: Meeting notes');
  });

  it('summarizes queue_send rejection', () => {
    const detail = buildAuditSummary('queue_send', 'rejected', {
      to: 'alice@example.com',
      subject: 'Re: Meeting notes',
    });
    expect(detail.summary).toBe('Rejected: Send email to alice@example.com: Re: Meeting notes');
  });

  it('summarizes quarantine_thread execution', () => {
    const detail = buildAuditSummary('quarantine_thread', 'executed', {
      uids: [1, 2, 3],
      mailbox: 'INBOX',
    });
    expect(detail.summary).toBe('Quarantined 3 messages from INBOX');
    expect(detail.count).toBe(3);
  });

  it('summarizes label_thread execution', () => {
    const detail = buildAuditSummary('label_thread', 'executed', {
      label: 'Important',
      thread_id: 'abc123',
    });
    expect(detail.summary).toContain('Important');
  });

  it('summarizes unknown tool execution', () => {
    const detail = buildAuditSummary('unknown_tool', 'executed', {});
    expect(detail.summary).toBe('Executed: unknown_tool');
  });

  it('includes error in failed summary', () => {
    const detail = buildAuditSummary('queue_send', 'failed', {
      to: 'alice@example.com',
      subject: 'Test',
    }, { message: 'SMTP connection refused' });
    expect(detail.summary).toContain('Failed');
    expect(detail.error).toBe('SMTP connection refused');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/ledger/audit-summary.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `buildAuditSummary`**

Create `src/ledger/audit-summary.ts`:

```typescript
import type { AuditAction } from '../types.js';

export function buildAuditSummary(
  tool: string,
  action: AuditAction,
  params: Record<string, unknown>,
  errorDetail?: { message: string }
): Record<string, unknown> {
  const to = params.to as string | undefined;
  const subject = params.subject as string | undefined;
  const uids = params.uids as number[] | undefined;
  const mailbox = params.mailbox as string | undefined;
  const label = params.label as string | undefined;

  if (action === 'failed') {
    const base = describeIntent(tool, params);
    return {
      summary: `Failed: ${base}`,
      error: errorDetail?.message ?? 'Unknown error',
    };
  }

  if (action === 'approved') {
    const base = describeIntent(tool, params);
    return { summary: `Approved: ${base}` };
  }

  if (action === 'rejected') {
    const base = describeIntent(tool, params);
    return { summary: `Rejected: ${base}` };
  }

  // 'created', 'executing', 'executed', 'undone'
  switch (tool) {
    case 'queue_send':
      return {
        summary: `Sent email to ${to ?? 'unknown'}: ${subject ?? '(no subject)'}`,
        to,
        subject,
      };

    case 'quarantine_thread': {
      const count = uids?.length ?? 0;
      return {
        summary: `Quarantined ${count} message${count !== 1 ? 's' : ''} from ${mailbox ?? 'INBOX'}`,
        count,
        mailbox: mailbox ?? 'INBOX',
      };
    }

    case 'label_thread':
      return {
        summary: `Labeled thread: ${label ?? 'unknown'}`,
        label,
      };

    default:
      return {
        summary: `Executed: ${tool}`,
      };
  }
}

function describeIntent(tool: string, params: Record<string, unknown>): string {
  const to = params.to as string | undefined;
  const subject = params.subject as string | undefined;

  switch (tool) {
    case 'queue_send':
      return `Send email to ${to ?? 'unknown'}: ${subject ?? '(no subject)'}`;
    case 'quarantine_thread': {
      const uids = params.uids as number[] | undefined;
      const count = uids?.length ?? 0;
      return `Quarantine ${count} message${count !== 1 ? 's' : ''}`;
    }
    case 'label_thread':
      return `Label thread: ${params.label ?? 'unknown'}`;
    default:
      return tool;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/ledger/audit-summary.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Wire `buildAuditSummary` into `executor.ts`**

In `src/executor/executor.ts`, add the import at the top:

```typescript
import { buildAuditSummary } from '../ledger/audit-summary.js';
```

Then update every `logAudit` call in `approveAndExecute()` (around lines 173-226) to include enriched detail. For example:

The `'approved'` audit call (around line 173):
```typescript
    logAudit(this.db, {
      intent_id: intentId,
      account_id: current.account_id,
      action: 'approved',
      actor: 'user',
      detail: buildAuditSummary(current.tool, 'approved', current.params),
    });
```

The `'executing'` audit call (around line 179):
```typescript
    logAudit(this.db, {
      intent_id: intentId,
      account_id: current.account_id,
      action: 'executing',
      actor: 'user',
      detail: buildAuditSummary(current.tool, 'executing', current.params),
    });
```

The `'executed'` audit call (around line 205):
```typescript
    logAudit(this.db, {
      intent_id: intentId,
      account_id: intent.account_id,
      action: 'executed',
      actor: 'user',
      detail: buildAuditSummary(intent.tool, 'executed', intent.params),
    });
```

The `'failed'` audit call (around line 220):
```typescript
    logAudit(this.db, {
      intent_id: intentId,
      account_id: intent.account_id,
      action: 'failed',
      actor: 'user',
      detail: buildAuditSummary(intent.tool, 'failed', intent.params, errorDetail),
    });
```

Do the same for `executeImmediate()` (around lines 73-117) — update the `'created'`, `'executing'`, `'executed'`, and `'failed'` audit calls.

And for `createGatedIntent()` (around lines 139-145):
```typescript
    logAudit(this.db, {
      intent_id: intent.id,
      account_id: params.accountId,
      action: 'created',
      actor: params.agentId,
      detail: buildAuditSummary(params.tool, 'created', params.toolParams),
    });
```

And for `rejectIntent()` (around lines 250-256):
```typescript
    logAudit(this.db, {
      intent_id: intentId,
      account_id: intent.account_id,
      action: 'rejected',
      actor: 'user',
      detail: {
        ...buildAuditSummary(intent.tool, 'rejected', intent.params),
        ...(reason ? { reason } : {}),
      },
    });
```

And for `undoIntent()` (around lines 321-326):
```typescript
    logAudit(this.db, {
      intent_id: intentId,
      account_id: intent.account_id,
      action: 'undone',
      actor: 'user',
      detail: buildAuditSummary(intent.tool, 'undone', intent.params),
    });
```

- [ ] **Step 6: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/ledger/audit-summary.ts src/executor/executor.ts test/ledger/audit-summary.test.ts
git commit -m "feat: enrich audit log with human-readable summaries"
```

---

### Task 4: Rich Pending Intent Cards (Frontend)

**Files:**
- Modify: `src/reviewer/static/app.js`
- Modify: `src/reviewer/static/styles.css` (if needed)

- [ ] **Step 1: Update `renderPendingIntents` to show rich cards**

Replace the `renderPendingIntents` function in `src/reviewer/static/app.js` with a version that extracts and formats params by tool type:

```javascript
function renderPendingIntents(intents) {
  const list = document.getElementById('pending-list');
  if (intents.length === 0) {
    appendEmptyState(list, 'No pending actions');
    return;
  }

  clearElement(list);
  intents.forEach((intent) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.id = `card-${intent.id}`;

    const header = document.createElement('div');
    header.className = 'card-header';
    header.appendChild(createBadge(intent.tool, 'none'));
    header.appendChild(createBadge(intent.risk, intent.risk));
    card.appendChild(header);

    // Rich title based on tool type
    const title = formatIntentTitle(intent);
    appendText(card, 'card-title', title);

    // Rich detail based on tool type
    const detailEl = document.createElement('div');
    detailEl.className = 'card-detail';
    detailEl.innerHTML = formatIntentDetail(intent);
    card.appendChild(detailEl);

    appendText(
      card,
      'card-meta',
      `${intent.account_id} · ${new Date(intent.created_at).toLocaleString()}`
    );

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const approveButton = document.createElement('button');
    approveButton.className = 'btn btn-approve';
    approveButton.type = 'button';
    approveButton.textContent = 'Approve';
    approveButton.addEventListener('click', () => {
      void approveIntent(intent.id);
    });
    actions.appendChild(approveButton);

    const rejectButton = document.createElement('button');
    rejectButton.className = 'btn btn-reject';
    rejectButton.type = 'button';
    rejectButton.textContent = 'Reject';
    rejectButton.addEventListener('click', () => {
      void rejectIntent(intent.id);
    });
    actions.appendChild(rejectButton);

    card.appendChild(actions);
    list.appendChild(card);
  });
}

function formatIntentTitle(intent) {
  const p = intent.params;
  switch (intent.tool) {
    case 'queue_send':
      return `Send email to ${p.to || 'unknown'}`;
    case 'quarantine_thread': {
      const count = Array.isArray(p.uids) ? p.uids.length : 0;
      return `Quarantine ${count} message${count !== 1 ? 's' : ''}`;
    }
    case 'permanent_delete': {
      const count = Array.isArray(p.uids) ? p.uids.length : 0;
      return `Permanently delete ${count} item${count !== 1 ? 's' : ''}`;
    }
    default:
      return `${intent.tool} on ${intent.account_id}`;
  }
}

function formatIntentDetail(intent) {
  const p = intent.params;
  switch (intent.tool) {
    case 'queue_send':
      return `<div class="intent-field"><span class="field-label">Subject:</span> ${escapeHtml(p.subject || '(no subject)')}</div>`
        + `<div class="intent-field"><span class="field-label">Body:</span></div>`
        + `<div class="intent-body">${escapeHtml(p.body || '').substring(0, 500)}</div>`;
    default:
      return `<pre>${escapeHtml(JSON.stringify(p, null, 2))}</pre>`;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
```

- [ ] **Step 2: Update `renderAuditLog` to show summaries**

Replace the `renderAuditLog` function in `src/reviewer/static/app.js`:

```javascript
function renderAuditLog(entries) {
  const list = document.getElementById('audit-list');
  if (entries.length === 0) {
    appendEmptyState(list, 'No audit log entries');
    return;
  }

  clearElement(list);
  entries.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'audit-row';

    const left = document.createElement('span');

    // Use summary from detail if available, otherwise fall back to action
    const summary = entry.detail?.summary;
    if (summary) {
      const summaryEl = document.createElement('strong');
      summaryEl.textContent = summary;
      left.appendChild(summaryEl);

      const action = document.createElement('span');
      action.className = 'audit-action';
      action.textContent = ` · ${entry.action}`;
      left.appendChild(action);
    } else {
      const action = document.createElement('span');
      action.className = 'audit-action';
      action.textContent = entry.action;
      left.appendChild(action);
      left.appendChild(
        document.createTextNode(
          ` by ${entry.actor}${entry.account_id ? ` (${entry.account_id})` : ''}`
        )
      );
    }

    const right = document.createElement('span');
    right.className = 'audit-time';
    right.textContent = new Date(entry.created_at).toLocaleString();

    row.appendChild(left);
    row.appendChild(right);
    list.appendChild(row);
  });
}
```

- [ ] **Step 3: Test manually**

Run: `npx tsx src/index.ts reviewer`
Open: `http://127.0.0.1:4242`
Verify: Pending intents show rich titles/details, audit log shows summaries.

- [ ] **Step 4: Commit**

```bash
git add src/reviewer/static/app.js src/reviewer/static/styles.css
git commit -m "feat: rich pending intent cards and audit log summaries"
```

---

### Task 5: Approve with Edited Params

**Files:**
- Modify: `src/reviewer/routes.ts:43-56`
- Modify: `src/executor/executor.ts` (approveAndExecute)
- Modify: `src/reviewer/static/app.js`
- Test: `test/executor/executor.test.ts`

- [ ] **Step 1: Write failing test — approveAndExecute accepts edited params**

Read `test/executor/executor.test.ts` to understand the existing test patterns, then add a test. The test should verify that when edited params are passed to `approveAndExecute`, the intent's params are updated before execution.

Add to `test/executor/executor.test.ts`:

```typescript
it('approveAndExecute uses edited params when provided', async () => {
  // Create a gated intent with original params
  const intent = await executor.createGatedIntent({
    tool: 'queue_send',
    toolParams: { to: 'alice@example.com', subject: 'Original', body: 'Original body' },
    accountId: testAccountId,
    agentId: 'claude',
    risk: 'high',
  });

  // Approve with edited params
  const result = await executor.approveAndExecute(intent.id, {
    to: 'alice@example.com',
    subject: 'Edited subject',
    body: 'Edited body',
  });

  expect(result.params.subject).toBe('Edited subject');
  expect(result.params.body).toBe('Edited body');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/executor/executor.test.ts -t "edited params"`
Expected: FAIL — `approveAndExecute` doesn't accept a second argument

- [ ] **Step 3: Update `approveAndExecute` to accept optional edited params**

In `src/executor/executor.ts`, change the signature of `approveAndExecute`:

```typescript
async approveAndExecute(
  intentId: string,
  editedParams?: Record<string, unknown>
): Promise<Intent> {
```

Inside the transaction, after fetching `current`, if `editedParams` is provided, update the intent's params in the database:

```typescript
    // If reviewer edited the params, update them before execution
    if (editedParams) {
      this.db.prepare('UPDATE intents SET params = ? WHERE id = ?')
        .run(JSON.stringify(editedParams), intentId);
    }
```

This should go after the `claimed` check and before the `logAudit` calls.

- [ ] **Step 4: Update the approve route to pass request body params**

In `src/reviewer/routes.ts`, update the approve handler:

```typescript
router.post('/intent/:id/approve', async (req, res) => {
  try {
    const editedParams = req.body?.params as Record<string, unknown> | undefined;
    const intent = await deps.executor.approveAndExecute(req.params.id, editedParams);
    res.json(intent);
  } catch (error) {
    deps.logger.error('Approve failed', {
      id: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(400).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/executor/executor.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/executor/executor.ts src/reviewer/routes.ts test/executor/executor.test.ts
git commit -m "feat: support edited params on intent approval"
```

---

### Task 6: Send Email Detail Page with Edit

**Files:**
- Modify: `src/reviewer/static/app.js`
- Modify: `src/reviewer/static/index.html`
- Modify: `src/reviewer/routes.ts` (add intent detail route)

- [ ] **Step 1: Add intent detail view to `index.html`**

Add a new tab-content div after the stuck tab (before the closing `</div>` of `.container`):

```html
    <div id="intent-detail-tab" class="tab-content">
      <div id="intent-detail"></div>
    </div>
```

- [ ] **Step 2: Add intent detail rendering to `app.js`**

Add a function to render the send-email detail page with editable fields:

```javascript
function showIntentDetail(intent) {
  // Hide tabs, show detail view
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  document.getElementById('intent-detail-tab').classList.add('active');

  const container = document.getElementById('intent-detail');
  clearElement(container);

  const backBtn = document.createElement('button');
  backBtn.className = 'btn';
  backBtn.textContent = '\u2190 Back to Pending';
  backBtn.addEventListener('click', () => {
    document.getElementById('intent-detail-tab').classList.remove('active');
    document.querySelector('[data-tab="pending"]').click();
  });
  container.appendChild(backBtn);

  const p = intent.params;

  if (intent.tool === 'queue_send') {
    const header = document.createElement('div');
    header.className = 'detail-header';
    header.innerHTML = `<span>Send email from <strong>${escapeHtml(intent.account_id)}</strong></span>
      <span class="audit-time">${new Date(intent.created_at).toLocaleString()}</span>`;
    container.appendChild(header);

    const form = document.createElement('div');
    form.className = 'detail-form';
    form.innerHTML = `
      <div class="detail-field">
        <label>To</label>
        <input type="text" id="edit-to" value="${escapeHtml(p.to || '')}">
      </div>
      <div class="detail-field">
        <label>Subject</label>
        <input type="text" id="edit-subject" value="${escapeHtml(p.subject || '')}">
      </div>
      <div class="detail-field">
        <label>Body</label>
        <textarea id="edit-body" rows="10">${escapeHtml(p.body || '')}</textarea>
      </div>
    `;
    container.appendChild(form);

    if (p.in_reply_to) {
      const replyCtx = document.createElement('div');
      replyCtx.className = 'reply-context';
      replyCtx.innerHTML = `<div class="field-label">Replying to</div>
        <div class="reply-snippet">${escapeHtml(p.in_reply_to)}</div>`;
      container.appendChild(replyCtx);
    }

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'btn btn-reject';
    rejectBtn.textContent = 'Reject';
    rejectBtn.addEventListener('click', async () => {
      await rejectIntent(intent.id);
      document.querySelector('[data-tab="pending"]').click();
    });

    const approveBtn = document.createElement('button');
    approveBtn.className = 'btn btn-approve';
    approveBtn.textContent = 'Approve & Send';
    approveBtn.addEventListener('click', async () => {
      const editedParams = {
        ...p,
        to: document.getElementById('edit-to').value,
        subject: document.getElementById('edit-subject').value,
        body: document.getElementById('edit-body').value,
      };
      await approveIntentWithParams(intent.id, editedParams);
      document.querySelector('[data-tab="pending"]').click();
    });

    actions.appendChild(rejectBtn);
    actions.appendChild(approveBtn);
    container.appendChild(actions);
  } else {
    // Generic detail for non-send intents
    appendText(container, 'card-title', formatIntentTitle(intent));
    appendText(container, 'card-detail', JSON.stringify(intent.params, null, 2));

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'btn btn-reject';
    rejectBtn.textContent = 'Reject';
    rejectBtn.addEventListener('click', async () => {
      await rejectIntent(intent.id);
      document.querySelector('[data-tab="pending"]').click();
    });

    const approveBtn = document.createElement('button');
    approveBtn.className = 'btn btn-approve';
    approveBtn.textContent = 'Approve';
    approveBtn.addEventListener('click', async () => {
      await approveIntent(intent.id);
      document.querySelector('[data-tab="pending"]').click();
    });

    actions.appendChild(rejectBtn);
    actions.appendChild(approveBtn);
    container.appendChild(actions);
  }
}

async function approveIntentWithParams(id, params) {
  try {
    const res = await apiFetch(`/api/intent/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ params }),
    });
    if (!res.ok) {
      const err = await res.json();
      alert(`Approve failed: ${err.error}`);
      return;
    }
    await loadPending();
  } catch (error) {
    alert(`Error: ${formatError(error)}`);
  }
}
```

- [ ] **Step 3: Wire pending cards to open detail view on click**

Update `renderPendingIntents` so clicking the card title opens the detail view:

```javascript
    // Replace the simple appendText for the title with:
    const titleEl = document.createElement('div');
    titleEl.className = 'card-title card-title-link';
    titleEl.textContent = title;
    titleEl.addEventListener('click', () => showIntentDetail(intent));
    card.appendChild(titleEl);
```

- [ ] **Step 4: Test manually**

Run: `npx tsx src/index.ts reviewer`
Open: `http://127.0.0.1:4242`
Create a pending `queue_send` intent via MCP, then click the card title. Verify: editable fields appear, Approve & Send submits edited params.

- [ ] **Step 5: Commit**

```bash
git add src/reviewer/static/app.js src/reviewer/static/index.html
git commit -m "feat: send-email detail page with editable draft"
```

---

### Task 7: Notification Watcher

**Files:**
- Create: `src/reviewer/watcher.ts`
- Test: `test/reviewer/watcher.test.ts`

- [ ] **Step 1: Install `node-notifier`**

```bash
npm install node-notifier
npm install --save-dev @types/node-notifier
```

- [ ] **Step 2: Write failing tests for watcher**

Create `test/reviewer/watcher.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import { createIntent } from '../../src/ledger/intents.js';
import type { Database } from '../../src/ledger/sqlite.js';
import { IntentWatcher } from '../../src/reviewer/watcher.js';

let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:');
});

describe('IntentWatcher', () => {
  it('detects new pending intents', async () => {
    const notified: string[] = [];
    const watcher = new IntentWatcher({
      db,
      pollingIntervalMs: 50,
      onNewIntent: (intent) => { notified.push(intent.id); },
    });

    watcher.start();

    // Create a pending intent after watcher starts
    const intent = createIntent(db, {
      account_id: 'test@gmail.com',
      tool: 'queue_send',
      params: { to: 'alice@example.com', subject: 'Test' },
      risk: 'high',
    });

    // Wait for polling cycle
    await new Promise(r => setTimeout(r, 150));

    watcher.stop();
    expect(notified).toContain(intent.id);
  });

  it('does not re-notify for already-seen intents', async () => {
    const notified: string[] = [];
    const watcher = new IntentWatcher({
      db,
      pollingIntervalMs: 50,
      onNewIntent: (intent) => { notified.push(intent.id); },
    });

    createIntent(db, {
      account_id: 'test@gmail.com',
      tool: 'queue_send',
      params: { to: 'alice@example.com', subject: 'Test' },
      risk: 'high',
    });

    watcher.start();

    // Wait for two polling cycles
    await new Promise(r => setTimeout(r, 200));

    watcher.stop();

    // Should only be notified once
    expect(notified).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/reviewer/watcher.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement `IntentWatcher`**

Create `src/reviewer/watcher.ts`:

```typescript
import type { Database } from '../ledger/sqlite.js';
import type { Intent } from '../types.js';
import { getPendingIntents } from '../ledger/intents.js';

export interface WatcherOptions {
  db: Database;
  pollingIntervalMs?: number;
  onNewIntent: (intent: Intent) => void;
}

export class IntentWatcher {
  private db: Database;
  private intervalMs: number;
  private onNewIntent: (intent: Intent) => void;
  private seenIds = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: WatcherOptions) {
    this.db = options.db;
    this.intervalMs = options.pollingIntervalMs ?? 3000;
    this.onNewIntent = options.onNewIntent;
  }

  start(): void {
    // Seed seen set with current pending intents (don't notify for pre-existing)
    const existing = getPendingIntents(this.db);
    for (const intent of existing) {
      this.seenIds.add(intent.id);
    }

    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private poll(): void {
    const pending = getPendingIntents(this.db);
    for (const intent of pending) {
      if (!this.seenIds.has(intent.id)) {
        this.seenIds.add(intent.id);
        this.onNewIntent(intent);
      }
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/reviewer/watcher.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/reviewer/watcher.ts test/reviewer/watcher.test.ts package.json package-lock.json
git commit -m "feat: intent watcher with polling and notification callback"
```

---

### Task 8: Notification Firing via node-notifier

**Files:**
- Create: `src/reviewer/notify.ts`

- [ ] **Step 1: Create notification helper**

Create `src/reviewer/notify.ts`:

```typescript
import notifier from 'node-notifier';
import type { Intent } from '../types.js';
import { buildAuditSummary } from '../ledger/audit-summary.js';

const REVIEWER_PORT = 4242;

export function notifyIntent(intent: Intent): void {
  const detail = buildAuditSummary(intent.tool, 'created', intent.params);
  const summary = (detail.summary as string) ?? `${intent.tool} on ${intent.account_id}`;

  notifier.notify({
    title: 'agent-mail',
    message: summary,
    open: `http://127.0.0.1:${REVIEWER_PORT}/intent/${intent.id}`,
    timeout: 30,
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/reviewer/notify.ts
git commit -m "feat: macOS notification helper using node-notifier"
```

---

### Task 9: Daemon Process (Watcher + Server)

**Files:**
- Create: `src/reviewer/daemon.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Create the daemon entry point**

Create `src/reviewer/daemon.ts`:

```typescript
import { existsSync } from 'node:fs';
import { openDatabase } from '../ledger/db.js';
import { loadAccounts } from '../provider/accounts.js';
import { ImapConnectionPool } from '../provider/imap-pool.js';
import { Executor } from '../executor/executor.js';
import { createReviewerApp } from './app.js';
import { IntentWatcher } from './watcher.js';
import { notifyIntent } from './notify.js';
import { createLogger } from '../logger.js';
import { ACCOUNTS_YAML_PATH, LEDGER_DB_PATH } from '../config.js';

export async function startDaemon(port: number = 4242): Promise<void> {
  const logger = createLogger('daemon');
  const host = '127.0.0.1';

  if (!existsSync(ACCOUNTS_YAML_PATH)) {
    logger.error("No accounts configured. Run 'npx agent-mail add-account' first.");
    process.exit(1);
  }

  if (!existsSync(LEDGER_DB_PATH)) {
    logger.error("No database found. Run 'npx agent-mail add-account' first.");
    process.exit(1);
  }

  const db = openDatabase();
  const accounts = loadAccounts();
  const pool = new ImapConnectionPool({ accounts, logger });
  const executor = new Executor({ db, accounts, pool, logger });
  const app = createReviewerApp({ db, executor, logger });

  // Start notification watcher
  const watcher = new IntentWatcher({
    db,
    pollingIntervalMs: 3000,
    onNewIntent: (intent) => {
      logger.info(`New pending intent: ${intent.id} (${intent.tool})`);
      notifyIntent(intent);
    },
  });
  watcher.start();

  const shutdown = async (code = 0) => {
    watcher.stop();
    try {
      await pool.closeAll();
    } catch {
      // best-effort
    }
    process.exit(code);
  };
  process.once('SIGINT', () => void shutdown(0));
  process.once('SIGTERM', () => void shutdown(0));

  app.listen(port, host, () => {
    logger.info(`agent-mail daemon running at http://${host}:${port}`);
    logger.info(`Watching for pending intents (polling every 3s)`);
    logger.info(`${accounts.length} account(s) configured`);
  });
}
```

- [ ] **Step 2: Add `daemon` command to `src/index.ts`**

Add a new case to the switch in `src/index.ts`:

```typescript
  case 'daemon': {
    const { startDaemon } = await import('./reviewer/daemon.js');
    const port = process.argv[3] ? parseInt(process.argv[3]) : undefined;
    await startDaemon(port);
    break;
  }
```

Update the default case usage string:

```typescript
  default:
    console.error('Usage: agent-mail <add-account|serve|reviewer [port]|daemon [port]|config|install|install-daemon|uninstall-daemon|status>');
    process.exit(1);
```

- [ ] **Step 3: Test manually**

Run: `npx tsx src/index.ts daemon`
Verify: Server starts, "Watching for pending intents" message appears. Create a gated intent via MCP and verify a macOS notification pops up.

- [ ] **Step 4: Commit**

```bash
git add src/reviewer/daemon.ts src/index.ts
git commit -m "feat: daemon process combining watcher and web server"
```

---

### Task 10: launchd Daemon Lifecycle CLI

**Files:**
- Create: `src/cli/daemon.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Create the daemon CLI commands**

Create `src/cli/daemon.ts`:

```typescript
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { LEDGER_DB_PATH } from '../config.js';

const PLIST_NAME = 'com.agent-mail.reviewer';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${PLIST_NAME}.plist`);
const LOG_PATH = join(homedir(), '.agent-mail', 'daemon.log');
const ERR_LOG_PATH = join(homedir(), '.agent-mail', 'daemon-error.log');

function getNodePath(): string {
  try {
    return execSync('which node', { encoding: 'utf-8' }).trim();
  } catch {
    throw new Error('Could not find node binary. Ensure Node.js is in your PATH.');
  }
}

function getEntryScript(): string {
  // Resolve from the installed package
  const scriptPath = join(import.meta.dirname, '..', 'index.js');
  if (!existsSync(scriptPath)) {
    // Dev mode — use tsx
    return join(import.meta.dirname, '..', 'index.ts');
  }
  return scriptPath;
}

export function installDaemon(): void {
  const nodePath = getNodePath();
  const entryScript = getEntryScript();

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${entryScript}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${ERR_LOG_PATH}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>`;

  writeFileSync(PLIST_PATH, plist);
  console.log(`Wrote plist to ${PLIST_PATH}`);

  try {
    execSync(`launchctl bootout gui/$(id -u) ${PLIST_PATH} 2>/dev/null`, { stdio: 'ignore' });
  } catch {
    // Not loaded yet — fine
  }

  execSync(`launchctl bootstrap gui/$(id -u) ${PLIST_PATH}`);
  console.log('Daemon installed and started.');
  console.log(`Logs: ${LOG_PATH}`);
}

export function uninstallDaemon(): void {
  if (!existsSync(PLIST_PATH)) {
    console.log('Daemon not installed.');
    return;
  }

  try {
    execSync(`launchctl bootout gui/$(id -u) ${PLIST_PATH}`);
  } catch {
    // Already unloaded
  }

  unlinkSync(PLIST_PATH);
  console.log('Daemon uninstalled.');
}

export async function daemonStatus(): Promise<void> {
  // Check if plist exists
  if (!existsSync(PLIST_PATH)) {
    console.log('Daemon: not installed');
    return;
  }

  // Check if running
  try {
    const output = execSync(`launchctl print gui/$(id -u)/${PLIST_NAME} 2>&1`, {
      encoding: 'utf-8',
    });
    const pidMatch = output.match(/pid = (\d+)/);
    if (pidMatch) {
      console.log(`Daemon: running (PID ${pidMatch[1]})`);
    } else {
      console.log('Daemon: installed but not running');
    }
  } catch {
    console.log('Daemon: installed but not running');
  }

  // Check pending intents
  if (existsSync(LEDGER_DB_PATH)) {
    try {
      const { openDatabase } = await import('../ledger/db.js');
      const { getPendingIntents } = await import('../ledger/intents.js');
      const db = openDatabase();
      const pending = getPendingIntents(db);
      console.log(`Pending intents: ${pending.length}`);
    } catch {
      // DB might be locked
    }
  }
}
```

- [ ] **Step 2: Wire CLI commands into `src/index.ts`**

Add the new cases to the switch:

```typescript
  case 'install-daemon': {
    const { installDaemon } = await import('./cli/daemon.js');
    installDaemon();
    break;
  }
  case 'uninstall-daemon': {
    const { uninstallDaemon } = await import('./cli/daemon.js');
    uninstallDaemon();
    break;
  }
  case 'status': {
    const { daemonStatus } = await import('./cli/daemon.js');
    await daemonStatus();
    break;
  }
```

- [ ] **Step 3: Test the install flow manually**

Run: `npx tsx src/index.ts install-daemon`
Verify: Plist written, daemon bootstrapped. Check with:
```bash
launchctl print gui/$(id -u)/com.agent-mail.reviewer
```

Run: `npx tsx src/index.ts status`
Verify: Shows "running" with PID.

Run: `npx tsx src/index.ts uninstall-daemon`
Verify: Plist removed, daemon stopped.

- [ ] **Step 4: Commit**

```bash
git add src/cli/daemon.ts src/index.ts
git commit -m "feat: launchd daemon lifecycle CLI (install/uninstall/status)"
```

---

### Task 11: Quarantine Review Page

**Files:**
- Modify: `src/reviewer/routes.ts`
- Modify: `src/reviewer/static/app.js`
- Modify: `src/reviewer/static/index.html`

- [ ] **Step 1: Add quarantine API route**

Add a new route to `src/reviewer/routes.ts`. This route queries the intent ledger for all executed `quarantine_thread` intents (items that were quarantined but not yet permanently deleted or undone):

```typescript
  router.get('/quarantine', (_req, res) => {
    const quarantined = deps.db.prepare(`
      SELECT * FROM intents
      WHERE tool = 'quarantine_thread'
        AND status = 'executed'
        AND id NOT IN (
          SELECT intent_id FROM audit_log WHERE action = 'undone'
        )
      ORDER BY created_at DESC
    `).all() as Array<Record<string, unknown>>;

    res.json(quarantined.map(rowToIntent));
  });
```

Import `rowToIntent` from `../ledger/db.js` at the top of routes.ts:

```typescript
import { rowToIntent } from '../ledger/db.js';
```

- [ ] **Step 2: Add quarantine tab to `index.html`**

Add a new tab button:

```html
    <div class="tabs">
      <button class="tab active" type="button" data-tab="pending">Pending</button>
      <button class="tab" type="button" data-tab="quarantine">Quarantine</button>
      <button class="tab" type="button" data-tab="audit">Audit Log</button>
      <button class="tab" type="button" data-tab="stuck">Stuck</button>
    </div>
```

And a tab content area:

```html
    <div id="quarantine-tab" class="tab-content">
      <div id="quarantine-list"></div>
    </div>
```

- [ ] **Step 3: Add quarantine rendering to `app.js`**

Add loading and rendering functions:

```javascript
async function loadQuarantine() {
  try {
    const res = await apiFetch('/api/quarantine');
    const items = await res.json();
    renderQuarantine(items);
  } catch (error) {
    const list = document.getElementById('quarantine-list');
    appendEmptyState(list, `Error: ${formatError(error)}`);
  }
}

function renderQuarantine(intents) {
  const list = document.getElementById('quarantine-list');
  if (intents.length === 0) {
    appendEmptyState(list, 'No quarantined items');
    return;
  }

  clearElement(list);

  const header = document.createElement('div');
  header.className = 'quarantine-header';
  header.innerHTML = `<strong>${intents.length} item${intents.length !== 1 ? 's' : ''}</strong> in Quarantine`;
  list.appendChild(header);

  const checkboxes = [];

  intents.forEach((intent) => {
    const row = document.createElement('div');
    row.className = 'quarantine-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.dataset.intentId = intent.id;
    checkboxes.push(checkbox);

    const info = document.createElement('div');
    info.className = 'quarantine-info';

    const p = intent.params;
    const uidCount = Array.isArray(p.uids) ? p.uids.length : 0;
    const mailbox = p.mailbox || 'INBOX';
    info.innerHTML = `<div>${escapeHtml(intent.tool)} · ${uidCount} message${uidCount !== 1 ? 's' : ''} from ${escapeHtml(mailbox)}</div>
      <div class="audit-time">${new Date(intent.created_at).toLocaleString()}</div>`;

    const undoBtn = document.createElement('button');
    undoBtn.className = 'btn';
    undoBtn.textContent = 'Undo';
    undoBtn.addEventListener('click', async () => {
      try {
        await apiFetch(`/api/intent/${intent.id}/undo`, { method: 'POST' });
        await loadQuarantine();
      } catch (error) {
        alert(`Error: ${formatError(error)}`);
      }
    });

    row.appendChild(checkbox);
    row.appendChild(info);
    row.appendChild(undoBtn);
    list.appendChild(row);
  });

  // Status bar
  const statusBar = document.createElement('div');
  statusBar.className = 'quarantine-status';

  function updateStatus() {
    const checked = checkboxes.filter(cb => cb.checked).length;
    const unchecked = checkboxes.length - checked;
    statusBar.innerHTML = `<span>${checked} selected for review · ${unchecked} unchecked</span>`;
  }
  checkboxes.forEach(cb => cb.addEventListener('change', updateStatus));
  updateStatus();

  list.appendChild(statusBar);
}
```

Wire the quarantine tab to load data when clicked. In the tab click handler (look for the existing tab switching logic), add:

```javascript
  if (tabName === 'quarantine') {
    void loadQuarantine();
  }
```

- [ ] **Step 4: Test manually**

Run: `npx tsx src/index.ts reviewer`
Open: `http://127.0.0.1:4242`
Click the Quarantine tab. Verify the quarantine view renders.

- [ ] **Step 5: Commit**

```bash
git add src/reviewer/routes.ts src/reviewer/static/app.js src/reviewer/static/index.html
git commit -m "feat: quarantine review page with undo"
```

---

### Task 12: Final Integration and Cleanup

**Files:**
- Modify: `package.json` (scripts)
- Various cleanup

- [ ] **Step 1: Add daemon scripts to `package.json`**

Add to the scripts section:

```json
"daemon": "tsx src/index.ts daemon",
"install-daemon": "tsx src/index.ts install-daemon",
"uninstall-daemon": "tsx src/index.ts uninstall-daemon",
"status": "tsx src/index.ts status"
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: add daemon lifecycle scripts to package.json"
```

- [ ] **Step 5: Run validate**

Run: `npm run validate`
Expected: typecheck + tests + audit all pass
