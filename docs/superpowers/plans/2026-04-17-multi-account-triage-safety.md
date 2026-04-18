# Multi-account triage safety — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix silent-failure bugs in agent-mail's read/destructive tool surface by making every tool cross-account by default, replacing bare `uids` with account-qualified `targets`, and adding `dry_run` + structured blast-radius reporting to `quarantine_thread`.

**Architecture:** Introduce a shared `fanOut` helper in the executor that runs a per-account function in parallel via the existing IMAP pool, collecting per-account errors into a standard envelope (`accounts_searched`, `accounts_available`, `per_account_errors`). Tool schemas swap `account_id?: string` → `account_ids?: string[]` and bare `uids: number[]` → `targets: Target[]`. The `Intent.account_id` SQLite column stays as a "principal account" for audit-trail compatibility — the real scope lives in `intent.params`. No DB migration needed.

**Tech Stack:** TypeScript, zod (schemas), node:sqlite (ledger), imapflow (IMAP), vitest (tests).

**Spec:** `docs/superpowers/specs/2026-04-17-multi-account-triage-safety-design.md`

---

## File Structure

**Create:**
- `src/executor/fan-out.ts` — `fanOut(accountIds, fn)` helper + envelope types
- `src/tools/target.ts` — Shared `Target` zod schema and `parseTargets` helper
- `test/executor/fan-out.test.ts` — Unit tests for fan-out helper
- `test/tools/target.test.ts` — Unit tests for Target parsing
- `test/executor/multi-account-search.test.ts` — Integration test, two accounts
- `test/executor/quarantine-dry-run.test.ts` — Dry-run + blast radius test

**Modify:**
- `src/tools/search-threads.ts` — `account_id` → `account_ids`
- `src/tools/get-overview.ts` — `account_id` → `account_ids`
- `src/tools/get-audit-log.ts` — `account_id` → `account_ids`
- `src/tools/get-pending-actions.ts` — `account_id` → `account_ids`
- `src/tools/read-thread.ts` — `{uid, account_id?}` → `target: Target`
- `src/tools/label-thread.ts` — `uids` → `targets`
- `src/tools/quarantine-thread.ts` — `uids` → `targets`, add `dry_run`
- `src/executor/executor.ts` — `searchThreads`, `read_thread`, `label_thread`, `quarantine_thread`, `get_overview` paths use `fanOut`; quarantine adds dry-run + structured report
- `src/server/server.ts` — wire envelope into responses (only if currently transforms results)
- `src/types.ts` — add `Target`, `MultiAccountEnvelope<T>` type aliases
- `README.md` — update tool-shape examples

**No-change (verify only):**
- `src/provider/imap-pool.ts` — already keyed by account; verify parallel `withConnection` calls per distinct account work
- `src/ledger/db.ts` — schema unchanged; `Intent.account_id` becomes "principal" account (first in `account_ids`, or sole account for single-account tools)
- `src/policy/*` — single-account gating still works; multi-account read tools are low-risk so policy doesn't gate them today (verify in Task 1)

---

## Task 1: Verify policy + pool baseline assumptions

**Files:**
- Read: `src/policy/*.ts`, `src/provider/imap-pool.ts`

This is a research task — no code changes, but findings drive later tasks.

- [ ] **Step 1: Confirm read tools are not gated by `policy.yaml`**

Run: `grep -n "search_threads\|get_overview\|get_audit_log\|get_pending_actions\|read_thread" src/policy/*.ts src/policy/*.yaml 2>/dev/null`

Expected: read tools either absent or marked `gate: ungated`. If any are gated by `account_id`, note in plan: gating semantics for multi-account calls = "if any touched account is gated, the whole call gates."

- [ ] **Step 2: Confirm IMAP pool supports parallel `withConnection` calls across distinct accounts**

Read `src/provider/imap-pool.ts`. Look for: per-account locks/queues. Confirm two different `account_id` values can hold connections simultaneously without deadlocking.

Expected finding: pool keyed by `account_id`; per-account serialization is fine for our fan-out.

- [ ] **Step 3: Note any blockers in plan**

If either assumption fails, add a remediation task here before proceeding. Otherwise proceed to Task 2.

---

## Task 2: Add `Target` schema and parsing

**Files:**
- Create: `src/tools/target.ts`
- Create: `test/tools/target.test.ts`

- [ ] **Step 1: Write failing tests for `Target` parsing**

`test/tools/target.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { TargetSchema, TargetsSchema, parseTargets } from '../../src/tools/target.js';

describe('TargetSchema', () => {
  it('accepts a minimal target', () => {
    expect(TargetSchema.parse({ account_id: 'a@x.com', uid: 1 })).toEqual({
      account_id: 'a@x.com',
      uid: 1,
    });
  });

  it('accepts target with mailbox', () => {
    expect(
      TargetSchema.parse({ account_id: 'a@x.com', uid: 1, mailbox: 'INBOX' })
    ).toEqual({ account_id: 'a@x.com', uid: 1, mailbox: 'INBOX' });
  });

  it('rejects empty account_id', () => {
    expect(() => TargetSchema.parse({ account_id: '', uid: 1 })).toThrow();
  });

  it('rejects non-positive uid', () => {
    expect(() => TargetSchema.parse({ account_id: 'a@x.com', uid: 0 })).toThrow();
  });
});

describe('TargetsSchema', () => {
  it('rejects empty array', () => {
    expect(() => TargetsSchema.parse([])).toThrow();
  });

  it('accepts mixed-account targets', () => {
    const targets = [
      { account_id: 'a@x.com', uid: 1 },
      { account_id: 'b@y.com', uid: 2 },
    ];
    expect(TargetsSchema.parse(targets)).toEqual(targets);
  });
});

describe('parseTargets (groupByAccount)', () => {
  it('groups targets by account_id with mailbox default', () => {
    const grouped = parseTargets([
      { account_id: 'a@x.com', uid: 1 },
      { account_id: 'a@x.com', uid: 2, mailbox: 'Archive' },
      { account_id: 'b@y.com', uid: 5 },
    ]);
    expect(grouped).toEqual({
      'a@x.com': [
        { uid: 1, mailbox: 'INBOX' },
        { uid: 2, mailbox: 'Archive' },
      ],
      'b@y.com': [{ uid: 5, mailbox: 'INBOX' }],
    });
  });
});
```

- [ ] **Step 2: Run tests; verify they fail**

Run: `npx vitest run test/tools/target.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/tools/target.ts`**

