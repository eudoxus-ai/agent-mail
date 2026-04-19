# Claude Chat UX Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent-mail MCP server pleasant for Claude (the agent) and its human user — notifications only fire when human action is required, gated responses carry actionable info, and `search_threads` / `hold_messages` reduce token/turn waste during inbox triage.

**Architecture:** Five focused phases against the existing TypeScript MCP server. Phase 1 filters notifications at the daemon seam. Phase 2 improves gated-response shape. Phase 3 adds projection + cursor pagination + flattened envelope to `search_threads`. Phase 4 adds bulk-by-sender hold. Phase 5 polishes mutation responses and tool descriptions.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, SQLite (better-sqlite3), Vitest, IMAP (`imapflow`), Zod schemas.

---

## Scope Note

Phases are independently shippable. If time pressure forces a split, ship Phase 1 alone first — it's the loudest pain point — then Phase 2, then 3/4/5 as polish. Each phase ends with tests green and a commit.

## File Structure

**New files:**
- `src/reviewer/notification-policy.ts` — pure function deciding whether an intent should notify; <50 LOC
- `test/reviewer/notification-policy.test.ts`
- `src/tools/hold-by-sender.ts` — new tool definition
- `test/tools/hold-by-sender.test.ts`
- `src/lib/envelope-projection.ts` — `pickFields` helper for search result shaping
- `test/lib/envelope-projection.test.ts`
- `src/lib/search-cursor.ts` — opaque cursor encode/decode
- `test/lib/search-cursor.test.ts`

**Modified files:**
- `src/policy/engine.ts` — replace "Unknown tool" string; add `notify` field on PolicyResult
- `src/policy/defaults.ts` — add `notify:` axis to YAML
- `src/types.ts` — extend `PolicyResult` and `ToolPolicy` types
- `src/reviewer/daemon.ts` — gate notification call via policy
- `src/reviewer/watcher.ts` — pass full intent object so daemon can re-evaluate policy
- `src/server/middleware.ts` — richer pending payload (approval_url, human_summary, undo hint)
- `src/tools/search-threads.ts` — add `fields`, `cursor`, flat envelope fields; doc update
- `src/executor/executor.ts` — honor projection + cursor in search path; response shape
- `src/tools/hold-messages.ts` — default `include_summary: true`; doc update
- `src/server/server.ts` — register `hold_by_sender` tool

---

# Phase 1 — Notification Filtering (primary user pain)

