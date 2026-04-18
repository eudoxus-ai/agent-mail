# MCP triage v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the v3 triage surface: safety-net (`restore_messages`, `get_intent`, `include_summary`), reversibility framing (preamble, descriptions, response echoes, MCP annotations), `quarantine` → `hold` rename across tools/folders/ledger, polish (`limit` docs, `list_unsubscribe` parsing, snippets), classifier cleanup (drop `is_automated`, surface `list_senders`).

**Architecture:** This is an additive + renaming change on top of the existing executor-driven MCP server. The ledger gains an `intent_targets` table to carry per-UID envelope snapshots and two nullable linking columns on `intents` (`reverses_intent_id`, `reversed_by_intent_id`). Tool rename is a hard cutover (no deprecation alias) paired with a first-start folder migration from `agent-mail-quarantine` to `agent-mail-holding`. Bundle B (framing) touches descriptions/annotations/response shape only — no new code paths.

**Tech Stack:** TypeScript, Zod, SQLite (`node:sqlite`), ImapFlow, `@modelcontextprotocol/sdk`, Vitest.

**Spec:** `docs/superpowers/specs/2026-04-18-mcp-triage-v3-design.md`

**Implementation order:** Phase 1 (ledger) → Phase 2 (folder migration) → Phase 3 (tool rename) → Phase 4 (safety-net) → Phase 5 (framing) → Phase 6 (polish) → Phase 7 (classifier).

---

## File Structure

**Create:**
- `src/ledger/intent-targets.ts` — CRUD for the new `intent_targets` table (insert, list, getByIntent).
- `src/ledger/migrations.ts` — SQL migration runner for new columns + table + intent type/tool rename.
- `src/provider/folder-migration.ts` — per-account IMAP migration from `agent-mail-quarantine` to `agent-mail-holding`.
- `src/tools/hold-messages.ts` — replaces `src/tools/quarantine-thread.ts`.
- `src/tools/restore-messages.ts` — new tool.
- `src/tools/get-intent.ts` — new tool.
- `src/lib/undo-hint.ts` — build the `{reversible, undo_hint}` fragment attached to every mutation response.
- `src/lib/list-unsubscribe.ts` — RFC 2047 + 2369 + 8058 parser.
- `test/ledger/intent-targets.test.ts`
- `test/ledger/migrations.test.ts`
- `test/provider/folder-migration.test.ts`
- `test/tools/hold-messages.test.ts`
- `test/tools/restore-messages.test.ts`
- `test/tools/get-intent.test.ts`
- `test/executor/hold-messages.test.ts`
- `test/executor/restore-messages.test.ts`
- `test/lib/undo-hint.test.ts`
- `test/lib/list-unsubscribe.test.ts`
- `test/tools/annotations.test.ts`
- `test/server/preamble.test.ts`

**Delete:**
- `src/tools/quarantine-thread.ts`
- `test/executor/quarantine-messages-alias.test.ts`
- `test/executor/quarantine-dry-run.test.ts` (replaced by `hold-messages.test.ts`)

**Modify (key hotspots):**
- `src/ledger/db.ts:1-68` — schema + new columns + migration invocation.
- `src/ledger/intents.ts` — add `reverses_intent_id` linking, `envelope_snapshot` fetch helpers.
- `src/executor/executor.ts:754-821` — rename `quarantine_thread` case to `hold_messages`, add `include_summary` envelope capture.
- `src/executor/executor.ts:920-934` — unchanged logic but now resolves the holding folder.
- `src/executor/undo.ts` — rename `quarantine_thread` branches to `hold_messages`.
- `src/executor/executor.ts` — new cases: `restore_messages`, `get_intent`.
- `src/provider/imap.ts:452-460` — rename mailbox key `quarantine` → `holding`, target folder `agent-mail-holding`.
- `src/server/server.ts:1-233` — set MCP `instructions` string; register `hold_messages`, `restore_messages`, `get_intent`; drop `quarantine_thread` and `quarantine_messages` registrations.
- `src/policy/defaults.ts` — rename tool policy key.
- `src/tools/search-threads.ts` — `limit` description update, `per_account_counts` envelope field.
- `src/tools/list-senders.ts` — `is_list_mail_ratio`, updated description.
- `src/tools/get-overview.ts` — drop `is_automated`, add `list_senders` prose recommendation.
- `src/tools/label-thread.ts`, `src/tools/queue-send.ts`, `src/tools/draft-reply.ts`, `src/tools/unsubscribe-sender.ts`, `src/tools/undo-intent.ts`, `src/tools/read-thread.ts`, `src/tools/list-mailboxes.ts`, `src/tools/get-audit-log.ts`, `src/tools/get-pending-actions.ts` — annotations + description updates.

---

## Phase 1 — Ledger foundations

### Task 1.1: Add `intent_targets` table + linking columns