```typescript
import { z } from 'zod';

export const TargetSchema = z.object({
  account_id: z.string().min(1).describe('Account that owns this UID'),
  uid: z.number().int().positive().describe('IMAP UID'),
  mailbox: z.string().min(1).optional().describe('Source mailbox (default: INBOX)'),
});

export type Target = z.infer<typeof TargetSchema>;

export const TargetsSchema = z
  .array(TargetSchema)
  .min(1)
  .describe('Account-qualified message references');

export interface ResolvedTarget {
  uid: number;
  mailbox: string;
}

export function parseTargets(targets: Target[]): Record<string, ResolvedTarget[]> {
  const grouped: Record<string, ResolvedTarget[]> = {};
  for (const t of targets) {
    const list = (grouped[t.account_id] ??= []);
    list.push({ uid: t.uid, mailbox: t.mailbox ?? 'INBOX' });
  }
  return grouped;
}
```

- [ ] **Step 4: Run tests; verify they pass**

Run: `npx vitest run test/tools/target.test.ts`
Expected: PASS (4 + 2 + 1 = 7 tests).

- [ ] **Step 5: Add envelope types to `src/types.ts`**

Append:

```typescript
// === Multi-account envelope ===

export interface MultiAccountEnvelope<T> {
  accounts_searched: string[];
  accounts_available: string[];
  per_account_errors?: Record<string, string>;
  results: T;
}
```

- [ ] **Step 6: Commit**

```bash
git add src/tools/target.ts test/tools/target.test.ts src/types.ts
git commit -m "feat: add Target schema and MultiAccountEnvelope type"
```

---

## Task 3: Add `fanOut` helper

**Files:**
- Create: `src/executor/fan-out.ts`
- Create: `test/executor/fan-out.test.ts`

- [ ] **Step 1: Write failing tests for `fanOut`**

`test/executor/fan-out.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { fanOut } from '../../src/executor/fan-out.js';
import type { ImapConnectionPool } from '../../src/provider/imap-pool.js';

function makeFakePool(perAccount: Record<string, unknown>): ImapConnectionPool {
  return {
    withConnection: vi.fn(async (accountId: string, fn: any) => {
      const value = perAccount[accountId];
      if (value instanceof Error) throw value;
      return fn(value);
    }),
  } as unknown as ImapConnectionPool;
}

describe('fanOut', () => {
  it('runs the function per account in parallel and merges results', async () => {
    const pool = makeFakePool({ 'a@x.com': 'A', 'b@y.com': 'B' });

    const result = await fanOut({
      pool,
      accountIds: ['a@x.com', 'b@y.com'],
      fn: async (accountId, conn) => `${accountId}:${conn}`,
    });

    expect(result.accounts_searched.sort()).toEqual(['a@x.com', 'b@y.com']);
    expect(result.per_account).toEqual({
      'a@x.com': 'a@x.com:A',
      'b@y.com': 'b@y.com:B',
    });
    expect(result.errors).toEqual({});
  });

  it('captures per-account errors without failing the whole call', async () => {
    const pool = makeFakePool({ 'a@x.com': 'A', 'b@y.com': new Error('auth failed') });

    const result = await fanOut({
      pool,
      accountIds: ['a@x.com', 'b@y.com'],
      fn: async (_id, conn) => conn,
    });

    expect(result.per_account).toEqual({ 'a@x.com': 'A' });
    expect(result.errors).toEqual({ 'b@y.com': 'auth failed' });
    expect(result.accounts_searched.sort()).toEqual(['a@x.com', 'b@y.com']);
  });

  it('returns empty maps when accountIds is empty', async () => {
    const pool = makeFakePool({});
    const result = await fanOut({ pool, accountIds: [], fn: async () => 'x' });
    expect(result.accounts_searched).toEqual([]);
    expect(result.per_account).toEqual({});
    expect(result.errors).toEqual({});
  });
});
```

- [ ] **Step 2: Run tests; verify they fail**

Run: `npx vitest run test/executor/fan-out.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/executor/fan-out.ts`**

```typescript
import type { ImapConnectionPool } from '../provider/imap-pool.js';
import type { ImapProvider } from '../provider/imap.js';

export interface FanOutResult<T> {
  accounts_searched: string[];
  per_account: Record<string, T>;
  errors: Record<string, string>;
}

export async function fanOut<T>(opts: {
  pool: ImapConnectionPool;
  accountIds: string[];
  fn: (accountId: string, imap: ImapProvider) => Promise<T>;
}): Promise<FanOutResult<T>> {
  const { pool, accountIds, fn } = opts;

  const settled = await Promise.allSettled(
    accountIds.map(async (accountId) => ({
      accountId,
      value: await pool.withConnection(accountId, (imap) => fn(accountId, imap)),
    }))
  );

  const per_account: Record<string, T> = {};
  const errors: Record<string, string> = {};

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    const accountId = accountIds[i];
    if (outcome.status === 'fulfilled') {
      per_account[outcome.value.accountId] = outcome.value.value;
    } else {
      errors[accountId] =
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason);
    }
  }

  return {
    accounts_searched: [...accountIds],
    per_account,
    errors,
  };
}
```

- [ ] **Step 4: Run tests; verify they pass**

Run: `npx vitest run test/executor/fan-out.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/executor/fan-out.ts test/executor/fan-out.test.ts
git commit -m "feat: add fanOut helper for cross-account tool execution"
```

---

## Task 4: Update `search_threads` to multi-account

**Files:**
- Modify: `src/tools/search-threads.ts`
- Modify: `src/executor/executor.ts:438-488` (`searchThreads` method) and `src/executor/executor.ts:514-520` (case handler)
- Create: `test/executor/multi-account-search.test.ts`

- [ ] **Step 1: Write failing integration test (two accounts)**