**Goal:** Human only gets a macOS notification when an intent actually requires their approval to proceed (i.e., risk ≥ medium OR tool is always_gated). Not for low-risk gated actions that mostly self-resolve, and definitely not for ungated read-only tools (which shouldn't even reach the watcher, but defense in depth).

### Task 1.1: Add `NotificationPolicy` pure function with unit tests

**Files:**
- Create: `src/reviewer/notification-policy.ts`
- Test: `test/reviewer/notification-policy.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/reviewer/notification-policy.test.ts
import { describe, it, expect } from 'vitest';
import { shouldNotify } from '../../src/reviewer/notification-policy.js';
import type { Intent } from '../../src/types.js';

const mk = (over: Partial<Intent>): Intent => ({
  id: 'i1', tool: 'hold_messages', params: {}, risk: 'low',
  status: 'pending', account_id: 'a', agent_id: 'claude',
  created_at: new Date().toISOString(), resolved_at: null,
  resolved_by: null, error_detail: null, undo_token: null,
  undo_expires_at: null,
  ...over,
});

describe('shouldNotify', () => {
  it('notifies for high risk (e.g. queue_send)', () => {
    expect(shouldNotify(mk({ tool: 'queue_send', risk: 'high' }))).toBe(true);
  });
  it('notifies for medium risk with replies', () => {
    expect(shouldNotify(mk({ tool: 'hold_messages', risk: 'medium' }))).toBe(true);
  });
  it('suppresses low-risk gated intents', () => {
    expect(shouldNotify(mk({ tool: 'label_thread', risk: 'low' }))).toBe(false);
  });
  it('suppresses unknown-tool fallback gated intents', () => {
    expect(shouldNotify(mk({ tool: 'list_mailboxes', risk: 'high', params: { __unknown_tool_fallback: true } }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/reviewer/notification-policy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `shouldNotify`**

```typescript
// src/reviewer/notification-policy.ts
import type { Intent } from '../types.js';

const NOTIFY_TOOLS = new Set(['queue_send', 'hold_messages', 'restore_messages']);

export function shouldNotify(intent: Intent): boolean {
  const params = (intent.params ?? {}) as Record<string, unknown>;
  if (params.__unknown_tool_fallback === true) return false;
  if (intent.risk === 'high') return true;
  if (intent.risk === 'medium' && NOTIFY_TOOLS.has(intent.tool)) return true;
  return false;
}
```

- [ ] **Step 4: Tests pass**

Run: `npx vitest run test/reviewer/notification-policy.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/reviewer/notification-policy.ts test/reviewer/notification-policy.test.ts
git commit -m "feat(reviewer): add notification-policy filter for pending intents"
```

### Task 1.2: Wire `shouldNotify` into the daemon and tag unknown-tool fallback

**Files:**
- Modify: `src/reviewer/daemon.ts:32-39`
- Modify: `src/policy/engine.ts:36-37`
- Modify: `src/server/middleware.ts:86-108`

- [ ] **Step 1: Write failing integration-ish test**

Add a test in `test/reviewer/daemon.test.ts` (or extend existing) that:
- Creates a pending intent with `risk: 'low'` directly in DB.
- Wires a spy `onNewIntent` callback through the real `shouldNotify` filter.
- Asserts the spy is NOT called.
- Then inserts a `risk: 'high'` intent and asserts the spy IS called.

```typescript
import { describe, it, expect, vi } from 'vitest';
import { openTestDb } from '../helpers/db.js';
import { IntentWatcher } from '../../src/reviewer/watcher.js';
import { shouldNotify } from '../../src/reviewer/notification-policy.js';
import { createIntent, updateIntentStatus } from '../../src/ledger/intents.js';

describe('daemon notification filter', () => {
  it('filters low-risk intents before notifying', async () => {
    const db = openTestDb();
    const notify = vi.fn();
    const watcher = new IntentWatcher({
      db, pollingIntervalMs: 10,
      onNewIntent: (i) => { if (shouldNotify(i)) notify(i); },
    });
    createIntent(db, { id: 'low', tool: 'label_thread', params: {}, risk: 'low', account_id: 'a', agent_id: 'c' });
    watcher.start();
    await new Promise(r => setTimeout(r, 30));
    expect(notify).not.toHaveBeenCalled();
    createIntent(db, { id: 'hi', tool: 'queue_send', params: {}, risk: 'high', account_id: 'a', agent_id: 'c' });
    await new Promise(r => setTimeout(r, 30));
    expect(notify).toHaveBeenCalledTimes(1);
    watcher.stop();
  });
});
```

Adapt `openTestDb` / `createIntent` signatures to what's already used in `test/ledger/intents.test.ts` — **read the existing file first** and mirror it exactly; do not invent helpers.

- [ ] **Step 2: Run — verify failure**

Run: `npx vitest run test/reviewer/daemon.test.ts`
Expected: FAIL (notify called for low-risk).

- [ ] **Step 3: Update daemon.ts**

```typescript
// src/reviewer/daemon.ts — replace the onNewIntent callback
import { shouldNotify } from './notification-policy.js';

// ...inside startDaemon
const watcher = new IntentWatcher({
  db,
  pollingIntervalMs: 3000,
  onNewIntent: (intent) => {
    logger.info(`New pending intent: ${intent.id} (${intent.tool}, risk=${intent.risk})`);
    if (shouldNotify(intent)) {
      notifyIntent(intent, port);
    } else {
      logger.debug(`Suppressed notification for low-priority intent ${intent.id}`);
    }
  },
});
```

- [ ] **Step 4: Tag unknown-tool fallback in engine.ts**

Change `src/policy/engine.ts:37` from:

```typescript
return { decision: 'gate', risk: 'high', reason: 'Unknown tool, gating by default', reversible: false };
```

to:

```typescript
return {
  decision: 'gate',
  risk: 'high',
  reason: `Tool "${toolName}" has no policy entry; gating conservatively. Add it to policy.yaml to configure.`,
  reversible: false,
  unknownTool: true,
};
```

Extend `PolicyResult` in `src/types.ts` with optional `unknownTool?: boolean`.

- [ ] **Step 5: Propagate flag in middleware**

In `src/server/middleware.ts` around line 88, when building the intent params record passed to `createGatedIntent`, include `__unknown_tool_fallback: true` when `policyResult.unknownTool` is set. (Store it alongside toolParams, or as a field on the intent row — whichever has a cleaner path. If simpler, add a column or a JSON side-channel. Prefer adding it to `params` for now since `shouldNotify` already reads `params.__unknown_tool_fallback`.)

```typescript
const toolParamsToStore = policyResult.unknownTool
  ? { ...params, __unknown_tool_fallback: true }
  : params;

const intent = await deps.executor.createGatedIntent({
  tool: canonicalToolName,
  toolParams: toolParamsToStore,
  // ...
});
```

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: all green, including the new daemon test.

- [ ] **Step 7: Commit**

```bash
git add src/reviewer/daemon.ts src/policy/engine.ts src/server/middleware.ts src/types.ts test/reviewer/daemon.test.ts
git commit -m "feat(reviewer): only notify for medium/high-risk intents; tag unknown-tool fallback"
```

---

# Phase 2 — Richer Gated Response

**Goal:** When a tool is gated, return an actionable payload: human-readable summary, approval URL the agent can relay verbatim, and a clearer `reason`. Fix the misleading "Unknown tool" string (done in Phase 1).

### Task 2.1: Pending response carries approval_url + human_summary

**Files:**
- Modify: `src/server/middleware.ts:96-108`
- Test: `test/server/middleware.test.ts` (create if not present; check `test/server/` first)

- [ ] **Step 1: Write failing test**

```typescript
it('pending response includes approval_url and human_summary', async () => {
  const result = await callWrappedTool('queue_send', { /* valid params */ });
  const body = JSON.parse(result.content[0].text);
  expect(body.status).toBe('pending');
  expect(body.approval_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/intents\//);
  expect(body.human_summary).toBeTypeOf('string');
  expect(body.human_summary.length).toBeGreaterThan(0);
});
```

(Wire `callWrappedTool` using the existing test plumbing — follow whatever `test/server/middleware.test.ts` already uses, or lift helpers from `test/integration/*.test.ts`.)

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run test/server/middleware.test.ts`
Expected: FAIL — missing fields.

- [ ] **Step 3: Implement**

Expose the reviewer port to middleware via `MiddlewareDeps` (add `reviewerPort?: number`, default 4242, wire from `createMcpServer` options). Then in middleware.ts replace the pending-response block:

```typescript
import { describeIntent } from '../ledger/audit-summary.js';

// ...
const port = deps.reviewerPort ?? 4242;
const humanSummary = describeIntent(canonicalToolName, params);
return {
  content: [
    {
      type: 'text' as const,
      text: JSON.stringify({
        status: 'pending',
        intent_id: intent.id,
        approval_url: `http://127.0.0.1:${port}/intents/${intent.id}`,
        human_summary: humanSummary,
        message: `Action queued for approval: ${toolDef.name}. Ask the user to approve at ${port}.`,
        reason: policyResult.reason,
      }),
    },
  ],
};
```

- [ ] **Step 4: Thread `reviewerPort` through `createMcpServer`**

In `src/server/server.ts`, add `reviewerPort?: number` to the options interface and pass through to `wrapToolHandler` deps. Default 4242.

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/middleware.ts src/server/server.ts test/server/middleware.test.ts
git commit -m "feat(server): richer pending response with approval_url and human_summary"
```

---

# Phase 3 — `search_threads` Triage Ergonomics

**Goal:** Cut token waste: opt-in `fields` projection, opaque `cursor` for pagination, flat `from_address`/`from_name`, and a `category` heuristic field. `list_unsubscribe` parsing already lands structured (`src/lib/list-unsubscribe.ts`) — verify it surfaces.

### Task 3.1: Add opaque pagination cursor

**Files:**
- Create: `src/lib/search-cursor.ts`
- Test: `test/lib/search-cursor.test.ts`
- Modify: `src/tools/search-threads.ts`, `src/executor/executor.ts` (search path)

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../../src/lib/search-cursor.js';

describe('search cursor', () => {
  it('round-trips a date + uid tuple', () => {
    const c = encodeCursor({ before: '2026-04-18T10:00:00Z', lastUid: 42 });
    expect(decodeCursor(c)).toEqual({ before: '2026-04-18T10:00:00Z', lastUid: 42 });
  });
  it('returns null for invalid cursor', () => {
    expect(decodeCursor('garbage')).toBeNull();
  });
});
```

- [ ] **Step 2: Run — fail**

Run: `npx vitest run test/lib/search-cursor.test.ts`

- [ ] **Step 3: Implement**

```typescript
// src/lib/search-cursor.ts
export interface SearchCursor {
  before: string;
  lastUid: number;
}

export function encodeCursor(c: SearchCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): SearchCursor | null {
  try {
    const obj = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof obj.before === 'string' && typeof obj.lastUid === 'number') {
      return obj as SearchCursor;
    }
    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Tests pass**

Run: `npx vitest run test/lib/search-cursor.test.ts`

- [ ] **Step 5: Add `cursor` input + `next_cursor` output to search_threads**

In `src/tools/search-threads.ts` add to schema:

```typescript
cursor: z.string().optional().describe('Opaque cursor from a prior response `next_cursor`. When provided, `before` is ignored.'),
```

In `src/executor/executor.ts` search_threads path: after fetching results, if `results.length === limit`, compute `next_cursor = encodeCursor({ before: oldestDate, lastUid: oldestUid })` and include in the response envelope. When `cursor` is provided in params, decode it and override `before`.

- [ ] **Step 6: Add integration test**

In `test/integration/search-threads-pagination.test.ts` (follow existing fixture patterns in `test/integration/`): seed ≥30 messages, request `limit: 10`, capture `next_cursor`, request again with cursor, assert no UID overlap and older dates only.

- [ ] **Step 7: Run tests**

Run: `npm test`

- [ ] **Step 8: Commit**

```bash
git add src/lib/search-cursor.ts test/lib/search-cursor.test.ts src/tools/search-threads.ts src/executor/executor.ts test/integration/search-threads-pagination.test.ts
git commit -m "feat(search): opaque cursor pagination for search_threads"
```

### Task 3.2: Add `fields` projection

**Files:**
- Create: `src/lib/envelope-projection.ts`
- Test: `test/lib/envelope-projection.test.ts`
- Modify: `src/tools/search-threads.ts`, `src/executor/executor.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { projectResult, ALLOWED_FIELDS } from '../../src/lib/envelope-projection.js';

const sample = {
  account_id: 'a', mailbox: 'INBOX', uid: 7,
  envelope: { message_id: '<m>', subject: 'S', from: { address: 'x@y', name: 'X' }, date: 'd' },
  snippet: 's', flags: [], list_id: null, list_unsubscribe: null, is_list_mail: false,
  target: { account_id: 'a', uid: 7, mailbox: 'INBOX' },
};

describe('projectResult', () => {
  it('returns full shape when fields omitted', () => {
    expect(projectResult(sample, undefined)).toEqual(sample);
  });
  it('keeps only requested top-level fields', () => {
    expect(projectResult(sample, ['uid', 'subject', 'from_address'])).toEqual({
      uid: 7, subject: 'S', from_address: 'x@y',
    });
  });
  it('rejects unknown fields via ALLOWED_FIELDS', () => {
    expect(ALLOWED_FIELDS).toContain('from_address');
    expect(ALLOWED_FIELDS).toContain('from_name');
  });
});
```

- [ ] **Step 2: Run — fail**

Run: `npx vitest run test/lib/envelope-projection.test.ts`

- [ ] **Step 3: Implement**

```typescript
// src/lib/envelope-projection.ts
export const ALLOWED_FIELDS = [
  'uid', 'account_id', 'mailbox', 'subject', 'date', 'message_id',
  'from_address', 'from_name', 'snippet', 'flags',
  'list_id', 'list_unsubscribe', 'is_list_mail', 'target',
] as const;
export type Field = typeof ALLOWED_FIELDS[number];

interface Full {
  account_id: string; mailbox: string; uid: number;
  envelope: { message_id: string; subject: string; from: { address: string; name: string | null }; date: string };
  snippet: string; flags: string[];
  list_id: string | null; list_unsubscribe: string | null; is_list_mail: boolean;
  target: { account_id: string; uid: number; mailbox: string };
}

export function projectResult(r: Full, fields?: readonly string[]): Record<string, unknown> {
  if (!fields || fields.length === 0) return r as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    switch (f) {
      case 'uid': out.uid = r.uid; break;
      case 'account_id': out.account_id = r.account_id; break;
      case 'mailbox': out.mailbox = r.mailbox; break;
      case 'subject': out.subject = r.envelope.subject; break;
      case 'date': out.date = r.envelope.date; break;
      case 'message_id': out.message_id = r.envelope.message_id; break;
      case 'from_address': out.from_address = r.envelope.from.address; break;
      case 'from_name': out.from_name = r.envelope.from.name; break;
      case 'snippet': out.snippet = r.snippet; break;
      case 'flags': out.flags = r.flags; break;
      case 'list_id': out.list_id = r.list_id; break;
      case 'list_unsubscribe': out.list_unsubscribe = r.list_unsubscribe; break;
      case 'is_list_mail': out.is_list_mail = r.is_list_mail; break;
      case 'target': out.target = r.target; break;
    }
  }
  return out;
}
```

- [ ] **Step 4: Tests pass**

Run: `npx vitest run test/lib/envelope-projection.test.ts`

- [ ] **Step 5: Wire into search_threads**

Add to schema in `src/tools/search-threads.ts`:

```typescript
fields: z.array(z.enum(ALLOWED_FIELDS as unknown as [string, ...string[]])).optional()
  .describe('Project only these fields per result. Omit for full shape. Recommended for bulk triage.'),
```

In executor search path, map results through `projectResult(r, params.fields)`.

- [ ] **Step 6: Integration test**

Extend `test/integration/search-threads-pagination.test.ts` (or new file) with a case `fields: ['uid','subject','from_address']` and assert result keys match exactly.

- [ ] **Step 7: Run all tests**

Run: `npm test`

- [ ] **Step 8: Commit**

```bash
git add src/lib/envelope-projection.ts test/lib/envelope-projection.test.ts src/tools/search-threads.ts src/executor/executor.ts test/integration/search-threads-pagination.test.ts
git commit -m "feat(search): fields projection for search_threads responses"
```

### Task 3.3: Add flat `from_address`/`from_name` alongside nested envelope

**Files:**
- Modify: `src/executor/executor.ts` — SearchThreadResult mapping
- Modify: `src/tools/search-threads.ts` — description

- [ ] **Step 1: Write failing test**

In `test/integration/search-threads.test.ts` (follow existing patterns) assert a full (no-fields) result has both `envelope.from.address` AND a top-level `from_address` for back-compat + convenience.

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement**

In the mapping in `src/executor/executor.ts` search path, add:

```typescript
from_address: env.from?.address ?? '',
from_name: env.from?.name ?? null,
```

to each result object. Update `SearchThreadResult` interface to include optional flat fields. Update `ALLOWED_FIELDS` already supports `from_address`/`from_name`.

- [ ] **Step 4: Update description**

Edit `src/tools/search-threads.ts` description string to mention flat fields.

- [ ] **Step 5: Tests pass**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add src/executor/executor.ts src/tools/search-threads.ts test/integration/search-threads.test.ts
git commit -m "feat(search): expose flat from_address and from_name on results"
```

### Task 3.4: Add `category` heuristic hint

**Files:**
- Create: `src/attention/category.ts`
- Test: `test/attention/category.test.ts`
- Modify: `src/executor/executor.ts` (search mapping)

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { classifyCategory } from '../../src/attention/category.js';

describe('classifyCategory', () => {
  it('newsletter when list_id present and no direct reply headers', () => {
    expect(classifyCategory({ list_id: '<news.example.com>', list_unsubscribe: 'http://x', subject: 'Weekly' }))
      .toBe('newsletter');
  });
  it('promotional on price/sale/discount subject', () => {
    expect(classifyCategory({ list_id: null, list_unsubscribe: null, subject: '50% off today only' }))
      .toBe('promotional');
  });
  it('transactional for receipts', () => {
    expect(classifyCategory({ list_id: null, list_unsubscribe: null, subject: 'Your receipt from Stripe' }))
      .toBe('transactional');
  });
  it('personal when no list headers and neutral subject', () => {
    expect(classifyCategory({ list_id: null, list_unsubscribe: null, subject: 'lunch tomorrow?' }))
      .toBe('personal');
  });
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement**

```typescript
// src/attention/category.ts
export type Category = 'newsletter' | 'promotional' | 'transactional' | 'notification' | 'personal';

interface Input {
  list_id: string | null;
  list_unsubscribe: string | null;
  subject: string;
}

const PROMO = /\b(\d{1,3}% ?off|sale|discount|deal|coupon|free shipping|limited time)\b/i;
const TXN = /\b(receipt|invoice|order (confirmation|shipped|delivered)|payment|refund|statement)\b/i;
const NOTIFY = /\b(alert|reminder|notification|security|verification code|2fa)\b/i;

export function classifyCategory(i: Input): Category {
  const s = i.subject ?? '';
  if (TXN.test(s)) return 'transactional';
  if (NOTIFY.test(s) && !i.list_id) return 'notification';
  if (PROMO.test(s)) return 'promotional';
  if (i.list_id || i.list_unsubscribe) return 'newsletter';
  return 'personal';
}
```

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Surface in search results**

Add `category` to each result and `ALLOWED_FIELDS`. Update `projectResult` to handle it.

- [ ] **Step 6: Run full suite**

Run: `npm test`

- [ ] **Step 7: Commit**

```bash
git add src/attention/category.ts test/attention/category.test.ts src/executor/executor.ts src/lib/envelope-projection.ts test/lib/envelope-projection.test.ts
git commit -m "feat(search): add category heuristic (newsletter/promotional/transactional/notification/personal)"
```

---

# Phase 4 — `hold_by_sender` Bulk Tool

**Goal:** One call: "hold everything from sender X before date Y." The natural inbox-cleanup primitive, instead of 13 individual UIDs.

### Task 4.1: Tool definition + executor wiring

**Files:**
- Create: `src/tools/hold-by-sender.ts`
- Test: `test/tools/hold-by-sender.test.ts`
- Modify: `src/server/server.ts` (register), `src/executor/executor.ts` (new action), `src/policy/defaults.ts` (policy entry)

- [ ] **Step 1: Write failing test**

```typescript
// test/tools/hold-by-sender.test.ts
import { describe, it, expect } from 'vitest';
import { holdBySenderTool } from '../../src/tools/hold-by-sender.js';

describe('hold_by_sender tool definition', () => {
  it('requires from; account_ids + before optional', () => {
    expect(() => holdBySenderTool.inputSchema.parse({ from: 'x@y' })).not.toThrow();
    expect(() => holdBySenderTool.inputSchema.parse({})).toThrow();
    expect(() => holdBySenderTool.inputSchema.parse({ from: 'x@y', before: '2026-04-18T00:00:00Z' })).not.toThrow();
  });
  it('is not read-only, reversible via hold semantics', () => {
    expect(holdBySenderTool.annotations?.readOnlyHint).toBe(false);
  });
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement tool definition**

```typescript
// src/tools/hold-by-sender.ts
import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

const description =
  'Hold (move to agent-mail-holding) ALL messages from a given sender address, optionally bounded by `before`. Same 30-day reversibility as hold_messages. Use this for "clean out newsletter X" style triage; prefer hold_messages when you already have specific UIDs. Supports dry_run and include_summary.';

const inputSchema = z.object({
  from: z.string().min(1).describe('Sender email address (or substring) to match.'),
  before: z.string().optional().describe('ISO8601 — only messages strictly before this instant.'),
  account_ids: z.array(z.string().min(1)).optional().describe('Restrict to specific accounts; omit for all.'),
  mailbox: z.string().optional().describe('Default: INBOX.'),
  dry_run: z.boolean().optional().describe('Preview the UID list without moving.'),
  include_summary: z.boolean().optional().describe('Default true: response includes moved[{uid,subject,original_mailbox}].'),
  limit: z.number().int().positive().max(1000).optional().describe('Safety cap per account. Default 500.'),
});

export const holdBySenderTool: ToolDefinition = {
  name: 'hold_by_sender',
  description,
  inputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
```

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Register in server.ts**

In `src/server/server.ts`, import and register `holdBySenderTool` alongside other hold/restore tools, wrapped by `wrapToolHandler`.

- [ ] **Step 6: Executor handler**

In `src/executor/executor.ts`, add a `hold_by_sender` case inside `performAction` (or wherever tool dispatch lives — read current pattern first). It should:
1. Resolve target accounts (all or filtered by `account_ids`).
2. For each account: IMAP SEARCH by FROM + BEFORE, collect UIDs (cap at `limit` default 500).
3. Delegate to the same internal move-to-holding routine `hold_messages` uses — **do not duplicate the IMAP move logic; extract a shared function if needed**.
4. Return the same response shape as `hold_messages` including `moved[]` summary and `undo_token`.

- [ ] **Step 7: Policy entry**

Add to `src/policy/defaults.ts` YAML:

```yaml
hold_by_sender:
  risk: medium
  gate: configurable
  default: ungated
  reversible: true
  override:
    when_thread_has_replies: approval_required
```

- [ ] **Step 8: Integration test**

In `test/integration/hold-by-sender.test.ts`: seed fixtures with 5 messages from the target sender + 3 unrelated; call the tool; assert exactly 5 moved, unrelated untouched, undo_token present.

- [ ] **Step 9: Run all tests**

Run: `npm test`

- [ ] **Step 10: Commit**

```bash
git add src/tools/hold-by-sender.ts test/tools/hold-by-sender.test.ts src/server/server.ts src/executor/executor.ts src/policy/defaults.ts test/integration/hold-by-sender.test.ts
git commit -m "feat(tools): add hold_by_sender for bulk sender-level triage"
```

---

# Phase 5 — Mutation Response Polish

**Goal:** Every mutation returns a `to_undo` hint; `hold_messages` defaults `include_summary` to true; tool descriptions sell the 30-day undo loudly.

### Task 5.1: Default `include_summary: true` on hold_messages + doc loudening

**Files:**
- Modify: `src/tools/hold-messages.ts`
- Modify: `src/executor/executor.ts` (default-true behavior)

- [ ] **Step 1: Update schema default**

In `src/tools/hold-messages.ts`:

```typescript
include_summary: z
  .boolean()
  .optional()
  .default(true)
  .describe('Default true: response includes moved[{uid, account_id, subject, from, original_mailbox}]. Set false to skip if you only need UIDs.'),
```

- [ ] **Step 2: Update executor to honor default**

Where executor reads `include_summary`, treat `undefined` as `true`.

- [ ] **Step 3: Loudify description — mention 30-day undo**

Update description string to lead with: *"Reversible for 30 days via restore_messages or undo_intent. This server cannot permanently delete — it is safe to be aggressive."*

- [ ] **Step 4: Update test expectations**

Search for tests asserting no-summary default and invert; add test that `include_summary: false` still works.

- [ ] **Step 5: Run all tests**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add src/tools/hold-messages.ts src/executor/executor.ts test/
git commit -m "feat(hold): default include_summary to true; emphasize 30-day reversibility"
```

### Task 5.2: Always-on `to_undo` hint in mutation responses

**Files:**
- Modify: `src/lib/undo-hint.ts` (extend) and executor call sites

- [ ] **Step 1: Write failing test**

```typescript
it('hold_messages response includes to_undo hint on executed intents', async () => {
  const res = await callTool('hold_messages', { targets: [/*...*/] });
  const body = JSON.parse(res.content[0].text);
  expect(body.to_undo).toMatch(/undo_intent.*intent_id/);
});
```

- [ ] **Step 2: Run — verify fail or adjust if already present**

- [ ] **Step 3: Implement in executor response builder**

After a mutation executes, attach:

```typescript
to_undo: `To undo: call undo_intent with intent_id "${intent.id}" (expires ${intent.undo_expires_at}).`,
```

to every response for tools where `policyResult.reversible === true`.

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Commit**

```bash
git add src/executor/executor.ts src/lib/undo-hint.ts test/
git commit -m "feat(executor): always include to_undo hint on reversible mutation responses"
```

---

## Self-Review Checklist (run before handoff)

1. **Spec coverage** — feedback items mapped:
   - "Unknown tool" rename → Task 1.2
   - Gate read tools off by default → already true in `defaults.ts`; Phase 1.2 improves the fallback for truly unknown tools
   - Richer pending response → Task 2.1
   - `list_unsubscribe` parsed → already present in `src/lib/list-unsubscribe.ts` (verify surfaced — spot-check in 3.3 integration test)
   - `fields` projection → Task 3.2
   - `category` hint → Task 3.4
   - Pagination cursor → Task 3.1
   - Flat `from_address` → Task 3.3
   - `hold_by_sender` → Phase 4
   - Default `include_summary: true` → Task 5.1
   - Prominent undo hint → Task 5.2
   - Loud 30-day undo in docs → Task 5.1
   - **Notification filter (user's primary ask)** → Phase 1

2. **Type consistency** — `projectResult`, `ALLOWED_FIELDS`, `Field` type names consistent across Tasks 3.2/3.3/3.4. `shouldNotify` signature stable between tasks.

3. **Placeholder scan** — No "TBD", no "similar to above", no "add appropriate error handling". Each task has concrete code or clear modification targets with line references to existing files.

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-04-18-claude-chat-ux.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task with review between, fast iteration. Phase 1 first if you want to ship the notification fix standalone.
2. **Inline Execution** — execute tasks in this session with batch checkpoints.

Which approach — and do you want all five phases, or ship Phase 1 alone first?