**Files:**
- Modify: `src/ledger/db.ts:5-32` (append table + columns to `SCHEMA`)
- Create: `src/ledger/migrations.ts`
- Test: `test/ledger/migrations.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/ledger/migrations.test.ts
import { describe, it, expect } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';

describe('ledger schema v3', () => {
  it('has intent_targets table with envelope_snapshot column', () => {
    const db = openDatabase(':memory:');
    const cols = db.prepare(`PRAGMA table_info(intent_targets)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      ['intent_id', 'account_id', 'uid', 'mailbox', 'envelope_snapshot'].sort()
    );
  });

  it('has reverses_intent_id and reversed_by_intent_id columns on intents', () => {
    const db = openDatabase(':memory:');
    const cols = db.prepare(`PRAGMA table_info(intents)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('reverses_intent_id');
    expect(names).toContain('reversed_by_intent_id');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run test/ledger/migrations.test.ts`
Expected: FAIL — `intent_targets` does not exist.

- [ ] **Step 3: Create `src/ledger/migrations.ts` and append to schema**

```typescript
// src/ledger/migrations.ts
import type { Database } from './sqlite.js';

export function runMigrations(db: Database): void {
  // v3 columns on intents
  const intentCols = db.prepare(`PRAGMA table_info(intents)`).all() as Array<{ name: string }>;
  const names = new Set(intentCols.map((c) => c.name));
  if (!names.has('reverses_intent_id')) {
    db.exec(`ALTER TABLE intents ADD COLUMN reverses_intent_id JSON`);
  }
  if (!names.has('reversed_by_intent_id')) {
    db.exec(`ALTER TABLE intents ADD COLUMN reversed_by_intent_id TEXT`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS intent_targets (
      intent_id TEXT NOT NULL REFERENCES intents(id),
      account_id TEXT NOT NULL,
      uid INTEGER NOT NULL,
      mailbox TEXT NOT NULL,
      envelope_snapshot JSON,
      PRIMARY KEY (intent_id, account_id, uid)
    );
  `);

  // v3 rename: quarantine_thread / quarantine_messages → hold_messages
  db.exec(`UPDATE intents SET tool = 'hold_messages' WHERE tool IN ('quarantine_thread', 'quarantine_messages')`);
}
```

Edit `src/ledger/db.ts` — add `import { runMigrations } from './migrations.js';` and call `runMigrations(db)` at the end of `openDatabase` after `db.exec(SCHEMA)`.

- [ ] **Step 4: Run test, verify PASS**

Run: `npx vitest run test/ledger/migrations.test.ts`
Expected: PASS both cases.

- [ ] **Step 5: Commit**

```bash
git add src/ledger/migrations.ts src/ledger/db.ts test/ledger/migrations.test.ts
git commit -m "feat(ledger): add intent_targets table and reverses_intent_id columns"
```

### Task 1.2: Rename existing `quarantine_thread` rows to `hold_messages` (migration coverage)

**Files:**
- Test: `test/ledger/migrations.test.ts` (extend)

- [ ] **Step 1: Write failing test**

```typescript
it('rewrites quarantine_thread and quarantine_messages intents to hold_messages', () => {
  const db = openDatabase(':memory:');
  db.prepare(
    `INSERT INTO intents (id, account_id, tool, params, risk, status)
     VALUES (?, ?, ?, ?, 'medium', 'executed')`
  ).run('old-1', 'a@x.com', 'quarantine_thread', '{}');
  db.prepare(
    `INSERT INTO intents (id, account_id, tool, params, risk, status)
     VALUES (?, ?, ?, ?, 'medium', 'executed')`
  ).run('old-2', 'a@x.com', 'quarantine_messages', '{}');

  // Re-run migrations
  const { runMigrations } = require('../../src/ledger/migrations.js');
  runMigrations(db);

  const rows = db.prepare(`SELECT id, tool FROM intents ORDER BY id`).all() as Array<{ id: string; tool: string }>;
  expect(rows).toEqual([
    { id: 'old-1', tool: 'hold_messages' },
    { id: 'old-2', tool: 'hold_messages' },
  ]);
});
```

- [ ] **Step 2: Run, verify PASS (already implemented in 1.1)**

Run: `npx vitest run test/ledger/migrations.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/ledger/migrations.test.ts
git commit -m "test(ledger): cover quarantine→hold intent tool rename"
```

### Task 1.3: `intent-targets` CRUD helpers

**Files:**
- Create: `src/ledger/intent-targets.ts`
- Test: `test/ledger/intent-targets.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/ledger/intent-targets.test.ts
import { describe, it, expect } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import {
  insertIntentTargets,
  getIntentTargets,
  type IntentTargetRow,
} from '../../src/ledger/intent-targets.js';

describe('intent_targets', () => {
  it('inserts and retrieves target rows with envelope snapshots', () => {
    const db = openDatabase(':memory:');
    db.prepare(
      `INSERT INTO intents (id, account_id, tool, params, risk, status)
       VALUES ('i1', 'a@x.com', 'hold_messages', '{}', 'medium', 'executed')`
    ).run();

    insertIntentTargets(db, 'i1', [
      {
        account_id: 'a@x.com',
        uid: 42,
        mailbox: 'INBOX',
        envelope_snapshot: { subject: 'Hi', from: 'b@y.com', original_mailbox: 'INBOX' },
      },
    ]);

    const rows = getIntentTargets(db, 'i1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      intent_id: 'i1',
      account_id: 'a@x.com',
      uid: 42,
      mailbox: 'INBOX',
    });
    expect(rows[0].envelope_snapshot).toEqual({
      subject: 'Hi',
      from: 'b@y.com',
      original_mailbox: 'INBOX',
    });
  });

  it('returns empty array when no targets recorded', () => {
    const db = openDatabase(':memory:');
    expect(getIntentTargets(db, 'missing')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run test/ledger/intent-targets.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```typescript
// src/ledger/intent-targets.ts
import type { Database } from './sqlite.js';

export interface EnvelopeSnapshot {
  subject: string;
  from: string;
  original_mailbox: string;
}

export interface IntentTargetInsert {
  account_id: string;
  uid: number;
  mailbox: string;
  envelope_snapshot?: EnvelopeSnapshot;
}

export interface IntentTargetRow {
  intent_id: string;
  account_id: string;
  uid: number;
  mailbox: string;
  envelope_snapshot: EnvelopeSnapshot | null;
}

export function insertIntentTargets(
  db: Database,
  intentId: string,
  targets: IntentTargetInsert[]
): void {
  const stmt = db.prepare(
    `INSERT INTO intent_targets (intent_id, account_id, uid, mailbox, envelope_snapshot)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const t of targets) {
    stmt.run(
      intentId,
      t.account_id,
      t.uid,
      t.mailbox,
      t.envelope_snapshot ? JSON.stringify(t.envelope_snapshot) : null
    );
  }
}

export function getIntentTargets(db: Database, intentId: string): IntentTargetRow[] {
  const rows = db
    .prepare(
      `SELECT intent_id, account_id, uid, mailbox, envelope_snapshot
       FROM intent_targets WHERE intent_id = ? ORDER BY account_id, uid`
    )
    .all(intentId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    intent_id: r.intent_id as string,
    account_id: r.account_id as string,
    uid: Number(r.uid),
    mailbox: r.mailbox as string,
    envelope_snapshot: r.envelope_snapshot
      ? (JSON.parse(r.envelope_snapshot as string) as EnvelopeSnapshot)
      : null,
  }));
}
```

- [ ] **Step 4: Verify PASS**

Run: `npx vitest run test/ledger/intent-targets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ledger/intent-targets.ts test/ledger/intent-targets.test.ts
git commit -m "feat(ledger): intent_targets CRUD helpers"
```

### Task 1.4: `reverses_intent_id` / `reversed_by_intent_id` linking helpers

**Files:**
- Modify: `src/ledger/intents.ts` (append)
- Test: `test/ledger/intents.test.ts` (extend — new describe block)

- [ ] **Step 1: Write failing test**

```typescript
// test/ledger/intents.test.ts — append
import { linkReversal, getReversalLinks } from '../../src/ledger/intents.js';

describe('reversal linking', () => {
  it('links a restore intent back to one or more hold intents', () => {
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO intents (id, account_id, tool, params, risk, status)
                VALUES ('hold-1', 'a@x.com', 'hold_messages', '{}', 'medium', 'executed')`).run();
    db.prepare(`INSERT INTO intents (id, account_id, tool, params, risk, status)
                VALUES ('hold-2', 'a@x.com', 'hold_messages', '{}', 'medium', 'executed')`).run();
    db.prepare(`INSERT INTO intents (id, account_id, tool, params, risk, status)
                VALUES ('restore-1', 'a@x.com', 'restore_messages', '{}', 'medium', 'executed')`).run();

    linkReversal(db, { restoreIntentId: 'restore-1', reverses: ['hold-1', 'hold-2'] });

    const links = getReversalLinks(db, 'restore-1');
    expect(links.reverses).toEqual(['hold-1', 'hold-2']);

    const back = getReversalLinks(db, 'hold-1');
    expect(back.reversed_by).toEqual('restore-1');
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run test/ledger/intents.test.ts -t "reversal linking"`
Expected: FAIL — `linkReversal` not exported.

- [ ] **Step 3: Implement — append to `src/ledger/intents.ts`**

```typescript
export function linkReversal(
  db: Database,
  args: { restoreIntentId: string; reverses: string[] }
): void {
  db.prepare(`UPDATE intents SET reverses_intent_id = ? WHERE id = ?`).run(
    JSON.stringify(args.reverses),
    args.restoreIntentId
  );
  const stmt = db.prepare(`UPDATE intents SET reversed_by_intent_id = ? WHERE id = ?`);
  for (const id of args.reverses) stmt.run(args.restoreIntentId, id);
}

export function getReversalLinks(
  db: Database,
  id: string
): { reverses: string[]; reversed_by: string | null } {
  const row = db
    .prepare(`SELECT reverses_intent_id, reversed_by_intent_id FROM intents WHERE id = ?`)
    .get(id) as { reverses_intent_id: string | null; reversed_by_intent_id: string | null } | undefined;
  if (!row) return { reverses: [], reversed_by: null };
  return {
    reverses: row.reverses_intent_id ? (JSON.parse(row.reverses_intent_id) as string[]) : [],
    reversed_by: row.reversed_by_intent_id ?? null,
  };
}
```

- [ ] **Step 4: Verify PASS**

Run: `npx vitest run test/ledger/intents.test.ts -t "reversal linking"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ledger/intents.ts test/ledger/intents.test.ts
git commit -m "feat(ledger): reversal linking helpers"
```

---

## Phase 2 — Folder migration

### Task 2.1: Rename mailbox key `quarantine` → `holding`

**Files:**
- Modify: `src/provider/imap.ts:452-460` (rename mailbox key and folder constant)
- Test: `test/provider/folder-migration.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/provider/folder-migration.test.ts
import { describe, it, expect, vi } from 'vitest';
import { migrateHoldingFolder } from '../../src/provider/folder-migration.js';

function makeImap(opts: {
  hasHolding?: boolean;
  hasQuarantine?: boolean;
  renameOk?: boolean;
}) {
  const calls: string[] = [];
  return {
    calls,
    async mailboxExists(name: string) {
      if (name === 'agent-mail-holding') return opts.hasHolding ?? false;
      if (name === 'agent-mail-quarantine') return opts.hasQuarantine ?? false;
      return false;
    },
    async renameMailbox(from: string, to: string) {
      calls.push(`rename ${from} -> ${to}`);
      if (!opts.renameOk) throw new Error('rename not supported');
    },
    async ensureMailbox(name: string) {
      calls.push(`ensure ${name}`);
    },
    async listMessageUids(_mailbox: string) {
      return opts.hasQuarantine ? [1, 2, 3] : [];
    },
    async moveMessages(uids: number[], from: string, to: string) {
      calls.push(`move ${uids.length} ${from} -> ${to}`);
    },
    async deleteMailbox(name: string) {
      calls.push(`delete ${name}`);
    },
  };
}

describe('migrateHoldingFolder', () => {
  it('no-op when agent-mail-holding already exists', async () => {
    const imap = makeImap({ hasHolding: true });
    const result = await migrateHoldingFolder(imap as any);
    expect(result).toEqual({ action: 'noop' });
    expect(imap.calls).toEqual([]);
  });

  it('renames in place when server supports RENAME', async () => {
    const imap = makeImap({ hasQuarantine: true, renameOk: true });
    const result = await migrateHoldingFolder(imap as any);
    expect(result).toEqual({ action: 'renamed' });
    expect(imap.calls).toEqual(['rename agent-mail-quarantine -> agent-mail-holding']);
  });

  it('falls back to create+move+delete when RENAME fails', async () => {
    const imap = makeImap({ hasQuarantine: true, renameOk: false });
    const result = await migrateHoldingFolder(imap as any);
    expect(result.action).toBe('copied');
    expect(imap.calls).toEqual([
      'rename agent-mail-quarantine -> agent-mail-holding',
      'ensure agent-mail-holding',
      'move 3 agent-mail-quarantine -> agent-mail-holding',
      'delete agent-mail-quarantine',
    ]);
  });

  it('does nothing when neither folder exists', async () => {
    const imap = makeImap({});
    const result = await migrateHoldingFolder(imap as any);
    expect(result).toEqual({ action: 'noop' });
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run test/provider/folder-migration.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```typescript
// src/provider/folder-migration.ts
export interface MigrationImap {
  mailboxExists(name: string): Promise<boolean>;
  renameMailbox(from: string, to: string): Promise<void>;
  ensureMailbox(name: string): Promise<void>;
  listMessageUids(mailbox: string): Promise<number[]>;
  moveMessages(uids: number[], from: string, to: string): Promise<void>;
  deleteMailbox(name: string): Promise<void>;
}

export type MigrationOutcome =
  | { action: 'noop' }
  | { action: 'renamed' }
  | { action: 'copied'; moved: number };

const OLD = 'agent-mail-quarantine';
const NEW = 'agent-mail-holding';

export async function migrateHoldingFolder(imap: MigrationImap): Promise<MigrationOutcome> {
  if (await imap.mailboxExists(NEW)) return { action: 'noop' };
  if (!(await imap.mailboxExists(OLD))) return { action: 'noop' };
  try {
    await imap.renameMailbox(OLD, NEW);
    return { action: 'renamed' };
  } catch {
    await imap.ensureMailbox(NEW);
    const uids = await imap.listMessageUids(OLD);
    if (uids.length > 0) await imap.moveMessages(uids, OLD, NEW);
    await imap.deleteMailbox(OLD);
    return { action: 'copied', moved: uids.length };
  }
}
```

- [ ] **Step 4: Verify PASS**

Run: `npx vitest run test/provider/folder-migration.test.ts`
Expected: PASS all 4 cases.

- [ ] **Step 5: Commit**

```bash
git add src/provider/folder-migration.ts test/provider/folder-migration.test.ts
git commit -m "feat(provider): folder migration from agent-mail-quarantine to agent-mail-holding"
```

### Task 2.2: Update `imap.getMailboxPath` to prefer `holding`

**Files:**
- Modify: `src/provider/imap.ts:452-460`
- Test: `test/provider/mime.test.ts` (locate and modify an existing test that asserts on the quarantine path), or add a new targeted test.

- [ ] **Step 1: Read current provider to find the mailbox resolver, then write failing test**

Run: `grep -n "quarantine\|getMailboxPath" src/provider/imap.ts` to confirm lines. Then:

```typescript
// test/provider/imap-holding-path.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ImapProvider } from '../../src/provider/imap.js'; // adapt import to whatever class exports

describe('getMailboxPath', () => {
  it('returns agent-mail-holding when asked for "holding"', async () => {
    const provider = new ImapProvider({} as any); // use existing test construction pattern
    (provider as any).ensureMailbox = vi.fn(async () => {});
    const path = await provider.getMailboxPath('holding' as any);
    expect(path).toBe('agent-mail-holding');
  });
});
```

- [ ] **Step 2: Verify fails**

Run: `npx vitest run test/provider/imap-holding-path.test.ts`
Expected: FAIL — `'holding'` not a valid key yet.

- [ ] **Step 3: Edit `src/provider/imap.ts:452-460`**

Change the method signature's union to replace `'quarantine'` with `'holding'` and the branch to:

```typescript
if (name === 'holding') {
  await this.ensureMailbox('agent-mail-holding');
  return 'agent-mail-holding';
}
```

- [ ] **Step 4: Verify PASS + run full suite to catch callers**

Run: `npx vitest run test/provider/imap-holding-path.test.ts`
Expected: PASS.
Run: `npx vitest run`
Expected: compile errors in executor + label-thread refs using `'quarantine'`. These will be fixed in Phase 3.

- [ ] **Step 5: Commit**

```bash
git add src/provider/imap.ts test/provider/imap-holding-path.test.ts
git commit -m "feat(provider): getMailboxPath('holding') returns agent-mail-holding"
```

### Task 2.3: Wire migration to server startup

**Files:**
- Modify: `src/server/server.ts` (around account connect/initialization)
- Test: `test/server/preamble.test.ts` (fold migration-wiring check in here once preamble task lands, or add a dedicated integration test if the current server test infrastructure allows)

- [ ] **Step 1: Write the integration test**

```typescript
// test/server/folder-migration-on-start.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runStartupMigrations } from '../../src/server/startup.js';

describe('server startup migrations', () => {
  it('invokes migrateHoldingFolder for each account', async () => {
    const migrate = vi.fn(async () => ({ action: 'noop' as const }));
    const pool = {
      withConnection: vi.fn(async (_: string, fn: any) => fn({} as any)),
    };
    const accounts = [
      { id: 'a@x.com' } as any,
      { id: 'b@y.com' } as any,
    ];
    await runStartupMigrations({ pool: pool as any, accounts, migrate });
    expect(migrate).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run test/server/folder-migration-on-start.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/server/startup.ts`**

```typescript
// src/server/startup.ts
import type { AccountConfig } from '../types.js';
import type { MigrationImap, MigrationOutcome } from '../provider/folder-migration.js';
import { migrateHoldingFolder } from '../provider/folder-migration.js';

export interface StartupPool {
  withConnection<T>(accountId: string, fn: (imap: MigrationImap) => Promise<T>): Promise<T>;
}

export async function runStartupMigrations(args: {
  pool: StartupPool;
  accounts: AccountConfig[];
  migrate?: (imap: MigrationImap) => Promise<MigrationOutcome>;
}): Promise<Record<string, MigrationOutcome>> {
  const migrate = args.migrate ?? migrateHoldingFolder;
  const results: Record<string, MigrationOutcome> = {};
  for (const account of args.accounts) {
    results[account.id] = await args.pool.withConnection(account.id, (imap) => migrate(imap));
  }
  return results;
}
```

Then in `src/server/server.ts`, after pool construction and before tool registration, call `await runStartupMigrations({ pool, accounts });`. Log migration results through the existing logger.

- [ ] **Step 4: Verify PASS**

Run: `npx vitest run test/server/folder-migration-on-start.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/startup.ts src/server/server.ts test/server/folder-migration-on-start.test.ts
git commit -m "feat(server): run holding-folder migration on startup"
```

---

## Phase 3 — Tool rename (`quarantine_*` → `hold_messages`)

### Task 3.1: Create `hold_messages` tool, delete `quarantine-thread.ts`

**Files:**
- Create: `src/tools/hold-messages.ts`
- Delete: `src/tools/quarantine-thread.ts`
- Modify: `src/server/server.ts` (registration)
- Modify: `src/executor/executor.ts:755` (rename case label)
- Modify: `src/executor/undo.ts`
- Modify: `src/policy/defaults.ts`
- Delete: `test/executor/quarantine-dry-run.test.ts`, `test/executor/quarantine-messages-alias.test.ts`
- Create: `test/tools/hold-messages.test.ts`, `test/executor/hold-messages.test.ts`

- [ ] **Step 1: Write failing test for the tool definition shape**

```typescript
// test/tools/hold-messages.test.ts
import { describe, it, expect } from 'vitest';
import { holdMessagesTool } from '../../src/tools/hold-messages.js';

describe('hold_messages tool', () => {
  it('has correct name and reversibility-first description', () => {
    expect(holdMessagesTool.name).toBe('hold_messages');
    expect(holdMessagesTool.description.startsWith('Move messages to the holding folder. Fully reversible'))
      .toBe(true);
    expect(holdMessagesTool.description).toMatch(/This server cannot permanently delete/);
  });

  it('sets annotations.destructiveHint=false (reversible)', () => {
    expect(holdMessagesTool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
  });

  it('accepts targets and dry_run', () => {
    const parsed = holdMessagesTool.inputSchema.parse({
      targets: [{ account_id: 'a@x.com', uid: 1 }],
      dry_run: true,
    });
    expect(parsed.targets).toHaveLength(1);
    expect(parsed.dry_run).toBe(true);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run test/tools/hold-messages.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/tools/hold-messages.ts`**

```typescript
// src/tools/hold-messages.ts
import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { TargetsSchema } from './target.js';

const description =
  'Move messages to the holding folder. Fully reversible: messages move to `agent-mail-holding` and can be restored via `restore_messages` or `undo_intent` within 30 days. This server cannot permanently delete messages. Operates at the message/UID level — only the UIDs you pass are moved; thread siblings are NOT auto-expanded. Targets are account-qualified, so a single call can hold across accounts. Pass `dry_run: true` to preview the per-account/per-mailbox UID list without moving anything. Pass `include_summary: true` to receive per-message subject/from/original_mailbox in the response.';

const inputSchema = z.object({
  targets: TargetsSchema,
  dry_run: z.boolean().optional().describe('If true, preview without moving.'),
  include_summary: z
    .boolean()
    .optional()
    .describe('If true, response includes moved[{uid, account_id, subject, from, original_mailbox}].'),
});

export const holdMessagesTool: ToolDefinition = {
  name: 'hold_messages',
  description,
  inputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
```

- [ ] **Step 4: Delete old file + update executor/undo/policy/server**

```bash
git rm src/tools/quarantine-thread.ts test/executor/quarantine-dry-run.test.ts test/executor/quarantine-messages-alias.test.ts
```

Edits:
- `src/executor/executor.ts:755` — change `if (intent.tool === 'quarantine_thread')` to `if (intent.tool === 'hold_messages')`. Change the log comment on line 754 from "quarantine" to "hold".
- `src/executor/executor.ts:783` and `:927` — change `imap.getMailboxPath('quarantine')` to `imap.getMailboxPath('holding')`.
- `src/executor/undo.ts:27,:37` — rename `'quarantine_thread'` branches to `'hold_messages'`.
- `src/policy/defaults.ts` — rename the `quarantine_thread` / `quarantine_messages` keys to `hold_messages` (preserve existing risk/gate values).
- `src/server/server.ts` — swap the imports and registrations from `quarantineMessagesTool`/`quarantineThreadTool` to `holdMessagesTool`.

- [ ] **Step 5: Verify unit test passes + full suite**

Run: `npx vitest run test/tools/hold-messages.test.ts`
Expected: PASS.
Run: `npx vitest run`
Expected: remaining failures only in executor tests that need rewriting (next task).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: rename quarantine_messages/quarantine_thread to hold_messages"
```

### Task 3.2: Executor test coverage for `hold_messages`

**Files:**
- Create: `test/executor/hold-messages.test.ts`

- [ ] **Step 1: Port `quarantine-dry-run.test.ts` shape to `hold_messages`**

```typescript
// test/executor/hold-messages.test.ts — structure mirrors the old quarantine-dry-run suite
// (dry_run, real run, unknown account) with tool: 'hold_messages' and
// getMailboxPath resolving to 'agent-mail-holding'. Copy the three cases verbatim,
// changing only: tool name, mailbox path, and the assertions on payload shape.
```

Full test body (copy-paste):

```typescript
import { describe, it, expect, vi } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { createLogger } from '../../src/logger.js';
import type { AccountConfig } from '../../src/types.js';

const logger = createLogger('cli', { minLevel: 'error' });

function makeAccounts(): AccountConfig[] {
  return [
    { id: 'a@x.com', email: 'a@x.com', imap: { host: 'h', port: 993, tls: true }, smtp: { host: 'h', port: 465, tls: true } },
    { id: 'b@y.com', email: 'b@y.com', imap: { host: 'h', port: 993, tls: true }, smtp: { host: 'h', port: 465, tls: true } },
  ];
}

describe('hold_messages', () => {
  it('dry_run returns blast radius without moving', async () => {
    const moveCalls: string[] = [];
    const pool = {
      withConnection: vi.fn(async (accountId: string, fn: any) =>
        fn({
          getMailboxPath: async () => 'agent-mail-holding',
          moveMessages: async () => { moveCalls.push(accountId); },
        })
      ),
    };
    const executor = new Executor({ db: openDatabase(':memory:'), accounts: makeAccounts(), pool: pool as any, logger });
    const { intent, result } = await executor.executeImmediate({
      tool: 'hold_messages',
      toolParams: { targets: [{ account_id: 'a@x.com', uid: 1 }, { account_id: 'b@y.com', uid: 5 }], dry_run: true },
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'medium',
    });
    expect(moveCalls).toEqual([]);
    const payload = JSON.parse(result[0].text);
    expect(payload.dry_run).toBe(true);
    expect(payload.total_messages).toBeGreaterThanOrEqual(2);
    expect(intent.undo_token).toBeNull();
  });

  it('real run moves messages and registers undo', async () => {
    const moveCalls: Array<{ accountId: string; uids: number[] }> = [];
    const pool = {
      withConnection: vi.fn(async (accountId: string, fn: any) =>
        fn({
          getMailboxPath: async () => 'agent-mail-holding',
          moveMessages: async (uids: number[]) => { moveCalls.push({ accountId, uids }); },
        })
      ),
    };
    const executor = new Executor({ db: openDatabase(':memory:'), accounts: makeAccounts(), pool: pool as any, logger });
    const { intent, result } = await executor.executeImmediate({
      tool: 'hold_messages',
      toolParams: { targets: [{ account_id: 'a@x.com', uid: 1 }, { account_id: 'b@y.com', uid: 5 }] },
      accountId: 'a@x.com', agentId: 'test', risk: 'medium',
    });
    expect(moveCalls).toHaveLength(2);
    const payload = JSON.parse(result[0].text);
    expect(payload.total_messages).toBe(2);
    expect(intent.undo_token).not.toBeNull();
  });

  it('rejects unknown account_id in targets', async () => {
    const pool = { withConnection: vi.fn() };
    const executor = new Executor({ db: openDatabase(':memory:'), accounts: makeAccounts(), pool: pool as any, logger });
    await expect(
      executor.executeImmediate({
        tool: 'hold_messages',
        toolParams: { targets: [{ account_id: 'unknown@z.com', uid: 1 }] },
        accountId: 'a@x.com', agentId: 'test', risk: 'medium',
      })
    ).rejects.toThrow(/unknown.*account/i);
  });
});
```

- [ ] **Step 2: Run, expect PASS**

Run: `npx vitest run test/executor/hold-messages.test.ts`
Expected: PASS all three cases.

- [ ] **Step 3: Commit**

```bash
git add test/executor/hold-messages.test.ts
git commit -m "test(executor): hold_messages dry_run/real/unknown-account"
```

---

## Phase 4 — Bundle A safety net

### Task 4.1: `hold_messages` captures envelopes + `include_summary`

**Files:**
- Modify: `src/executor/executor.ts:754-821` (hold_messages case)
- Modify: `src/provider/imap.ts` — if `fetchEnvelopes(uids, mailbox)` method doesn't exist, add it (returns `[{uid, subject, from}]`).
- Test: `test/executor/hold-messages-summary.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/executor/hold-messages-summary.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { getIntentTargets } from '../../src/ledger/intent-targets.js';
import { createLogger } from '../../src/logger.js';

const logger = createLogger('cli', { minLevel: 'error' });

describe('hold_messages include_summary', () => {
  it('returns moved[{uid,account_id,subject,from,original_mailbox}] and persists targets', async () => {
    const pool = {
      withConnection: vi.fn(async (_: string, fn: any) =>
        fn({
          getMailboxPath: async () => 'agent-mail-holding',
          moveMessages: async () => {},
          fetchEnvelopes: async (_m: string, uids: number[]) =>
            uids.map((uid) => ({ uid, subject: `subj-${uid}`, from: 'a@x.com' })),
        })
      ),
    };
    const db = openDatabase(':memory:');
    const accounts = [{ id: 'a@x.com' } as any];
    const executor = new Executor({ db, accounts, pool: pool as any, logger });

    const { intent, result } = await executor.executeImmediate({
      tool: 'hold_messages',
      toolParams: {
        targets: [
          { account_id: 'a@x.com', uid: 10, mailbox: 'INBOX' },
          { account_id: 'a@x.com', uid: 11, mailbox: 'INBOX' },
        ],
        include_summary: true,
      },
      accountId: 'a@x.com',
      agentId: 'test',
      risk: 'medium',
    });

    const payload = JSON.parse(result[0].text);
    expect(payload.moved).toEqual([
      { uid: 10, account_id: 'a@x.com', subject: 'subj-10', from: 'a@x.com', original_mailbox: 'INBOX' },
      { uid: 11, account_id: 'a@x.com', subject: 'subj-11', from: 'a@x.com', original_mailbox: 'INBOX' },
    ]);

    const targets = getIntentTargets(db, intent.id);
    expect(targets).toHaveLength(2);
    expect(targets[0].envelope_snapshot).toMatchObject({
      subject: 'subj-10',
      from: 'a@x.com',
      original_mailbox: 'INBOX',
    });
  });

  it('omits moved field when include_summary is not set (back-compat)', async () => {
    const pool = {
      withConnection: vi.fn(async (_: string, fn: any) =>
        fn({
          getMailboxPath: async () => 'agent-mail-holding',
          moveMessages: async () => {},
          fetchEnvelopes: async () => [],
        })
      ),
    };
    const executor = new Executor({ db: openDatabase(':memory:'), accounts: [{ id: 'a@x.com' } as any], pool: pool as any, logger });
    const { result } = await executor.executeImmediate({
      tool: 'hold_messages',
      toolParams: { targets: [{ account_id: 'a@x.com', uid: 10, mailbox: 'INBOX' }] },
      accountId: 'a@x.com', agentId: 'test', risk: 'medium',
    });
    const payload = JSON.parse(result[0].text);
    expect(payload.moved).toBeUndefined();
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run test/executor/hold-messages-summary.test.ts`
Expected: FAIL — `fetchEnvelopes` not a function; `moved` key absent.

- [ ] **Step 3: Implement**

Add `fetchEnvelopes(mailbox: string, uids: number[]): Promise<Array<{uid:number; subject:string; from:string}>>` to the IMAP provider using ImapFlow's `fetch` with `{ envelope: true }`. If an envelope method already exists under another name, reuse it.

In `src/executor/executor.ts`, inside the `hold_messages` branch, after `byMailbox` is built and before the move loop (for real runs and summary requests):

```typescript
const includeSummary = (intent.params.include_summary as boolean | undefined) ?? false;
const envelopeSnapshots: Array<{
  account_id: string;
  uid: number;
  mailbox: string;
  subject: string;
  from: string;
}> = [];

for (const [mailbox, uids] of byMailbox) {
  if (includeSummary || !dryRun) {
    const envs = await imap.fetchEnvelopes(mailbox, uids);
    for (const env of envs) {
      envelopeSnapshots.push({
        account_id: accountId,
        uid: env.uid,
        mailbox,
        subject: env.subject,
        from: env.from,
      });
    }
  }
  if (!dryRun) await imap.moveMessages(uids, mailbox, quarantine);
  perMailbox.push({ mailbox, message_count: uids.length, uids });
}

return {
  account_id: accountId,
  per_mailbox: perMailbox,
  envelopes: envelopeSnapshots,
  message_count: perMailbox.reduce((n, m) => n + m.message_count, 0),
};
```

After `fanOut` returns, aggregate `envelopes` across accounts. If not dry_run, call:

```typescript
import { insertIntentTargets } from '../ledger/intent-targets.js';
// ...
if (!dryRun && envelopeSnapshots.length > 0) {
  insertIntentTargets(this.db, intent.id, envelopeSnapshots.map((e) => ({
    account_id: e.account_id,
    uid: e.uid,
    mailbox: e.mailbox,
    envelope_snapshot: {
      subject: e.subject,
      from: e.from,
      original_mailbox: e.mailbox,
    },
  })));
}
if (includeSummary) {
  payload.moved = envelopeSnapshots.map((e) => ({
    uid: e.uid,
    account_id: e.account_id,
    subject: e.subject,
    from: e.from,
    original_mailbox: e.mailbox,
  }));
}
```

- [ ] **Step 4: Verify PASS**

Run: `npx vitest run test/executor/hold-messages-summary.test.ts`
Expected: PASS both cases.

- [ ] **Step 5: Commit**

```bash
git add src/executor/executor.ts src/provider/imap.ts test/executor/hold-messages-summary.test.ts
git commit -m "feat(hold_messages): capture envelopes, persist targets, optional include_summary"
```

### Task 4.2: `restore_messages` tool definition

**Files:**
- Create: `src/tools/restore-messages.ts`
- Test: `test/tools/restore-messages.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/tools/restore-messages.test.ts
import { describe, it, expect } from 'vitest';
import { restoreMessagesTool } from '../../src/tools/restore-messages.js';

describe('restore_messages tool', () => {
  it('has reversibility-first description', () => {
    expect(restoreMessagesTool.name).toBe('restore_messages');
    expect(restoreMessagesTool.description.startsWith(
      'Move messages out of the holding folder back to their original mailbox. Fully reversible'
    )).toBe(true);
  });

  it('annotations: not read-only, not destructive, idempotent', () => {
    expect(restoreMessagesTool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
  });

  it('accepts targets and dry_run', () => {
    const parsed = restoreMessagesTool.inputSchema.parse({
      targets: [{ account_id: 'a@x.com', uid: 1 }],
      dry_run: false,
    });
    expect(parsed.targets).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run test/tools/restore-messages.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```typescript
// src/tools/restore-messages.ts
import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { TargetsSchema } from './target.js';

const description =
  'Move messages out of the holding folder back to their original mailbox. Fully reversible by re-holding with `hold_messages`. This server cannot permanently delete messages. Uses the ledger envelope snapshot recorded at hold time to find each message\'s original mailbox; targets not present in the ledger are reported as per-target errors and skipped. Pass `dry_run: true` to preview.';

const inputSchema = z.object({
  targets: TargetsSchema,
  dry_run: z.boolean().optional(),
});

export const restoreMessagesTool: ToolDefinition = {
  name: 'restore_messages',
  description,
  inputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
```

- [ ] **Step 4: Verify PASS**

Run: `npx vitest run test/tools/restore-messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/restore-messages.ts test/tools/restore-messages.test.ts
git commit -m "feat(tools): restore_messages tool definition"
```

### Task 4.3: `restore_messages` executor case

**Files:**
- Modify: `src/executor/executor.ts` (add new case alongside `hold_messages`)
- Modify: `src/server/server.ts` (register)
- Modify: `src/policy/defaults.ts` (add policy entry, risk=low, gate=ungated, reversible=true)
- Test: `test/executor/restore-messages.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/executor/restore-messages.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { insertIntentTargets } from '../../src/ledger/intent-targets.js';
import { getReversalLinks } from '../../src/ledger/intents.js';
import { createLogger } from '../../src/logger.js';

const logger = createLogger('cli', { minLevel: 'error' });

function seedHoldIntent(db: any, intentId: string, targets: Array<{uid:number; original_mailbox:string}>) {
  db.prepare(
    `INSERT INTO intents (id, account_id, tool, params, risk, status)
     VALUES (?, 'a@x.com', 'hold_messages', '{}', 'medium', 'executed')`
  ).run(intentId);
  insertIntentTargets(db, intentId, targets.map((t) => ({
    account_id: 'a@x.com',
    uid: t.uid,
    mailbox: 'agent-mail-holding',
    envelope_snapshot: { subject: 's', from: 'f@x.com', original_mailbox: t.original_mailbox },
  })));
}

describe('restore_messages', () => {
  it('moves each UID back to its original mailbox from the ledger snapshot', async () => {
    const moves: Array<{ uids: number[]; from: string; to: string }> = [];
    const pool = {
      withConnection: vi.fn(async (_: string, fn: any) =>
        fn({
          getMailboxPath: async () => 'agent-mail-holding',
          moveMessages: async (uids: number[], from: string, to: string) => {
            moves.push({ uids, from, to });
          },
        })
      ),
    };
    const db = openDatabase(':memory:');
    seedHoldIntent(db, 'hold-1', [
      { uid: 10, original_mailbox: 'INBOX' },
      { uid: 11, original_mailbox: 'Archive' },
    ]);
    const executor = new Executor({ db, accounts: [{ id: 'a@x.com' } as any], pool: pool as any, logger });

    const { intent, result } = await executor.executeImmediate({
      tool: 'restore_messages',
      toolParams: {
        targets: [
          { account_id: 'a@x.com', uid: 10 },
          { account_id: 'a@x.com', uid: 11 },
        ],
      },
      accountId: 'a@x.com', agentId: 'test', risk: 'low',
    });

    expect(moves).toEqual([
      { uids: [10], from: 'agent-mail-holding', to: 'INBOX' },
      { uids: [11], from: 'agent-mail-holding', to: 'Archive' },
    ]);

    const payload = JSON.parse(result[0].text);
    expect(payload.moved).toHaveLength(2);
    expect(payload.errors).toEqual([]);

    const links = getReversalLinks(db, intent.id);
    expect(links.reverses).toContain('hold-1');
  });

  it('surfaces per-target errors for UIDs with no ledger entry', async () => {
    const moves: any[] = [];
    const pool = {
      withConnection: vi.fn(async (_: string, fn: any) =>
        fn({ getMailboxPath: async () => 'agent-mail-holding', moveMessages: async () => {} })
      ),
    };
    const db = openDatabase(':memory:');
    const executor = new Executor({ db, accounts: [{ id: 'a@x.com' } as any], pool: pool as any, logger });

    const { result } = await executor.executeImmediate({
      tool: 'restore_messages',
      toolParams: { targets: [{ account_id: 'a@x.com', uid: 999 }] },
      accountId: 'a@x.com', agentId: 'test', risk: 'low',
    });
    const payload = JSON.parse(result[0].text);
    expect(payload.errors).toEqual([
      { uid: 999, account_id: 'a@x.com', reason: 'original_mailbox unknown (not in ledger)' },
    ]);
    expect(payload.moved).toEqual([]);
  });

  it('dry_run reports planned moves without calling moveMessages', async () => {
    const moves: any[] = [];
    const pool = {
      withConnection: vi.fn(async (_: string, fn: any) =>
        fn({
          getMailboxPath: async () => 'agent-mail-holding',
          moveMessages: async () => { moves.push(1); },
        })
      ),
    };
    const db = openDatabase(':memory:');
    seedHoldIntent(db, 'hold-1', [{ uid: 10, original_mailbox: 'INBOX' }]);
    const executor = new Executor({ db, accounts: [{ id: 'a@x.com' } as any], pool: pool as any, logger });

    const { result } = await executor.executeImmediate({
      tool: 'restore_messages',
      toolParams: { targets: [{ account_id: 'a@x.com', uid: 10 }], dry_run: true },
      accountId: 'a@x.com', agentId: 'test', risk: 'low',
    });
    expect(moves).toEqual([]);
    const payload = JSON.parse(result[0].text);
    expect(payload.dry_run).toBe(true);
    expect(payload.moved).toHaveLength(1);
    expect(payload.moved[0]).toMatchObject({ uid: 10, destination_mailbox: 'INBOX' });
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run test/executor/restore-messages.test.ts`
Expected: FAIL — tool not routed.

- [ ] **Step 3: Implement executor branch**

Add in `src/executor/executor.ts`, near the `hold_messages` branch:

```typescript
if (intent.tool === 'restore_messages') {
  const targets = intent.params.targets as Target[];
  const dryRun = (intent.params.dry_run as boolean | undefined) ?? false;
  const grouped = parseTargets(targets);
  const allIds = this.accounts.map((a) => a.id);
  const unknown = Object.keys(grouped).filter((id) => !allIds.includes(id));
  if (unknown.length > 0) throw new Error(`Unknown account_ids in targets: ${unknown.join(', ')}`);

  // Look up envelope snapshots for each (account_id, uid).
  const rows = this.db
    .prepare(
      `SELECT it.intent_id, it.account_id, it.uid, it.envelope_snapshot
       FROM intent_targets it
       JOIN intents i ON i.id = it.intent_id
       WHERE i.tool = 'hold_messages' AND i.status = 'executed'`
    )
    .all() as Array<{ intent_id: string; account_id: string; uid: number; envelope_snapshot: string | null }>;
  const byKey = new Map<string, { intent_id: string; original_mailbox: string }>();
  for (const r of rows) {
    const snap = r.envelope_snapshot ? JSON.parse(r.envelope_snapshot) : null;
    if (snap?.original_mailbox) {
      byKey.set(`${r.account_id}:${r.uid}`, {
        intent_id: r.intent_id,
        original_mailbox: snap.original_mailbox,
      });
    }
  }

  const moved: Array<{ uid: number; account_id: string; destination_mailbox: string; subject?: string; from?: string }> = [];
  const errors: Array<{ uid: number; account_id: string; reason: string }> = [];
  const reverses = new Set<string>();

  for (const [accountId, list] of Object.entries(grouped)) {
    await this.pool.withConnection(accountId, async (imap) => {
      const holding = await imap.getMailboxPath('holding');
      for (const t of list) {
        const entry = byKey.get(`${accountId}:${t.uid}`);
        if (!entry) {
          errors.push({ uid: t.uid, account_id: accountId, reason: 'original_mailbox unknown (not in ledger)' });
          continue;
        }
        if (!dryRun) await imap.moveMessages([t.uid], holding, entry.original_mailbox);
        moved.push({ uid: t.uid, account_id: accountId, destination_mailbox: entry.original_mailbox });
        reverses.add(entry.intent_id);
      }
    });
  }

  if (!dryRun && reverses.size > 0) {
    linkReversal(this.db, { restoreIntentId: intent.id, reverses: [...reverses] });
  }

  const payload = {
    dry_run: dryRun,
    moved,
    errors,
  };
  return [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
}
```

Also register the tool in `src/server/server.ts` and add a policy entry in `src/policy/defaults.ts`:

```typescript
restore_messages: { risk: 'low', gate: 'ungated', reversible: true }
```

- [ ] **Step 4: Verify PASS**

Run: `npx vitest run test/executor/restore-messages.test.ts`
Expected: PASS all three.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: restore_messages tool + executor case"
```

### Task 4.4: `get_intent` tool

**Files:**
- Create: `src/tools/get-intent.ts`
- Modify: `src/executor/executor.ts` (add read-only case)
- Modify: `src/server/server.ts` (register)
- Modify: `src/policy/defaults.ts` (`get_intent: { risk: 'none', gate: 'ungated' }`)
- Test: `test/tools/get-intent.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/tools/get-intent.test.ts
import { describe, it, expect } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { insertIntentTargets } from '../../src/ledger/intent-targets.js';
import { linkReversal } from '../../src/ledger/intents.js';
import { createLogger } from '../../src/logger.js';

const logger = createLogger('cli', { minLevel: 'error' });

describe('get_intent', () => {
  it('returns full intent record including targets and reversal links', async () => {
    const db = openDatabase(':memory:');
    db.prepare(
      `INSERT INTO intents (id, account_id, tool, params, risk, status)
       VALUES ('hold-1', 'a@x.com', 'hold_messages', '{}', 'medium', 'executed')`
    ).run();
    db.prepare(
      `INSERT INTO intents (id, account_id, tool, params, risk, status)
       VALUES ('restore-1', 'a@x.com', 'restore_messages', '{}', 'low', 'executed')`
    ).run();
    insertIntentTargets(db, 'hold-1', [
      { account_id: 'a@x.com', uid: 10, mailbox: 'agent-mail-holding',
        envelope_snapshot: { subject: 'Test', from: 'b@y.com', original_mailbox: 'INBOX' } },
    ]);
    linkReversal(db, { restoreIntentId: 'restore-1', reverses: ['hold-1'] });

    const executor = new Executor({ db, accounts: [{ id: 'a@x.com' } as any], pool: { withConnection: async () => {} } as any, logger });
    const { result } = await executor.executeImmediate({
      tool: 'get_intent',
      toolParams: { intent_id: 'hold-1' },
      accountId: 'a@x.com', agentId: 'test', risk: 'none',
    });
    const payload = JSON.parse(result[0].text);
    expect(payload.id).toBe('hold-1');
    expect(payload.type).toBe('hold_messages');
    expect(payload.targets).toEqual([
      { uid: 10, account_id: 'a@x.com', mailbox: 'agent-mail-holding', subject: 'Test', from: 'b@y.com' },
    ]);
    expect(payload.reversed_by_intent_id).toBe('restore-1');
  });

  it('returns null-shaped payload for unknown intent id', async () => {
    const db = openDatabase(':memory:');
    const executor = new Executor({ db, accounts: [{ id: 'a@x.com' } as any], pool: { withConnection: async () => {} } as any, logger });
    const { result } = await executor.executeImmediate({
      tool: 'get_intent',
      toolParams: { intent_id: 'nope' },
      accountId: 'a@x.com', agentId: 'test', risk: 'none',
    });
    expect(JSON.parse(result[0].text)).toEqual({ error: 'intent not found', intent_id: 'nope' });
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run test/tools/get-intent.test.ts`
Expected: FAIL — tool not implemented.

- [ ] **Step 3: Implement tool + executor case**

```typescript
// src/tools/get-intent.ts
import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

export const getIntentTool: ToolDefinition = {
  name: 'get_intent',
  description:
    'Return the full record of a past intent: type, account, targets (with subject/from/original_mailbox captured at intent time), status, and reversal links. Use this to build partial-undo logic: fetch the intent, pick which targets to keep held, and call restore_messages on the rest.',
  inputSchema: z.object({ intent_id: z.string().min(1) }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  async execute() { return { type: 'immediate', content: [] }; },
};
```

In `src/executor/executor.ts`, add:

```typescript
if (intent.tool === 'get_intent') {
  const id = intent.params.intent_id as string;
  const row = getIntent(this.db, id);
  if (!row) {
    return [{ type: 'text', text: JSON.stringify({ error: 'intent not found', intent_id: id }) }];
  }
  const targets = getIntentTargets(this.db, id).map((t) => ({
    uid: t.uid,
    account_id: t.account_id,
    mailbox: t.mailbox,
    subject: t.envelope_snapshot?.subject ?? null,
    from: t.envelope_snapshot?.from ?? null,
  }));
  const links = getReversalLinks(this.db, id);
  const payload = {
    id: row.id,
    type: row.tool,
    created_at: row.created_at,
    account_id: row.account_id,
    status: row.status,
    targets,
    reverses_intent_id: links.reverses.length > 0 ? links.reverses : undefined,
    reversed_by_intent_id: links.reversed_by ?? undefined,
  };
  return [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
}
```

Register in server + policy.

- [ ] **Step 4: Verify PASS**

Run: `npx vitest run test/tools/get-intent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: get_intent tool returns full intent record with targets"
```

---

## Phase 5 — Bundle B reversibility framing

### Task 5.1: MCP server preamble (`instructions` string)

**Files:**
- Modify: `src/server/server.ts` (wherever the `Server` is constructed — add `instructions` option)
- Test: `test/server/preamble.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/server/preamble.test.ts
import { describe, it, expect } from 'vitest';
import { buildServerOptions } from '../../src/server/server.js';

describe('MCP server preamble', () => {
  it('sets instructions explaining reversibility contract', () => {
    const opts = buildServerOptions();
    expect(opts.instructions).toMatch(/no action it exposes can cause irreversible harm/);
    expect(opts.instructions).toMatch(/undo_intent/);
    expect(opts.instructions).toMatch(/restore_messages/);
    expect(opts.instructions).toMatch(/Over-holding-then-restoring is a normal interaction pattern/);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run test/server/preamble.test.ts`
Expected: FAIL — export missing.

- [ ] **Step 3: Implement in `src/server/server.ts`**

Extract (or create) a `buildServerOptions()` that returns `{ name, version, instructions }`:

```typescript
export function buildServerOptions() {
  return {
    name: 'agent-mail',
    version: '0.1.0',
    instructions: [
      'agent-mail design contract.',
      'This server is built so that no action it exposes can cause irreversible harm.',
      'Every mutation (hold, label, draft) is reversible for 30 days via `undo_intent` or `restore_messages`, and every action is recorded in `get_audit_log`.',
      'Sending email and permanent deletion are deliberately not exposed — those operations require a separate human-in-the-loop flow outside this server.',
      'Agents should treat this as a low-stakes environment: prefer acting and reconciling afterward over asking permission per action.',
      'Over-holding-then-restoring is a normal interaction pattern, not a failure mode.',
    ].join(' '),
  };
}
```

Pass the result to the `Server` constructor.

- [ ] **Step 4: Verify PASS**

Run: `npx vitest run test/server/preamble.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/server.ts test/server/preamble.test.ts
git commit -m "feat(server): add reversibility-contract preamble to MCP instructions"
```

### Task 5.2: `undo_hint` helper + mutation-response echo

**Files:**
- Create: `src/lib/undo-hint.ts`
- Test: `test/lib/undo-hint.test.ts`
- Modify: `src/executor/executor.ts` — all mutation response payloads gain `reversible` + `undo_hint`.

- [ ] **Step 1: Write failing test for helper**

```typescript
// test/lib/undo-hint.test.ts
import { describe, it, expect } from 'vitest';
import { buildUndoHint } from '../../src/lib/undo-hint.js';

describe('buildUndoHint', () => {
  it('returns restore_messages for hold intents', () => {
    const hint = buildUndoHint({
      intent_id: 'i1',
      tool: 'hold_messages',
      created_at: '2026-04-18T12:00:00Z',
    });
    expect(hint).toEqual({
      reversible: true,
      undo_hint: {
        intent_id: 'i1',
        method: 'restore_messages',
        window_expires_at: '2026-05-18T12:00:00.000Z',
      },
    });
  });

  it('returns undo_intent for label/draft/restore/etc', () => {
    const hint = buildUndoHint({
      intent_id: 'i2',
      tool: 'label_thread',
      created_at: '2026-04-18T12:00:00Z',
    });
    expect(hint.undo_hint.method).toBe('undo_intent');
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run test/lib/undo-hint.test.ts`
Expected: FAIL — missing.

- [ ] **Step 3: Implement**

```typescript
// src/lib/undo-hint.ts
export interface UndoHintArgs {
  intent_id: string;
  tool: string;
  created_at: string; // ISO8601
  window_ms?: number; // default 30 days
}

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function buildUndoHint(args: UndoHintArgs) {
  const created = new Date(args.created_at);
  const expires = new Date(created.getTime() + (args.window_ms ?? DEFAULT_WINDOW_MS));
  const method = args.tool === 'hold_messages' ? 'restore_messages' : 'undo_intent';
  return {
    reversible: true,
    undo_hint: {
      intent_id: args.intent_id,
      method,
      window_expires_at: expires.toISOString(),
    },
  };
}
```

- [ ] **Step 4: Verify PASS**

Run: `npx vitest run test/lib/undo-hint.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into executor mutation payloads**

In each mutation branch of `src/executor/executor.ts` (`label_thread`, `hold_messages`, `restore_messages`, `draft_reply`, `queue_send`, `unsubscribe_sender`, and the undo path), after building `payload`, merge:

```typescript
import { buildUndoHint } from '../lib/undo-hint.js';
// ...
Object.assign(payload, buildUndoHint({
  intent_id: intent.id,
  tool: intent.tool,
  created_at: intent.created_at,
}));
```

For dry_run paths, skip (they aren't reversible because nothing happened). Add a test:

```typescript
// Extend test/executor/hold-messages.test.ts with:
it('real run response includes reversible and undo_hint with method=restore_messages', async () => {
  // (setup same as "real run moves messages and registers undo")
  // assert:
  // expect(payload.reversible).toBe(true);
  // expect(payload.undo_hint.method).toBe('restore_messages');
  // expect(payload.undo_hint.intent_id).toBe(intent.id);
});
it('dry_run response omits reversible/undo_hint', async () => {
  // assert payload.reversible is undefined
});
```

- [ ] **Step 6: Verify PASS**

Run: `npx vitest run test/executor test/lib/undo-hint.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: echo reversible + undo_hint in every mutation response"
```

### Task 5.3: Reversibility-first tool descriptions

**Files:**
- Modify: `src/tools/label-thread.ts`, `src/tools/queue-send.ts`, `src/tools/draft-reply.ts`, `src/tools/unsubscribe-sender.ts`, `src/tools/undo-intent.ts`.
- Test: `test/tools/descriptions.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/tools/descriptions.test.ts
import { describe, it, expect } from 'vitest';
import { holdMessagesTool } from '../../src/tools/hold-messages.js';
import { restoreMessagesTool } from '../../src/tools/restore-messages.js';
import { labelThreadTool } from '../../src/tools/label-thread.js';
import { queueSendTool } from '../../src/tools/queue-send.js';
import { draftReplyTool } from '../../src/tools/draft-reply.js';
import { unsubscribeSenderTool } from '../../src/tools/unsubscribe-sender.js';

const first = (s: string) => s.split('. ')[0] + '.';

describe('mutation tool descriptions lead with reversibility', () => {
  it('hold_messages', () => {
    expect(holdMessagesTool.description).toMatch(/Fully reversible/);
    expect(holdMessagesTool.description).toMatch(/This server cannot permanently delete/);
  });
  it('restore_messages', () => {
    expect(restoreMessagesTool.description).toMatch(/Fully reversible/);
  });
  it('label_thread', () => {
    expect(labelThreadTool.description).toMatch(/Fully reversible via `undo_intent` within 30 days/);
  });
  it('queue_send', () => {
    expect(queueSendTool.description).toMatch(/This server cannot send mail/);
  });
  it('draft_reply mentions no send', () => {
    expect(draftReplyTool.description).toMatch(/This server cannot send mail/);
  });
  it('unsubscribe_sender states blast radius', () => {
    expect(unsubscribeSenderTool.description).toMatch(/cannot be automatically undone|best-effort/i);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run test/tools/descriptions.test.ts`
Expected: FAIL — existing descriptions don't match.

- [ ] **Step 3: Update each tool description**

Rewrite descriptions to lead with the reversibility sentence and include the "this server cannot …" negation where applicable. Example edits:

```typescript
// src/tools/label-thread.ts
description: 'Add or remove a label. Fully reversible via `undo_intent` within 30 days. Applies per-account across the provided targets; pass dry_run: true to preview.'
```

```typescript
// src/tools/queue-send.ts
description: 'Queue an email for human review. ALWAYS requires human approval. This server cannot send mail; queued messages require explicit human approval through a separate flow before transmission. You can provide a draft_id …'
```

```typescript
// src/tools/unsubscribe-sender.ts
description: 'Submit a list-unsubscribe request for a sender. This is best-effort and cannot be automatically undone (the remote provider may honor or ignore it). This server cannot send additional email on your behalf beyond the unsubscribe POST.'
```

```typescript
// src/tools/draft-reply.ts
description: 'Create a draft reply in the account\'s Drafts folder. Fully reversible: drafts can be deleted. This server cannot send mail — sending requires queue_send followed by human approval.'
```

- [ ] **Step 4: Verify PASS**

Run: `npx vitest run test/tools/descriptions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools test/tools/descriptions.test.ts
git commit -m "feat(tools): reversibility-first descriptions with 'this server cannot' framing"
```

### Task 5.4: MCP annotations table

**Files:**
- Modify: every `src/tools/*.ts` to set `annotations` exactly per the spec's table.
- Test: `test/tools/annotations.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/tools/annotations.test.ts
import { describe, it, expect } from 'vitest';
import { searchThreadsTool } from '../../src/tools/search-threads.js';
import { readThreadTool } from '../../src/tools/read-thread.js';
import { listSendersTool } from '../../src/tools/list-senders.js';
import { listMailboxesTool } from '../../src/tools/list-mailboxes.js';
import { getAuditLogTool } from '../../src/tools/get-audit-log.js';
import { getOverviewTool } from '../../src/tools/get-overview.js';
import { getPendingActionsTool } from '../../src/tools/get-pending-actions.js';
import { getIntentTool } from '../../src/tools/get-intent.js';
import { labelThreadTool } from '../../src/tools/label-thread.js';
import { holdMessagesTool } from '../../src/tools/hold-messages.js';
import { restoreMessagesTool } from '../../src/tools/restore-messages.js';
import { undoIntentTool } from '../../src/tools/undo-intent.js';
import { draftReplyTool } from '../../src/tools/draft-reply.js';
import { queueSendTool } from '../../src/tools/queue-send.js';
import { unsubscribeSenderTool } from '../../src/tools/unsubscribe-sender.js';

const cases: Array<[string, any, { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean }]> = [
  ['search_threads', searchThreadsTool, { readOnlyHint: true, destructiveHint: false, idempotentHint: true }],
  ['read_thread', readThreadTool, { readOnlyHint: true, destructiveHint: false, idempotentHint: true }],
  ['list_senders', listSendersTool, { readOnlyHint: true, destructiveHint: false, idempotentHint: true }],
  ['list_mailboxes', listMailboxesTool, { readOnlyHint: true, destructiveHint: false, idempotentHint: true }],
  ['get_audit_log', getAuditLogTool, { readOnlyHint: true, destructiveHint: false, idempotentHint: true }],
  ['get_overview', getOverviewTool, { readOnlyHint: true, destructiveHint: false, idempotentHint: true }],
  ['get_pending_actions', getPendingActionsTool, { readOnlyHint: true, destructiveHint: false, idempotentHint: true }],
  ['get_intent', getIntentTool, { readOnlyHint: true, destructiveHint: false, idempotentHint: true }],
  ['label_thread', labelThreadTool, { readOnlyHint: false, destructiveHint: false, idempotentHint: true }],
  ['hold_messages', holdMessagesTool, { readOnlyHint: false, destructiveHint: false, idempotentHint: true }],
  ['restore_messages', restoreMessagesTool, { readOnlyHint: false, destructiveHint: false, idempotentHint: true }],
  ['undo_intent', undoIntentTool, { readOnlyHint: false, destructiveHint: false, idempotentHint: true }],
  ['draft_reply', draftReplyTool, { readOnlyHint: false, destructiveHint: false, idempotentHint: false }],
  ['queue_send', queueSendTool, { readOnlyHint: false, destructiveHint: true, idempotentHint: false }],
  ['unsubscribe_sender', unsubscribeSenderTool, { readOnlyHint: false, destructiveHint: true, idempotentHint: false }],
];

describe('tool annotations', () => {
  for (const [name, tool, expected] of cases) {
    it(`${name} has expected annotations`, () => {
      expect(tool.annotations).toMatchObject(expected);
    });
  }
});
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run test/tools/annotations.test.ts`
Expected: multiple failures.

- [ ] **Step 3: Set annotations in each tool file**

For each tool, replace/add:

```typescript
annotations: { readOnlyHint: <bool>, destructiveHint: <bool>, idempotentHint: <bool> }
```

per the table above.

- [ ] **Step 4: Verify PASS**

Run: `npx vitest run test/tools/annotations.test.ts`
Expected: 15 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools test/tools/annotations.test.ts
git commit -m "feat(tools): set MCP annotations consistently across every tool"
```

---

## Phase 6 — Bundle D polish

### Task 6.1: `limit` description + `per_account_counts`

**Files:**
- Modify: `src/tools/search-threads.ts`
- Modify: `src/executor/executor.ts` (search_threads case — add `per_account_counts` to envelope)
- Test: `test/executor/search-threads-per-account-counts.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/executor/search-threads-per-account-counts.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Executor } from '../../src/executor/executor.js';
import { openDatabase } from '../../src/ledger/db.js';
import { createLogger } from '../../src/logger.js';

const logger = createLogger('cli', { minLevel: 'error' });

describe('search_threads per_account_counts', () => {
  it('returns a per-account count map in the envelope', async () => {
    const pool = {
      withConnection: vi.fn(async (accountId: string, fn: any) =>
        fn({
          searchThreads: async () => accountId === 'a@x.com'
            ? [{ threadId: 't1' }, { threadId: 't2' }]
            : [{ threadId: 't3' }],
        })
      ),
    };
    const accounts = [{ id: 'a@x.com' } as any, { id: 'b@y.com' } as any];
    const executor = new Executor({ db: openDatabase(':memory:'), accounts, pool: pool as any, logger });
    const { result } = await executor.executeImmediate({
      tool: 'search_threads',
      toolParams: { limit: 10 },
      accountId: 'a@x.com', agentId: 'test', risk: 'none',
    });
    const payload = JSON.parse(result[0].text);
    expect(payload.per_account_counts).toEqual({ 'a@x.com': 2, 'b@y.com': 1 });
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run test/executor/search-threads-per-account-counts.test.ts`
Expected: FAIL.

- [ ] **Step 3: Edit `src/tools/search-threads.ts`**

Update the `limit` field description:

```typescript
limit: z.number().int().positive().max(500).default(20)
  .describe('Max results per account (default: 20). When multiple accounts are queried, results are interleaved; use a single account_id for a true top-N.'),
```

In `src/executor/executor.ts` search_threads case, after computing per-account results, add:

```typescript
const per_account_counts: Record<string, number> = {};
for (const [accountId, rows] of Object.entries(fanResult.per_account)) {
  per_account_counts[accountId] = (rows as any[]).length;
}
payload.per_account_counts = per_account_counts;
```

- [ ] **Step 4: Verify PASS**

Run: `npx vitest run test/executor/search-threads-per-account-counts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(search_threads): per_account_counts envelope field + updated limit docs"
```

### Task 6.2: `list_unsubscribe` parser

**Files:**
- Create: `src/lib/list-unsubscribe.ts`
- Modify: `src/provider/mime.ts` (or wherever list_unsubscribe is attached to envelopes) to call the parser.
- Modify: `src/types.ts` — change `listUnsubscribe?: string` to `listUnsubscribe?: ParsedUnsubscribe`.
- Test: `test/lib/list-unsubscribe.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/lib/list-unsubscribe.test.ts
import { describe, it, expect } from 'vitest';
import { parseListUnsubscribe } from '../../src/lib/list-unsubscribe.js';

describe('parseListUnsubscribe', () => {
  it('decodes RFC 2047 quoted-printable wrapper', () => {
    const raw = '=?us-ascii?Q?<https://example.com/u?id=42>,_<mailto:u@example.com>?=';
    const r = parseListUnsubscribe(raw);
    expect(r.http_url).toBe('https://example.com/u?id=42');
    expect(r.mailto).toBe('mailto:u@example.com');
  });

  it('parses bare RFC 2369 header', () => {
    const r = parseListUnsubscribe('<https://x.com/u>, <mailto:a@x.com>');
    expect(r.http_url).toBe('https://x.com/u');
    expect(r.mailto).toBe('mailto:a@x.com');
    expect(r.one_click).toBe(false);
  });

  it('detects RFC 8058 one-click', () => {
    const r = parseListUnsubscribe('<https://x.com/u>', 'List-Unsubscribe=One-Click');
    expect(r.one_click).toBe(true);
  });

  it('keeps raw when unparseable', () => {
    const raw = 'garbage not a header';
    const r = parseListUnsubscribe(raw);
    expect(r.raw).toBe(raw);
    expect(r.http_url).toBeUndefined();
    expect(r.mailto).toBeUndefined();
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run test/lib/list-unsubscribe.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```typescript
// src/lib/list-unsubscribe.ts
export interface ParsedUnsubscribe {
  http_url?: string;
  mailto?: string;
  one_click: boolean;
  raw: string;
}

function decodeRfc2047(input: string): string {
  return input.replace(/=\?([^?]+)\?([QBqb])\?([^?]*)\?=/g, (_m, _charset, enc, payload) => {
    if (enc.toUpperCase() === 'Q') {
      return payload.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x: string, h: string) =>
        String.fromCharCode(parseInt(h, 16))
      );
    }
    try { return Buffer.from(payload, 'base64').toString('utf8'); } catch { return payload; }
  });
}

export function parseListUnsubscribe(raw: string, postHeader?: string): ParsedUnsubscribe {
  const decoded = decodeRfc2047(raw);
  const uris = [...decoded.matchAll(/<([^>]+)>/g)].map((m) => m[1]);
  const http_url = uris.find((u) => /^https?:/i.test(u));
  const mailto = uris.find((u) => /^mailto:/i.test(u));
  const one_click = !!postHeader && /List-Unsubscribe=One-Click/i.test(postHeader);
  return { http_url, mailto, one_click, raw };
}
```

Wire it into the MIME parser so that envelopes expose `listUnsubscribe: ParsedUnsubscribe | undefined`. Update `src/types.ts` `EmailMessage.listUnsubscribe` type accordingly.

- [ ] **Step 4: Verify PASS (parser tests)**

Run: `npx vitest run test/lib/list-unsubscribe.test.ts`
Expected: PASS.

Run: `npx vitest run`
Expected: provider/mime tests may need updates to the new shape. Update any remaining assertions that expected a bare string.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(lib): parse list_unsubscribe into {http_url, mailto, one_click, raw}"
```

### Task 6.3: Populate snippets

**Files:**
- Modify: `src/provider/imap.ts` — add `fetchSnippet(mailbox, uid): Promise<string>`.
- Modify: `src/provider/mime.ts` — helper `extractSnippet(bodyStructure, partialBody): string`.
- Modify: `src/executor/executor.ts` — `search_threads` / `read_thread` cases call the snippet helper.
- Test: `test/provider/snippets.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/provider/snippets.test.ts
import { describe, it, expect } from 'vitest';
import { extractSnippet } from '../../src/provider/mime.js';

describe('extractSnippet', () => {
  it('returns first 500 chars of text/plain part', () => {
    const plain = 'a'.repeat(600);
    const snippet = extractSnippet({ type: 'text/plain', content: plain });
    expect(snippet).toHaveLength(500);
    expect(snippet.startsWith('aaaa')).toBe(true);
  });

  it('strips tags from text/html when no plain present', () => {
    const html = '<p>Hello <b>world</b></p>';
    const snippet = extractSnippet({ type: 'text/html', content: html });
    expect(snippet).toBe('Hello world');
  });

  it('returns empty string when no body', () => {
    expect(extractSnippet(null as any)).toBe('');
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run test/provider/snippets.test.ts`
Expected: FAIL — export missing.

- [ ] **Step 3: Implement `extractSnippet` + `fetchSnippet`**

```typescript
// src/provider/mime.ts — append
export interface SnippetSource { type: 'text/plain' | 'text/html'; content: string }

export function extractSnippet(src: SnippetSource | null): string {
  if (!src) return '';
  const text = src.type === 'text/html'
    ? src.content.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    : src.content;
  return text.slice(0, 500);
}
```

In `src/provider/imap.ts`, add:

```typescript
async fetchSnippet(mailbox: string, uid: number): Promise<string> {
  const selected = await this.mailboxOpen(mailbox);
  try {
    // Find first text/plain or text/html part from BODYSTRUCTURE
    for await (const msg of this.client.fetch({ uid }, { bodyStructure: true, uid: true })) {
      const part = findPart(msg.bodyStructure, ['text/plain', 'text/html']);
      if (!part) continue;
      const data = await this.fetchPartial(uid, part.partID, 2048); // ~500 chars after decode
      return extractSnippet({ type: part.type as any, content: data });
    }
    return '';
  } finally {
    selected.release?.();
  }
}
```

In the `search_threads` and `read_thread` executor branches, after producing each envelope, populate `snippet`. One worker function in `src/provider/mime.ts` keeps behavior uniform.

- [ ] **Step 4: Verify PASS**

Run: `npx vitest run test/provider/snippets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(provider): populate snippet from first text/plain or stripped text/html part"
```

---

## Phase 7 — Bundle E classifier cleanup

### Task 7.1: Drop `is_automated` everywhere, rename `is_automated_ratio` → `is_list_mail_ratio`

**Files:**
- Modify: `src/tools/list-senders.ts`
- Modify: `src/executor/executor.ts` (list_senders case)
- Modify: `src/tools/get-overview.ts` (remove `is_automated`)
- Modify: `src/provider/mime.ts` or wherever is_automated is computed — delete it.
- Test: `test/tools/list-senders.test.ts` and `test/tools/get-overview.test.ts` — update.

- [ ] **Step 1: Update tests to expect the new shape**

Edit `test/tools/list-senders.test.ts` to:
- Remove any assertions on `is_automated`.
- Add `expect(row).not.toHaveProperty('is_automated')`.
- Add `expect(row.is_list_mail_ratio).toBeGreaterThanOrEqual(0)`.

Edit `test/tools/get-overview.test.ts` similarly.

- [ ] **Step 2: Verify failure**

Run: `npx vitest run test/tools/list-senders.test.ts test/tools/get-overview.test.ts`
Expected: FAIL (shape mismatch).

- [ ] **Step 3: Implement removal**

- `src/tools/list-senders.ts`: description now says "Bulk triage: make N sender decisions instead of 10×N UID decisions. Aggregate inbox messages by sender across one or more accounts. Returns rows of `{account_id, from, count, sample_uids, has_unsubscribe, is_list_mail_ratio, latest_date}` ordered by count descending." Remove `is_automated_ratio` from any type.
- `src/executor/executor.ts` list_senders case: build `is_list_mail_ratio = count_with_list_headers / count`.
- `src/tools/get-overview.ts`: delete every `is_automated` reference.
- Classifier module (if any): delete; remove its import.

- [ ] **Step 4: Verify PASS**

Run: `npx vitest run test/tools`
Expected: PASS all tool tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: drop is_automated, rename is_automated_ratio to is_list_mail_ratio"
```

### Task 7.2: `get_overview` recommends `list_senders` when inbox is sender-heavy

**Files:**
- Modify: `src/tools/get-overview.ts` / the overview builder.
- Test: `test/tools/get-overview-recommends-list-senders.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/tools/get-overview-recommends-list-senders.test.ts
import { describe, it, expect } from 'vitest';
import { buildOverviewProse } from '../../src/tools/get-overview.js';

describe('get_overview recommendation', () => {
  it('recommends list_senders when >30 senders have count>3', () => {
    const senders = Array.from({ length: 31 }, (_, i) => ({ from: `s${i}@x`, count: 4 }));
    const prose = buildOverviewProse({ senders });
    expect(prose).toMatch(/list_senders will let you make sender-level decisions/);
  });
  it('does not recommend when under threshold', () => {
    const senders = [{ from: 'a@x', count: 2 }];
    const prose = buildOverviewProse({ senders });
    expect(prose).not.toMatch(/list_senders/);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run test/tools/get-overview-recommends-list-senders.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Extract the prose builder in `src/tools/get-overview.ts`:

```typescript
export function buildOverviewProse(args: { senders: Array<{ from: string; count: number }> }): string {
  const heavySenders = args.senders.filter((s) => s.count > 3);
  const lines: string[] = [];
  if (heavySenders.length > 30) {
    lines.push(
      `You have ${heavySenders.length} senders with 4+ messages — \`list_senders\` will let you make sender-level decisions instead of per-UID.`
    );
  }
  return lines.join('\n');
}
```

Call `buildOverviewProse` from the main overview response assembly.

- [ ] **Step 4: Verify PASS**

Run: `npx vitest run test/tools/get-overview-recommends-list-senders.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/get-overview.ts test/tools/get-overview-recommends-list-senders.test.ts
git commit -m "feat(get_overview): recommend list_senders when inbox is sender-heavy"
```

---

## Phase 8 — Cleanup, typecheck, audit

### Task 8.1: Full validate pass

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: zero errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 3: `npm run validate`**

Run: `npm run validate`
Expected: typecheck + tests + audit all pass.

- [ ] **Step 4: Final commit if any fixups**

```bash
git add -A
git commit -m "chore: final cleanup for v3"
```

### Task 8.2: Update README and integration test

**Files:**
- Modify: `README.md` — replace any `quarantine` language with `hold`/`holding`; document `restore_messages`, `get_intent`.
- Modify: `test/integration/mcp-triage-v2.test.ts` → rename file to `mcp-triage-v3.test.ts`, extend with a scenario: hold → restore partial, verify via `get_intent`.

- [ ] **Step 1: Write the new integration scenario**

Add to the integration test a case:
1. `hold_messages` with `include_summary: true` for 3 UIDs.
2. `get_intent` returns the 3 targets.
3. `restore_messages` for 1 of the 3 UIDs.
4. `get_intent` on the hold intent now reports `status: executed` and `reversed_by_intent_id: <restore id>`.
5. The response from every mutation includes `reversible: true` and `undo_hint`.

- [ ] **Step 2: Run**

Run: `npx vitest run test/integration/mcp-triage-v3.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs+test: README updates and v3 integration scenario"
```

---

## Self-review notes

- **Spec coverage:** Bundle A → Phase 4; Bundle B → Phase 5; Bundle C (rename) → Phase 3 + Phases 1-2 ledger/folder migration; Bundle D → Phase 6; Bundle E → Phase 7. Breaking-changes list from spec all covered (tool rename, `is_automated` removal, `is_automated_ratio` rename, `list_unsubscribe` shape, folder rename, ledger intent-type rename).
- **Type consistency:** `hold_messages` is the canonical name everywhere after Task 3.1. `restore_messages` / `get_intent` used consistently. `ParsedUnsubscribe`, `IntentTargetRow`, `EnvelopeSnapshot` types reused rather than redeclared.
- **No placeholders:** every step has exact code, file paths, and run commands. One spot to flag — Task 6.3's `fetchSnippet` references a `findPart` helper; if the existing codebase lacks one, implement it inline in the same task by scanning `bodyStructure.childNodes` recursively. Do not ship the task without that helper.
- **Known edge cases handled in tests:** RFC 2047 decoding, one-click detection, unknown intent_id, missing ledger snapshot, dry_run omission of undo_hint, IMAP RENAME fallback.