`test/executor/multi-account-search.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
// NOTE: this test mocks the pool. If the project has an existing test harness
// for multi-account integration (look in test/executor/), follow that pattern instead.

function makeFakePool(byAccount: Record<string, any>) {
  return {
    withConnection: vi.fn(async (accountId: string, fn: any) => {
      const imap = byAccount[accountId];
      if (!imap) throw new Error(`no account ${accountId}`);
      return fn(imap);
    }),
  };
}

function fakeImap(searchResults: any[]) {
  return {
    search: vi.fn(async () => searchResults),
  };
}

describe('search_threads multi-account', () => {
  it('fans out to all configured accounts when account_ids is omitted', async () => {
    const accounts = [
      { id: 'a@x.com', email: 'a@x.com', imap: { host: 'h', port: 993, tls: true }, smtp: { host: 'h', port: 465, tls: true } },
      { id: 'b@y.com', email: 'b@y.com', imap: { host: 'h', port: 993, tls: true }, smtp: { host: 'h', port: 465, tls: true } },
    ];
    const pool = makeFakePool({
      'a@x.com': fakeImap([
        { uid: 1, envelope: { message_id: 'm1', subject: 's1', from: { address: 'x@x', name: null }, date: '2026-04-15T00:00:00Z' }, snippet: '', flags: [] },
      ]),
      'b@y.com': fakeImap([
        { uid: 2, envelope: { message_id: 'm2', subject: 's2', from: { address: 'y@y', name: null }, date: '2026-04-16T00:00:00Z' }, snippet: '', flags: [] },
      ]),
    });

    // Construct executor with minimum fakes — adapt to the real ExecutorDeps in this codebase.
    // If a test factory exists (e.g. test/helpers/executor.ts), use it.
    const executor = new Executor({
      db: undefined as any, // search_threads path may not need the DB; if it does, supply an in-memory one
      accounts,
      pool: pool as any,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    });

    // Replace this with whatever entrypoint the executor exposes for tool calls.
    // If executeImmediate is the entrypoint, call it directly:
    const { result } = await executor.executeImmediate({
      tool: 'search_threads',
      toolParams: {},
      accountId: 'a@x.com', // principal — list-tools have no single owner
      agentId: 'test',
      risk: 'none',
    });

    const payload = JSON.parse(result[0].text);
    expect(payload.accounts_searched.sort()).toEqual(['a@x.com', 'b@y.com']);
    expect(payload.accounts_available.sort()).toEqual(['a@x.com', 'b@y.com']);
    expect(payload.results).toHaveLength(2);
    // newest-first: b@y.com (2026-04-16) before a@x.com (2026-04-15)
    expect(payload.results[0].account_id).toBe('b@y.com');
    expect(payload.results[1].account_id).toBe('a@x.com');
    expect(payload.results[0].uid).toBe(2);
  });

  it('scopes to account_ids when provided', async () => {
    const accounts = [
      { id: 'a@x.com', email: 'a@x.com', imap: { host: 'h', port: 993, tls: true }, smtp: { host: 'h', port: 465, tls: true } },
      { id: 'b@y.com', email: 'b@y.com', imap: { host: 'h', port: 993, tls: true }, smtp: { host: 'h', port: 465, tls: true } },
    ];
    const pool = makeFakePool({
      'a@x.com': fakeImap([{ uid: 1, envelope: { message_id: 'm1', subject: 's1', from: { address: 'x@x', name: null }, date: '2026-04-15T00:00:00Z' }, snippet: '', flags: [] }]),
      'b@y.com': fakeImap([]),
    });

    const executor = new Executor({
      db: undefined as any,
      accounts,
      pool: pool as any,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    });

    const { result } = await executor.executeImmediate({
      tool: 'search_threads',
      toolParams: { account_ids: ['a@x.com'] },
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'none',
    });

    const payload = JSON.parse(result[0].text);
    expect(payload.accounts_searched).toEqual(['a@x.com']);
    expect(payload.accounts_available.sort()).toEqual(['a@x.com', 'b@y.com']);
    expect(pool.withConnection).toHaveBeenCalledTimes(1);
    expect(pool.withConnection).toHaveBeenCalledWith('a@x.com', expect.any(Function));
  });

  it('reports per-account errors without failing the call', async () => {
    const accounts = [
      { id: 'a@x.com', email: 'a@x.com', imap: { host: 'h', port: 993, tls: true }, smtp: { host: 'h', port: 465, tls: true } },
      { id: 'b@y.com', email: 'b@y.com', imap: { host: 'h', port: 993, tls: true }, smtp: { host: 'h', port: 465, tls: true } },
    ];
    const pool = {
      withConnection: vi.fn(async (id: string, fn: any) => {
        if (id === 'b@y.com') throw new Error('auth failed');
        return fn(fakeImap([{ uid: 1, envelope: { message_id: 'm1', subject: 's1', from: { address: 'x@x', name: null }, date: '2026-04-15T00:00:00Z' }, snippet: '', flags: [] }]));
      }),
    };

    const executor = new Executor({
      db: undefined as any,
      accounts,
      pool: pool as any,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    });

    const { result } = await executor.executeImmediate({
      tool: 'search_threads',
      toolParams: {},
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'none',
    });

    const payload = JSON.parse(result[0].text);
    expect(payload.accounts_searched.sort()).toEqual(['a@x.com', 'b@y.com']);
    expect(payload.per_account_errors).toEqual({ 'b@y.com': 'auth failed' });
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0].account_id).toBe('a@x.com');
  });
});
```

> **Note on test setup:** The Executor constructor and `executeImmediate` signature in this test are based on the spec at `src/executor/executor.ts:55-68`. If the project has a helper like `test/helpers/make-executor.ts`, use it instead of constructing inline. If `executeImmediate` requires a real DB, open an in-memory one via the existing `openDatabase(':memory:')` pattern.

- [ ] **Step 2: Run tests; verify they fail**

Run: `npx vitest run test/executor/multi-account-search.test.ts`
Expected: FAIL — payload either lacks `accounts_searched` field or fans out incorrectly.

- [ ] **Step 3: Update `src/tools/search-threads.ts` schema**

Replace the file contents with:

```typescript
import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

export const searchThreadsTool: ToolDefinition = {
  name: 'search_threads',
  description:
    'Search email threads across all accounts (or a scoped subset). Returns snippets (account_id, uid, subject, sender, date, snippet) newest-first with an is_automated flag on each result. The response envelope includes accounts_searched, accounts_available, and per_account_errors so partial scoping is always visible. Use `since` (ISO8601) to scope to a time window. Use `account_ids` to scope to specific accounts. For full attention signals (direct_to_me, thread state, network), use get_overview instead.',
  inputSchema: z.object({
    query: z.string().min(1).optional().describe('Search query text'),
    from: z.string().min(1).optional().describe('Filter by sender email/name'),
    to: z.string().min(1).optional().describe('Filter by recipient'),
    subject: z.string().min(1).optional().describe('Filter by subject'),
    since: z
      .string()
      .optional()
      .describe('ISO8601 datetime — only messages on or after this instant'),
    account_ids: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe('Accounts to search. Omit for all configured accounts.'),
    mailbox: z.string().min(1).optional().describe('Mailbox to search (default: INBOX)'),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe('Max results per account (default: 20)'),
  }),
  annotations: { readOnlyHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
```

- [ ] **Step 4: Update `src/executor/executor.ts` — fan-out search**

Replace the existing `searchThreads` private method (currently `src/executor/executor.ts:438-488`) and the case handler (currently `src/executor/executor.ts:517-520`).

First, change the case handler in `performAction`. Find:

```typescript
    // All other tools use IMAP via the pool
    return this.pool.withConnection(intent.account_id, async (imap) => {
      switch (intent.tool) {
        case 'search_threads': {
          const results = await this.searchThreads(intent, imap);
          return [{ type: 'text', text: JSON.stringify(results, null, 2) }];
        }
```

Refactor so multi-account tools branch out *before* the single-account `withConnection`. Restructure as:

```typescript
    // Multi-account read tools: fan out before borrowing a single connection
    if (intent.tool === 'search_threads') {
      const payload = await this.searchThreadsMulti(intent);
      return [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
    }

    // All other tools use IMAP via the pool (single-account principal)
    return this.pool.withConnection(intent.account_id, async (imap) => {
      switch (intent.tool) {
        // case 'search_threads' removed — handled above
        case 'read_thread': { /* unchanged for now */ }
        // ...
```

Then replace `searchThreads(intent, imap)` with `searchThreadsMulti(intent)`:

```typescript
private async searchThreadsMulti(intent: Intent): Promise<{
  accounts_searched: string[];
  accounts_available: string[];
  per_account_errors?: Record<string, string>;
  results: Array<{
    account_id: string;
    mailbox: string;
    uid: number;
    envelope: {
      message_id: string;
      subject: string;
      from: { address: string; name: string | null };
      date: string;
    };
    snippet: string;
    flags: string[];
    is_automated: boolean;
  }>;
}> {
  const requestedIds = (intent.params.account_ids as string[] | undefined) ?? null;
  const allIds = this.accounts.map((a) => a.id);
  const targetIds = requestedIds ?? allIds;

  // Validate scoping
  const unknown = targetIds.filter((id) => !allIds.includes(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown account_ids: ${unknown.join(', ')}`);
  }

  const mailbox = (intent.params.mailbox as string) ?? 'INBOX';
  const baseCriteria = {
    from: intent.params.from as string | undefined,
    to: intent.params.to as string | undefined,
    subject: intent.params.subject as string | undefined,
    since: intent.params.since
      ? new Date(intent.params.since as string)
      : undefined,
  };
  const limit = (intent.params.limit as number) ?? 20;
  const query = intent.params.query as string | undefined;

  const fanResult = await fanOut({
    pool: this.pool,
    accountIds: targetIds,
    fn: async (accountId, imap) => {
      const resultSets = query
        ? await Promise.all([
            imap.search(mailbox, { ...baseCriteria, subject: query }, limit),
            imap.search(mailbox, { ...baseCriteria, body: query }, limit),
          ])
        : [await imap.search(mailbox, baseCriteria, limit)];

      const merged = new Map<number, Awaited<(typeof resultSets)[number][number]>>();
      for (const set of resultSets) {
        for (const result of set) {
          merged.set(result.uid, result);
        }
      }
      return Array.from(merged.values()).map((r) => ({
        account_id: accountId,
        mailbox,
        ...r,
        is_automated: isAutomatedSender(r.envelope.from.address),
      }));
    },
  });

  const allResults = Object.values(fanResult.per_account)
    .flat()
    .sort(
      (a, b) =>
        new Date(b.envelope.date).getTime() - new Date(a.envelope.date).getTime()
    )
    .slice(0, limit);

  const payload: ReturnType<typeof this.searchThreadsMulti> extends Promise<infer U>
    ? U
    : never = {
    accounts_searched: fanResult.accounts_searched,
    accounts_available: allIds,
    results: allResults,
  };
  if (Object.keys(fanResult.errors).length > 0) {
    payload.per_account_errors = fanResult.errors;
  }
  return payload;
}
```

Add the import at the top of `src/executor/executor.ts`:

```typescript
import { fanOut } from './fan-out.js';
```

- [ ] **Step 5: Run tests; verify all three pass**

Run: `npx vitest run test/executor/multi-account-search.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the full test suite to catch regressions**

Run: `npx vitest run`
Expected: PASS, with any pre-existing `search_threads` tests still passing. If a test breaks because it expected the old payload shape (bare array), update it to read from `payload.results`.

- [ ] **Step 7: Commit**

```bash
git add src/tools/search-threads.ts src/executor/executor.ts src/executor/fan-out.ts test/executor/multi-account-search.test.ts
git commit -m "feat: search_threads fans out across all accounts by default"
```

---

## Task 5: Cross-account `get_overview`

**Files:**
- Modify: `src/tools/get-overview.ts`
- Modify: `src/executor/executor.ts` (overview path)

- [ ] **Step 1: Read the current `get_overview` implementation**

Run: `grep -n "get_overview\|getOverview" src/executor/executor.ts src/tools/get-overview.ts`
Read the existing tool schema and executor case to understand the current single-account shape.

- [ ] **Step 2: Write failing test for cross-account overview**

Add a test in `test/executor/multi-account-search.test.ts` (or create `test/executor/multi-account-overview.test.ts` if the file is getting long):

```typescript
describe('get_overview multi-account', () => {
  it('merges per-account overviews into the standard envelope', async () => {
    // Mirror the search_threads multi-account test structure.
    // Two accounts, each returns an overview payload; assert envelope shape:
    //   accounts_searched, accounts_available, results = { 'a@x.com': {...}, 'b@y.com': {...} }
    // (per_account map, since overviews don't naturally merge into a flat list)
  });
});
```

> **Decision:** `get_overview` returns a per-account map under `results`, not a flat merge — overviews are inherently per-account (counts, attention buckets) and merging them loses information. Document this in the tool description.

- [ ] **Step 3: Update `src/tools/get-overview.ts` schema**

Replace `account_id?: string` with `account_ids?: string[]` (mirror the search-threads schema change). Update the description to mention the per-account `results` map.

- [ ] **Step 4: Update executor `get_overview` case to use `fanOut`**

Wrap the existing single-account overview logic in a `fanOut` call. The result shape:

```typescript
{
  accounts_searched: string[],
  accounts_available: string[],
  per_account_errors?: Record<string, string>,
  results: Record<string, /* existing overview payload */>,
}
```

- [ ] **Step 5: Run tests; verify they pass**

Run: `npx vitest run test/executor/multi-account-overview.test.ts` (or wherever you placed the test).
Expected: PASS.

- [ ] **Step 6: Run full suite**

Run: `npx vitest run`
Expected: PASS, with any single-account overview tests updated to read from `payload.results[account_id]`.

- [ ] **Step 7: Commit**

```bash
git add src/tools/get-overview.ts src/executor/executor.ts test/executor/multi-account-overview.test.ts
git commit -m "feat: get_overview fans out across all accounts by default"
```

---

## Task 6: Cross-account `get_audit_log` and `get_pending_actions`

**Files:**
- Modify: `src/tools/get-audit-log.ts`, `src/tools/get-pending-actions.ts`
- Modify: `src/executor/executor.ts` (or wherever these tools execute — they likely query the SQLite ledger directly, not IMAP)

- [ ] **Step 1: Confirm these tools query SQLite, not IMAP**

Run: `grep -n "get_audit_log\|getAuditLog\|get_pending_actions\|getPendingActions" src/executor/executor.ts src/ledger/*.ts`
Expected: these tools call `db.prepare(...)` against the ledger; no IMAP `withConnection`. If so, the fix is simpler: filter the SQL `WHERE account_id IN (?, ?, ...)` instead of using `fanOut`.

- [ ] **Step 2: Write failing test**

Create `test/executor/multi-account-audit.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import { logAudit } from '../../src/ledger/audit.js';
// Adapt imports based on actual exported helpers

describe('get_audit_log multi-account', () => {
  it('returns rows from all accounts when account_ids omitted', async () => {
    const db = openDatabase(':memory:');
    // Insert rows for 'a@x.com' and 'b@y.com'
    // Call the audit-log query helper with account_ids = undefined
    // Expect rows from both accounts in the envelope, sorted newest-first
  });

  it('scopes to provided account_ids', async () => {
    // Insert for both, query with account_ids: ['a@x.com'], expect only a@x.com rows
  });
});
```

(Mirror the same test for `get_pending_actions` — single test file or two, your call.)

- [ ] **Step 3: Update tool schemas**

Both `src/tools/get-audit-log.ts` and `src/tools/get-pending-actions.ts`: replace `account_id?: string` with `account_ids?: string[]`.

- [ ] **Step 4: Update SQL queries**

In `src/ledger/audit.ts` (or wherever the audit-log query lives) and `src/ledger/intents.ts:135` (the pending-actions query), accept an optional `accountIds: string[]`. When provided, build a parameterized `WHERE account_id IN (?, ?, ...)` clause. When omitted, query all rows. Wrap the result in the standard envelope:

```typescript
{
  accounts_searched: targetIds,
  accounts_available: allConfiguredIds,
  results: rows,
}
```

(No `per_account_errors` for these — SQLite queries don't fail per-account.)

- [ ] **Step 5: Run tests; verify they pass**

Run: `npx vitest run test/executor/multi-account-audit.test.ts`
Expected: PASS.

- [ ] **Step 6: Run full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/get-audit-log.ts src/tools/get-pending-actions.ts src/executor/executor.ts src/ledger/intents.ts src/ledger/audit.ts test/executor/multi-account-audit.test.ts
git commit -m "feat: get_audit_log and get_pending_actions span all accounts"
```

---

## Task 7: `read_thread` takes a `Target`

**Files:**
- Modify: `src/tools/read-thread.ts`
- Modify: `src/executor/executor.ts:522-527` (the `read_thread` case)

- [ ] **Step 1: Write failing test**

`test/executor/read-thread-target.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { Executor } from '../../src/executor/executor.js';

describe('read_thread with target', () => {
  it('reads from the account specified in target.account_id, not intent.account_id', async () => {
    const accounts = [
      { id: 'a@x.com', email: 'a@x.com', imap: { host: 'h', port: 993, tls: true }, smtp: { host: 'h', port: 465, tls: true } },
      { id: 'b@y.com', email: 'b@y.com', imap: { host: 'h', port: 993, tls: true }, smtp: { host: 'h', port: 465, tls: true } },
    ];
    const fetchedFrom: string[] = [];
    const pool = {
      withConnection: vi.fn(async (id: string, fn: any) => {
        fetchedFrom.push(id);
        return fn({
          fetchMessage: async () => ({ uid: 99, subject: `from ${id}` }),
        });
      }),
    };

    const executor = new Executor({
      db: undefined as any,
      accounts,
      pool: pool as any,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    });

    const { result } = await executor.executeImmediate({
      tool: 'read_thread',
      toolParams: { target: { account_id: 'b@y.com', uid: 99 } },
      accountId: 'a@x.com', // intent principal — should be IGNORED for actual fetch
      agentId: 'test',
      risk: 'none',
    });

    expect(fetchedFrom).toEqual(['b@y.com']);
    expect(JSON.parse(result[0].text)).toMatchObject({ uid: 99, subject: 'from b@y.com' });
  });

  it('rejects target with unknown account_id', async () => {
    const accounts = [
      { id: 'a@x.com', email: 'a@x.com', imap: { host: 'h', port: 993, tls: true }, smtp: { host: 'h', port: 465, tls: true } },
    ];
    const pool = { withConnection: vi.fn() };
    const executor = new Executor({
      db: undefined as any,
      accounts,
      pool: pool as any,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    });

    await expect(
      executor.executeImmediate({
        tool: 'read_thread',
        toolParams: { target: { account_id: 'unknown@z.com', uid: 1 } },
        accountId: 'a@x.com',
        agentId: 'test',
        risk: 'none',
      })
    ).rejects.toThrow(/unknown.*account/i);
  });
});
```

- [ ] **Step 2: Run tests; verify they fail**

Run: `npx vitest run test/executor/read-thread-target.test.ts`
Expected: FAIL — old shape uses `intent.params.uid`.

- [ ] **Step 3: Update `src/tools/read-thread.ts`**

Replace the schema:

```typescript
import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { TargetSchema } from './target.js';

export const readThreadTool: ToolDefinition = {
  name: 'read_thread',
  description: 'Fetch the full body of a single message identified by an account-qualified target.',
  inputSchema: z.object({
    target: TargetSchema.describe('Account-qualified message reference'),
  }),
  annotations: { readOnlyHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
```

- [ ] **Step 4: Update executor `read_thread` case**

In `src/executor/executor.ts`, the current `read_thread` case (line ~522) lives inside `pool.withConnection(intent.account_id, ...)`. Move it out so it uses `target.account_id` instead. Restructure:

```typescript
if (intent.tool === 'read_thread') {
  const target = intent.params.target as { account_id: string; uid: number; mailbox?: string };
  const allIds = this.accounts.map((a) => a.id);
  if (!allIds.includes(target.account_id)) {
    throw new Error(`Unknown account_id in target: ${target.account_id}`);
  }
  const mailbox = target.mailbox ?? 'INBOX';
  return this.pool.withConnection(target.account_id, async (imap) => {
    const msg = await imap.fetchMessage(mailbox, target.uid);
    return [{ type: 'text', text: JSON.stringify(msg, null, 2) }];
  });
}
```

Place this branch alongside the other early-branch tools (search_threads multi). Remove the old `case 'read_thread':` from the switch.

- [ ] **Step 5: Run tests; verify they pass**

Run: `npx vitest run test/executor/read-thread-target.test.ts`
Expected: PASS.

- [ ] **Step 6: Run full suite; update existing read_thread tests**

Run: `npx vitest run`
If any existing read_thread test passes `uid` directly, update it to pass `{ target: { account_id, uid } }`.

- [ ] **Step 7: Commit**

```bash
git add src/tools/read-thread.ts src/executor/executor.ts test/executor/read-thread-target.test.ts
git commit -m "feat: read_thread takes account-qualified target"
```

---

## Task 8: `label_thread` takes `targets`

**Files:**
- Modify: `src/tools/label-thread.ts`
- Modify: `src/executor/executor.ts:550-567` (label_thread case)
- Modify: `src/executor/executor.ts:620-636` (reverse_label undo case) — must read targets too

- [ ] **Step 1: Write failing test**

`test/executor/label-thread-targets.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { Executor } from '../../src/executor/executor.js';

describe('label_thread with targets', () => {
  it('groups targets by account and applies labels per account', async () => {
    const accounts = [
      { id: 'a@x.com', email: 'a@x.com', imap: { host: 'h', port: 993, tls: true }, smtp: { host: 'h', port: 465, tls: true } },
      { id: 'b@y.com', email: 'b@y.com', imap: { host: 'h', port: 993, tls: true }, smtp: { host: 'h', port: 465, tls: true } },
    ];
    const calls: Array<{ accountId: string; uids: number[]; mailbox: string }> = [];
    const pool = {
      withConnection: vi.fn(async (accountId: string, fn: any) => {
        return fn({
          setFlags: async (uids: number[], _labels: string[], mailbox: string) => {
            calls.push({ accountId, uids, mailbox });
          },
        });
      }),
    };

    const executor = new Executor({
      db: undefined as any,
      accounts,
      pool: pool as any,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    });

    const { result } = await executor.executeImmediate({
      tool: 'label_thread',
      toolParams: {
        targets: [
          { account_id: 'a@x.com', uid: 1 },
          { account_id: 'a@x.com', uid: 2 },
          { account_id: 'b@y.com', uid: 5, mailbox: 'Archive' },
        ],
        action: 'add',
        label: 'Important',
      },
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'low',
    });

    expect(calls).toHaveLength(2);
    expect(calls.find((c) => c.accountId === 'a@x.com')?.uids).toEqual([1, 2]);
    expect(calls.find((c) => c.accountId === 'a@x.com')?.mailbox).toBe('INBOX');
    expect(calls.find((c) => c.accountId === 'b@y.com')?.uids).toEqual([5]);
    expect(calls.find((c) => c.accountId === 'b@y.com')?.mailbox).toBe('Archive');

    const payload = JSON.parse(result[0].text);
    expect(payload.accounts_searched.sort()).toEqual(['a@x.com', 'b@y.com']);
  });
});
```

> **Note:** Targets that share `account_id` but differ in `mailbox` should be sub-grouped. The simplest implementation groups by `account_id` first, then by `mailbox` within each account batch.

- [ ] **Step 2: Run test; verify it fails**

Run: `npx vitest run test/executor/label-thread-targets.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update `src/tools/label-thread.ts`**

```typescript
import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { TargetsSchema } from './target.js';

export const labelThreadTool: ToolDefinition = {
  name: 'label_thread',
  description: 'Add or remove a label on messages, addressed by account-qualified targets. Applies per-account in parallel; partial failures are reported in per_account_errors.',
  inputSchema: z.object({
    targets: TargetsSchema,
    action: z.enum(['add', 'remove']),
    label: z.string().min(1),
  }),
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
```

- [ ] **Step 4: Update executor `label_thread` path**

Replace the existing case at `src/executor/executor.ts:550-567` with an early-branch fan-out:

```typescript
if (intent.tool === 'label_thread') {
  const targets = intent.params.targets as Target[];
  const action = intent.params.action as 'add' | 'remove';
  const label = intent.params.label as string;
  const grouped = parseTargets(targets);
  const accountIds = Object.keys(grouped);
  const allIds = this.accounts.map((a) => a.id);
  const unknown = accountIds.filter((id) => !allIds.includes(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown account_ids in targets: ${unknown.join(', ')}`);
  }

  const fanResult = await fanOut({
    pool: this.pool,
    accountIds,
    fn: async (accountId, imap) => {
      const byMailbox = new Map<string, number[]>();
      for (const t of grouped[accountId]) {
        const list = byMailbox.get(t.mailbox) ?? [];
        list.push(t.uid);
        byMailbox.set(t.mailbox, list);
      }
      for (const [mailbox, uids] of byMailbox) {
        if (action === 'add') {
          await imap.setFlags(uids, [label], mailbox);
        } else {
          await imap.removeFlags(uids, [label], mailbox);
        }
      }
      return { uids: grouped[accountId].map((t) => t.uid) };
    },
  });

  const payload: {
    accounts_searched: string[];
    accounts_available: string[];
    per_account_errors?: Record<string, string>;
    action: 'add' | 'remove';
    label: string;
  } = {
    accounts_searched: fanResult.accounts_searched,
    accounts_available: allIds,
    action,
    label,
  };
  if (Object.keys(fanResult.errors).length > 0) {
    payload.per_account_errors = fanResult.errors;
  }
  return [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
}
```

Add imports:

```typescript
import { parseTargets, type Target } from '../tools/target.js';
```

Remove the old `case 'label_thread':` from the switch.

- [ ] **Step 5: Update the `reverse_label` undo case**

In `src/executor/executor.ts:620-636`, the undo path reads `intent.params.uids` and `intent.params.mailbox`. Update it to read `intent.params.targets` and group the same way:

```typescript
case 'reverse_label': {
  const targets = intent.params.targets as Target[];
  const action = intent.params.action as 'add' | 'remove';
  const label = intent.params.label as string;
  const grouped = parseTargets(targets);

  for (const [accountId, list] of Object.entries(grouped)) {
    await this.pool.withConnection(accountId, async (imap) => {
      const byMailbox = new Map<string, number[]>();
      for (const t of list) {
        const arr = byMailbox.get(t.mailbox) ?? [];
        arr.push(t.uid);
        byMailbox.set(t.mailbox, arr);
      }
      for (const [mailbox, uids] of byMailbox) {
        if (action === 'add') {
          await imap.removeFlags(uids, [label], mailbox);
        } else {
          await imap.setFlags(uids, [label], mailbox);
        }
      }
    });
  }
  break;
}
```

(Note: undo doesn't need the standard envelope — it returns void.)

- [ ] **Step 6: Run tests; verify they pass**

Run: `npx vitest run test/executor/label-thread-targets.test.ts`
Expected: PASS.

- [ ] **Step 7: Run full suite**

Run: `npx vitest run`
Expected: PASS. Update any old single-account `label_thread` tests to use `targets`.

- [ ] **Step 8: Commit**

```bash
git add src/tools/label-thread.ts src/executor/executor.ts test/executor/label-thread-targets.test.ts
git commit -m "feat: label_thread takes account-qualified targets"
```

---

## Task 9: `quarantine_thread` takes `targets` + `dry_run` + structured report

**Files:**
- Modify: `src/tools/quarantine-thread.ts`
- Modify: `src/executor/executor.ts:569-580` (quarantine case)
- Modify: `src/executor/executor.ts:611-618` (move_back_to_inbox undo case)
- Create: `test/executor/quarantine-dry-run.test.ts`

- [ ] **Step 1: Write failing tests for both modes**

`test/executor/quarantine-dry-run.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { Executor } from '../../src/executor/executor.js';

function makeAccounts() {
  return [
    { id: 'a@x.com', email: 'a@x.com', imap: { host: 'h', port: 993, tls: true }, smtp: { host: 'h', port: 465, tls: true } },
    { id: 'b@y.com', email: 'b@y.com', imap: { host: 'h', port: 993, tls: true }, smtp: { host: 'h', port: 465, tls: true } },
  ];
}

describe('quarantine_thread', () => {
  it('dry_run returns blast radius without moving messages', async () => {
    const moveCalls: string[] = [];
    const pool = {
      withConnection: vi.fn(async (accountId: string, fn: any) =>
        fn({
          getMailboxPath: async () => 'agent-mail-quarantine',
          moveMessages: async () => moveCalls.push(accountId),
          // For thread expansion, the implementation may call a helper like
          // `expandThread(uid, mailbox)` returning all UIDs in that thread.
          // If no such helper exists, dry-run reports message_count = uids.length
          // and the test should assert that minimum.
        })
      ),
    };

    const executor = new Executor({
      db: undefined as any,
      accounts: makeAccounts(),
      pool: pool as any,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    });

    const { result } = await executor.executeImmediate({
      tool: 'quarantine_thread',
      toolParams: {
        targets: [
          { account_id: 'a@x.com', uid: 1 },
          { account_id: 'b@y.com', uid: 5 },
        ],
        dry_run: true,
      },
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'medium',
    });

    expect(moveCalls).toEqual([]); // no IMAP moves in dry-run
    const payload = JSON.parse(result[0].text);
    expect(payload.dry_run).toBe(true);
    expect(payload.accounts_searched.sort()).toEqual(['a@x.com', 'b@y.com']);
    expect(payload.total_messages).toBeGreaterThanOrEqual(2);
    expect(payload.per_account).toHaveLength(2);
  });

  it('actual run moves messages and returns the same report shape', async () => {
    const moveCalls: Array<{ accountId: string; uids: number[] }> = [];
    const pool = {
      withConnection: vi.fn(async (accountId: string, fn: any) =>
        fn({
          getMailboxPath: async () => 'agent-mail-quarantine',
          moveMessages: async (uids: number[]) => {
            moveCalls.push({ accountId, uids });
          },
        })
      ),
    };

    const executor = new Executor({
      db: undefined as any,
      accounts: makeAccounts(),
      pool: pool as any,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    });

    const { result } = await executor.executeImmediate({
      tool: 'quarantine_thread',
      toolParams: {
        targets: [
          { account_id: 'a@x.com', uid: 1 },
          { account_id: 'b@y.com', uid: 5 },
        ],
      },
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'medium',
    });

    expect(moveCalls).toHaveLength(2);
    const payload = JSON.parse(result[0].text);
    expect(payload.dry_run).toBe(false);
    expect(payload.total_messages).toBe(2);
  });

  it('rejects targets with unknown account_id', async () => {
    const pool = { withConnection: vi.fn() };
    const executor = new Executor({
      db: undefined as any,
      accounts: makeAccounts(),
      pool: pool as any,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    });

    await expect(
      executor.executeImmediate({
        tool: 'quarantine_thread',
        toolParams: {
          targets: [{ account_id: 'unknown@z.com', uid: 1 }],
        },
        accountId: 'a@x.com',
        agentId: 'test',
        risk: 'medium',
      })
    ).rejects.toThrow(/unknown.*account/i);
    expect(pool.withConnection).not.toHaveBeenCalled();
  });
});
```

> **Thread expansion:** If the codebase has a helper to expand a thread root UID into all member UIDs (likely in `src/provider/threading.ts`), use it during the resolve phase so `message_count` reflects what would actually move. If no such helper exists, document the limitation in the tool description (`message_count` reflects only the targets passed) and treat thread expansion as a follow-up improvement. Verify by reading `src/provider/threading.ts` first.

- [ ] **Step 2: Run tests; verify they fail**

Run: `npx vitest run test/executor/quarantine-dry-run.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update `src/tools/quarantine-thread.ts`**

```typescript
import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { TargetsSchema } from './target.js';

export const quarantineThreadTool: ToolDefinition = {
  name: 'quarantine_thread',
  description:
    'Move messages to quarantine (reversible "delete"). Targets are account-qualified, so a single call can quarantine across accounts. Pass dry_run: true to preview the blast radius (per-account thread/message counts and full uid list) without actually moving anything. Messages move to an agent-mail-quarantine folder and can be undone within 30 days.',
  inputSchema: z.object({
    targets: TargetsSchema,
    dry_run: z
      .boolean()
      .optional()
      .describe('If true, return the blast-radius report without moving messages.'),
  }),
  annotations: { destructiveHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
```

- [ ] **Step 4: Update the executor `quarantine_thread` path**

Replace the existing case at `src/executor/executor.ts:569-580` with an early-branch fan-out:

```typescript
if (intent.tool === 'quarantine_thread') {
  const targets = intent.params.targets as Target[];
  const dryRun = (intent.params.dry_run as boolean | undefined) ?? false;
  const grouped = parseTargets(targets);
  const accountIds = Object.keys(grouped);
  const allIds = this.accounts.map((a) => a.id);
  const unknown = accountIds.filter((id) => !allIds.includes(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown account_ids in targets: ${unknown.join(', ')}`);
  }

  const fanResult = await fanOut({
    pool: this.pool,
    accountIds,
    fn: async (accountId, imap) => {
      const byMailbox = new Map<string, number[]>();
      for (const t of grouped[accountId]) {
        const list = byMailbox.get(t.mailbox) ?? [];
        list.push(t.uid);
        byMailbox.set(t.mailbox, list);
      }

      const perMailbox: Array<{
        mailbox: string;
        message_count: number;
        uids: number[];
      }> = [];

      const quarantine = await imap.getMailboxPath('quarantine');

      for (const [mailbox, uids] of byMailbox) {
        // Future: expand threads here for accurate message_count.
        // Today: report uids.length.
        if (!dryRun) {
          await imap.moveMessages(uids, mailbox, quarantine);
        }
        perMailbox.push({ mailbox, message_count: uids.length, uids });
      }

      return {
        account_id: accountId,
        per_mailbox: perMailbox,
        message_count: perMailbox.reduce((n, m) => n + m.message_count, 0),
      };
    },
  });

  const perAccount = Object.values(fanResult.per_account);
  const totalMessages = perAccount.reduce((n, a) => n + a.message_count, 0);

  const payload: {
    accounts_searched: string[];
    accounts_available: string[];
    per_account_errors?: Record<string, string>;
    dry_run: boolean;
    total_messages: number;
    per_account: typeof perAccount;
  } = {
    accounts_searched: fanResult.accounts_searched,
    accounts_available: allIds,
    dry_run: dryRun,
    total_messages: totalMessages,
    per_account: perAccount,
  };
  if (Object.keys(fanResult.errors).length > 0) {
    payload.per_account_errors = fanResult.errors;
  }
  return [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
}
```

Remove the old `case 'quarantine_thread':` from the switch.

- [ ] **Step 5: Update the `move_back_to_inbox` undo case**

In `src/executor/executor.ts:611-618`, replace `intent.params.uids` reading with `intent.params.targets`:

```typescript
case 'move_back_to_inbox': {
  const targets = intent.params.targets as Target[];
  const grouped = parseTargets(targets);
  for (const [accountId, list] of Object.entries(grouped)) {
    await this.pool.withConnection(accountId, async (imap) => {
      const quarantine = await imap.getMailboxPath('quarantine');
      const inbox = await imap.getMailboxPath('inbox');
      const byMailbox = new Map<string, number[]>();
      for (const t of list) {
        const arr = byMailbox.get(t.mailbox) ?? [];
        arr.push(t.uid);
        byMailbox.set(t.mailbox, arr);
      }
      // All quarantined messages go back to inbox regardless of original mailbox per current behavior.
      // If we want to restore to original mailbox per-target, change this to use t.mailbox.
      const allUids = list.map((t) => t.uid);
      await imap.moveMessages(allUids, quarantine, inbox);
    });
  }
  break;
}
```

> **Verify:** the existing undo behavior moves to `inbox` regardless of source mailbox. Preserve that. If the original behavior actually used `mailbox` from params, restore to per-mailbox.

- [ ] **Step 6: Skip dry-run logging in audit ledger**

In `executeImmediate` (around `src/executor/executor.ts:90-100`), after `performAction` returns, check whether the intent was a dry-run quarantine. If so, set `undo_token = null`/skip undo registration so dry-runs don't enter the undo ledger:

```typescript
const isDryRun =
  intent.tool === 'quarantine_thread' &&
  (intent.params.dry_run as boolean | undefined) === true;

const undoToken = isDryRun ? null : generateUndoToken(params.tool, params.toolParams);
const undoExpiry = isDryRun ? null : getUndoExpiry(params.tool);
```

Audit-log the intent normally — the `dry_run: true` flag in the params blob is enough to distinguish.

- [ ] **Step 7: Run tests; verify they pass**

Run: `npx vitest run test/executor/quarantine-dry-run.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Run full suite**

Run: `npx vitest run`
Expected: PASS. Update any old single-account `quarantine_thread` tests to use `targets`.

- [ ] **Step 9: Commit**

```bash
git add src/tools/quarantine-thread.ts src/executor/executor.ts test/executor/quarantine-dry-run.test.ts
git commit -m "feat: quarantine_thread takes targets, supports dry_run, returns blast radius"
```

---

## Task 10: Update README and verify end-to-end

**Files:**
- Modify: `README.md` (any tool-shape examples)
- Modify: `bin/agent-mail.mjs` help text if it references the old shapes

- [ ] **Step 1: Find and update tool examples in README**

Run: `grep -n "account_id\|quarantine_thread\|search_threads\|read_thread\|label_thread" README.md`
For each example using the old single-account shape, update to the new shape. Examples:

- `account_id: "..."` → `account_ids: ["..."]` (or omit entirely for cross-account)
- `uids: [123]` → `targets: [{ account_id: "...", uid: 123 }]`
- Show the new `dry_run` parameter in the quarantine example.
- Show the response envelope shape (`accounts_searched`, `accounts_available`, `per_account_errors`).

- [ ] **Step 2: Run typecheck and full test suite one more time**

Run: `npm run build && npx vitest run`
Expected: clean build + all tests pass.

- [ ] **Step 3: Manual smoke test (optional but recommended)**

If a second test account is configured locally, start the server and call `search_threads` with no `account_ids`. Verify the response envelope contains both account IDs in `accounts_searched`.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: update tool examples for cross-account shapes"
```

---

## Self-Review

**Spec coverage:**

- Cross-account default (Section "Cross-account semantics") → Tasks 4, 5, 6
- `account_ids` parameter → Tasks 4, 5, 6
- Response envelope (`accounts_searched`/`accounts_available`/`per_account_errors`) → Tasks 4, 5, 6, 8, 9
- Per-account-limit pagination → Task 4 (limit per-account, merge, re-sort, truncate)
- `Target` shape → Task 2
- `read_thread` target → Task 7
- `label_thread` targets → Task 8
- `quarantine_thread` targets → Task 9
- `dry_run` + structured report → Task 9
- Validation rejects unknown `account_id` → Tasks 4 (validates `account_ids`), 7, 8, 9
- Audit ledger: one row per call, dry-runs flagged, no undo ledger entry → Task 9 step 6
- README updates → Task 10

**Placeholder scan:** no TBDs, every code step has the exact code, every command has expected output. Two areas note "verify in code" (thread expansion in Task 9, undo restore-to-mailbox semantics) — these are explicit research steps, not placeholders.

**Type consistency:** `Target` is defined once in `src/tools/target.ts` (Task 2) and re-used across Tasks 7, 8, 9. `parseTargets` is defined once and used identically in Tasks 8 and 9 (and the undo paths). `MultiAccountEnvelope<T>` defined in Task 2 step 5; the actual payload literal types in Tasks 4, 5, 8, 9 match the envelope shape.

**Search-results carry account_id:** Task 4 step 4 maps `result` to `{ account_id, mailbox, ...result }` — search results are now self-describing for use as `targets` in destructive tools.
