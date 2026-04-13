# Agent Overview MVP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix agent-mail's general-browsing experience: correct IMAP ordering, pooled connections, readable snippets, an attention-signals module, and a new `get_overview` fat primitive that returns a rich attention-tagged view of all accounts in one call.

**Architecture:** Additive, forward-compatible with a future local-store ("Z") architecture. New modules: `src/provider/imap-pool.ts`, `src/provider/mime.ts`, `src/attention/signals.ts`, `src/tools/get-overview.ts`. Modified: `src/types.ts` (Participant type), `src/provider/imap.ts` (ordering fix + snippets), `src/executor/executor.ts` (pool borrow), `src/server/server.ts` + `src/cli/reviewer.ts` (pool wire-up), `src/tools/search-threads.ts` (`since` + signals).

**Tech Stack:** TypeScript, Node.js 20+, vitest, imapflow, zod, @modelcontextprotocol/sdk.

**Spec:** `docs/superpowers/specs/2026-04-13-agent-overview-mvp-design.md`

---

## Conventions

- Every step is TDD-ordered: write failing test → run it (fail) → implement → run it (pass) → commit.
- Run targeted tests during work with `npx vitest run <path>`.
- Run the full suite (`npm test`) and `npm run typecheck` before every commit.
- Commits use conventional-commit style (`feat:`, `fix:`, `refactor:`, `test:`, `chore:`).
- **Never claim a task complete without `npm run typecheck` and `npm test` both green.**
- If a step's test fails unexpectedly, stop and investigate root cause before moving forward.

---

## File plan

| File | Status | Responsibility |
|---|---|---|
| `src/types.ts` | modify | Add `Participant`; `EmailMessage.from/to/cc` become `Participant`/`Participant[]` |
| `src/provider/mime.ts` | create | `extractSnippet(source)` — partial-source snippet parser |
| `src/provider/imap.ts` | modify | Fix ordering; use `extractSnippet`; produce `Participant` shapes |
| `src/provider/imap-pool.ts` | create | `ImapConnectionPool` — per-account pooling, keepalive, reconnect |
| `src/executor/executor.ts` | modify | Borrow from pool; pass `accountEmail` to signal computation |
| `src/server/server.ts` | modify | Construct pool; register shutdown hook; register `get_overview` |
| `src/cli/reviewer.ts` | modify | Construct pool for reviewer's Executor |
| `src/attention/signals.ts` | create | `computeSignals(msg, context)` — pure function |
| `src/tools/search-threads.ts` | modify | Add `since` param |
| `src/tools/get-overview.ts` | create | `get_overview` tool — fat primitive |
| `test/provider/mime.test.ts` | create | Snippet extraction tests |
| `test/provider/imap-pool.test.ts` | create | Pool behavior tests |
| `test/provider/imap-search-ordering.test.ts` | create | Pure helper tests for search ordering |
| `test/attention/signals.test.ts` | create | Signals computation tests |
| `test/tools/get-overview.test.ts` | create | Orchestration tests for the fat primitive |
| `test/executor/executor.test.ts` | modify | Update mocks for `Participant` shape and pool |
| `test/provider/threading.test.ts` | modify | Update fixtures for `Participant` shape |

---

## Task 1: Add `Participant` type and refactor `EmailMessage`

**Why first:** every downstream task reads or writes `EmailMessage.from/to/cc`. Changing the shape later means rewriting tests. Do it first.

**Files:**
- Modify: `src/types.ts`
- Modify: `src/provider/imap.ts:65-80, 108-123` (address formatting in `search` and `fetchMessage`)
- Modify: `src/provider/threading.ts:72-76` (participant collection)
- Modify: `test/provider/threading.test.ts` (fixtures)
- Modify: `test/executor/executor.test.ts:16` (mock fetchMessage return)

- [ ] **Step 1: Write the failing test**

Add to `test/provider/threading.test.ts` inside the existing `describe('buildThreads', ...)` block:

```ts
  it('collects Participant objects with lowercased addresses', () => {
    const messages: EmailMessage[] = [
      makeMessage({
        uid: 1,
        messageId: 'msg-1@test.com',
        from: { address: 'Alice@Test.com', name: 'Alice' },
        to: [{ address: 'BOB@test.com', name: null }],
      }),
    ];

    const threads = buildThreads(messages, 'gmail');
    const addresses = threads[0].participants.map((p) =>
      typeof p === 'string' ? p : p.address
    );
    expect(addresses).toContain('alice@test.com');
    expect(addresses).toContain('bob@test.com');
  });
```

Also update the `makeMessage` helper at the top of that file:

```ts
function makeMessage(overrides: Partial<EmailMessage>): EmailMessage {
  return {
    uid: 1,
    messageId: 'msg-1@test.com',
    from: { address: 'alice@test.com', name: 'Alice' },
    to: [{ address: 'bob@test.com', name: 'Bob' }],
    cc: [],
    date: '2026-04-10T10:00:00Z',
    subject: 'Test',
    bodyText: 'Hello',
    references: [],
    flags: [],
    mailbox: 'INBOX',
    ...overrides,
  };
}
```

Update the existing `'collects participants from all messages'` test's messages to use `Participant` objects:

```ts
  it('collects participants from all messages', () => {
    const messages: EmailMessage[] = [
      makeMessage({
        uid: 1,
        messageId: 'msg-1@test.com',
        from: { address: 'alice@test.com', name: null },
        to: [{ address: 'bob@test.com', name: null }],
      }),
      makeMessage({
        uid: 2,
        messageId: 'msg-2@test.com',
        from: { address: 'bob@test.com', name: null },
        to: [
          { address: 'alice@test.com', name: null },
          { address: 'carol@test.com', name: null },
        ],
        inReplyTo: 'msg-1@test.com',
        references: ['msg-1@test.com'],
      }),
    ];

    const threads = buildThreads(messages, 'gmail');
    const addresses = threads[0].participants.map((p) =>
      typeof p === 'string' ? p : p.address
    );
    expect(addresses).toContain('alice@test.com');
    expect(addresses).toContain('bob@test.com');
    expect(addresses).toContain('carol@test.com');
  });
```

- [ ] **Step 2: Run the new test to confirm it fails**

```bash
npx vitest run test/provider/threading.test.ts
```

Expected: type errors and/or test failures referencing `Participant` or string-vs-object mismatches on `from`/`to`/`participants`.

- [ ] **Step 3: Update `src/types.ts`**

Add the `Participant` interface above the `EmailMessage` interface and update `EmailMessage` / `EmailThread`:

```ts
// === Email ===

export interface Participant {
  address: string; // lowercased, trimmed
  name: string | null;
}

export interface EmailMessage {
  uid: number;
  messageId: string;
  from: Participant;
  to: Participant[];
  cc: Participant[];
  date: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  inReplyTo?: string;
  references: string[];
  flags: string[];
  listUnsubscribe?: string;
  mailbox: string;
}

export interface EmailThread {
  threadId: string;
  accountId: string;
  subject: string;
  participants: Participant[];
  messageCount: number;
  messages: EmailMessage[];
}
```

- [ ] **Step 4: Update `src/provider/threading.ts`**

Replace the participant collection loop (lines 72-76) and the thread return shape:

```ts
  // Convert groups to threads
  const threads: EmailThread[] = [];
  for (const [threadId, msgs] of groups) {
    // Sort messages chronologically
    msgs.sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );

    // Union of participants across the thread, ordered by first appearance
    const seen = new Set<string>();
    const participants: Participant[] = [];
    const addParticipant = (p: Participant) => {
      if (!seen.has(p.address)) {
        seen.add(p.address);
        participants.push(p);
      }
    };
    for (const msg of msgs) {
      addParticipant(msg.from);
      for (const to of msg.to) addParticipant(to);
      for (const cc of msg.cc) addParticipant(cc);
    }

    threads.push({
      threadId,
      accountId,
      subject: msgs[0].subject,
      participants,
      messageCount: msgs.length,
      messages: msgs,
    });
  }
```

Don't forget to add `Participant` to the import at the top:

```ts
import type { EmailMessage, EmailThread, Participant } from '../types.js';
```

- [ ] **Step 5: Update `src/provider/imap.ts` address parsing**

Add a helper near the top of the file (under the imports):

```ts
import type { ResolvedAccount, EmailMessage, SearchCriteria, Participant } from '../types.js';

function toParticipant(addr: { name?: string | null; address?: string | null } | undefined): Participant {
  return {
    address: (addr?.address ?? '').trim().toLowerCase(),
    name: addr?.name?.trim() || null,
  };
}

function toParticipants(addrs: Array<{ name?: string | null; address?: string | null }> | undefined): Participant[] {
  return (addrs ?? []).map(toParticipant);
}
```

Replace the search method's `fromAddr` construction (lines ~66-80). The full `search()` body becomes (keep the signature unchanged for now — we'll fix ordering in Task 3):

```ts
  async search(
    mailbox: string,
    criteria: SearchCriteria,
    limit: number = 20
  ): Promise<Array<{ uid: number; envelope: { subject: string; from: Participant; date: string }; snippet: string; flags: string[] }>> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const searchQuery: Record<string, unknown> = {};
      if (criteria.from) searchQuery.from = criteria.from;
      if (criteria.to) searchQuery.to = criteria.to;
      if (criteria.subject) searchQuery.subject = criteria.subject;
      if (criteria.body) searchQuery.body = criteria.body;
      if (criteria.since) searchQuery.since = criteria.since;
      if (criteria.before) searchQuery.before = criteria.before;
      if (criteria.flagged !== undefined) searchQuery.flagged = criteria.flagged;
      if (criteria.seen !== undefined) searchQuery.seen = criteria.seen;

      const query = Object.keys(searchQuery).length > 0 ? searchQuery : { all: true };

      const results: Array<{
        uid: number;
        envelope: { subject: string; from: Participant; date: string };
        snippet: string;
        flags: string[];
      }> = [];

      let count = 0;
      for await (const msg of this.client.fetch(query as any, {
        uid: true,
        envelope: true,
        flags: true,
        bodyStructure: true,
        source: { start: 0, maxLength: 256 },
      })) {
        if (count >= limit) break;

        results.push({
          uid: msg.uid,
          envelope: {
            subject: msg.envelope?.subject ?? '(no subject)',
            from: toParticipant(msg.envelope?.from?.[0]),
            date: msg.envelope?.date?.toISOString() ?? new Date().toISOString(),
          },
          snippet: msg.source?.toString('utf-8', 0, 200) ?? '',
          flags: Array.from(msg.flags ?? []),
        });
        count++;
      }
      return results;
    } finally {
      lock.release();
    }
  }
```

Replace the `fetchMessage` address section (lines ~110-122):

```ts
      const fromAddr = toParticipant(msg.envelope?.from?.[0]);
      const toAddrs = toParticipants(msg.envelope?.to);
      const ccAddrs = toParticipants(msg.envelope?.cc);
```

And change the return to use those vars instead of the old string arrays:

```ts
      return {
        uid: msg.uid,
        messageId: msg.envelope?.messageId ?? `${uid}@unknown`,
        from: fromAddr,
        to: toAddrs,
        cc: ccAddrs,
        date: msg.envelope?.date?.toISOString() ?? new Date().toISOString(),
        subject: msg.envelope?.subject ?? '(no subject)',
        bodyText,
        inReplyTo: inReplyTo ?? undefined,
        references,
        flags: Array.from(msg.flags ?? []),
        listUnsubscribe: listUnsubscribe ?? undefined,
        mailbox,
      };
```

- [ ] **Step 6: Update executor test mock**

In `test/executor/executor.test.ts:16`, update the mocked `fetchMessage` return value to match the new shape:

```ts
    fetchMessage: vi.fn().mockResolvedValue({
      uid: 1,
      messageId: 'test',
      from: { address: 'a@b.com', name: null },
      to: [],
      cc: [],
      date: '',
      subject: 'Test',
      bodyText: 'body',
      references: [],
      flags: [],
      mailbox: 'INBOX',
    }),
```

- [ ] **Step 7: Run full test suite + typecheck**

```bash
npm run typecheck && npm test
```

Expected: all green. If `src/executor/executor.ts` has a string-based `from` reference (currently it serializes EmailMessage directly to JSON, so it should pass), nothing else needs touching.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/provider/imap.ts src/provider/threading.ts test/provider/threading.test.ts test/executor/executor.test.ts
git commit -m "$(cat <<'EOF'
refactor: introduce Participant type for email addresses

Replaces string-based from/to/cc on EmailMessage with structured
Participant objects (lowercased address + optional display name).
Threads now surface Participant unions, setting up get_overview's
network signals.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: MIME snippet extraction module

**Files:**
- Create: `src/provider/mime.ts`
- Create: `test/provider/mime.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/provider/mime.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { extractSnippet } from '../../src/provider/mime.js';

function msg(headers: string, body: string): Buffer {
  return Buffer.from(`${headers}\r\n\r\n${body}`, 'utf-8');
}

describe('extractSnippet', () => {
  it('extracts plain text body at root', () => {
    const source = msg(
      'Content-Type: text/plain; charset=utf-8',
      'Hello world, this is the message body.'
    );
    expect(extractSnippet(source)).toBe('Hello world, this is the message body.');
  });

  it('strips quoted-reply tails', () => {
    const source = msg(
      'Content-Type: text/plain; charset=utf-8',
      'Thanks for sending that over.\r\n\r\nOn Mon, someone wrote:\r\n> previous text\r\n> more previous text'
    );
    expect(extractSnippet(source)).toBe('Thanks for sending that over.');
  });

  it('strips signatures after "-- "', () => {
    const source = msg(
      'Content-Type: text/plain; charset=utf-8',
      'The actual message.\r\n-- \r\nJane Doe\r\nSoftware Engineer'
    );
    expect(extractSnippet(source)).toBe('The actual message.');
  });

  it('decodes quoted-printable', () => {
    const source = msg(
      'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable',
      'Hello =3D world'
    );
    expect(extractSnippet(source)).toBe('Hello = world');
  });

  it('prefers text/plain part in multipart', () => {
    const source = Buffer.from(
      [
        'Content-Type: multipart/alternative; boundary="BOUNDARY"',
        '',
        '--BOUNDARY',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Plain text version of the message.',
        '--BOUNDARY',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>HTML version of the message.</p>',
        '--BOUNDARY--',
      ].join('\r\n'),
      'utf-8'
    );
    expect(extractSnippet(source)).toBe('Plain text version of the message.');
  });

  it('returns empty string for HTML-only messages (documented Y limitation)', () => {
    const source = msg(
      'Content-Type: text/html; charset=utf-8',
      '<p>Hello</p>'
    );
    expect(extractSnippet(source)).toBe('');
  });

  it('returns empty string on malformed input instead of throwing', () => {
    expect(() => extractSnippet(Buffer.from('garbage', 'utf-8'))).not.toThrow();
    expect(extractSnippet(Buffer.from('garbage', 'utf-8'))).toBe('');
  });

  it('truncates long bodies to ~200 chars', () => {
    const body = 'a'.repeat(500);
    const source = msg('Content-Type: text/plain; charset=utf-8', body);
    const snippet = extractSnippet(source);
    expect(snippet.length).toBeLessThanOrEqual(200);
    expect(snippet.length).toBeGreaterThan(0);
  });

  it('accepts string input as well as Buffer', () => {
    const source = 'Content-Type: text/plain; charset=utf-8\r\n\r\nString input works.';
    expect(extractSnippet(source)).toBe('String input works.');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/provider/mime.test.ts
```

Expected: import error — `src/provider/mime.js` does not exist.

- [ ] **Step 3: Create `src/provider/mime.ts`**

```ts
/**
 * Extract a short, readable snippet from a (possibly partial) message source.
 *
 * Handles text/plain root, multipart with text/plain first part, quoted-printable,
 * and strips quoted-reply tails and signatures. Returns empty string on any failure
 * (including HTML-only messages — that is a documented MVP limitation).
 *
 * Never throws.
 */
export function extractSnippet(source: Buffer | string, maxLength = 200): string {
  try {
    const text = typeof source === 'string' ? source : source.toString('utf-8');

    const { headers, body } = splitHeadersBody(text);
    if (!body) return '';

    const contentType = getHeader(headers, 'content-type') ?? 'text/plain';

    let rawBody: string;
    if (/^multipart\//i.test(contentType)) {
      const boundary = extractBoundary(contentType);
      if (!boundary) return '';
      const plainPart = findTextPlainPart(body, boundary);
      if (!plainPart) return '';
      rawBody = decodePart(plainPart);
    } else if (/^text\/plain/i.test(contentType)) {
      const encoding = getHeader(headers, 'content-transfer-encoding') ?? '7bit';
      rawBody = decodeEncoding(body, encoding);
    } else {
      // HTML-only or unknown — documented Y limitation
      return '';
    }

    const cleaned = stripQuotedReply(stripSignature(rawBody)).trim();
    if (!cleaned) return '';
    return cleaned.length > maxLength
      ? cleaned.slice(0, maxLength)
      : cleaned;
  } catch {
    return '';
  }
}

function splitHeadersBody(source: string): { headers: string; body: string } {
  const idx = source.search(/\r?\n\r?\n/);
  if (idx === -1) return { headers: source, body: '' };
  const sep = source[idx] === '\r' ? 4 : 2;
  return {
    headers: source.slice(0, idx),
    body: source.slice(idx + sep),
  };
}

function getHeader(headers: string, name: string): string | null {
  const regex = new RegExp(`^${name}:\\s*(.+?)(?:\\r?\\n(?!\\s)|$)`, 'im');
  const match = headers.match(regex);
  return match ? match[1].trim() : null;
}

function extractBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary="?([^";\s]+)"?/i);
  return match ? match[1] : null;
}

/** Given a multipart body and its boundary, return the raw text of the first text/plain part. */
function findTextPlainPart(body: string, boundary: string): string | null {
  const delimiter = `--${boundary}`;
  const parts = body.split(delimiter).slice(1); // drop preamble
  for (const part of parts) {
    if (part.trim() === '--' || part.trim() === '') continue;
    const trimmed = part.replace(/^\r?\n/, '');
    const { headers, body: partBody } = splitHeadersBody(trimmed);
    const partCt = getHeader(headers, 'content-type') ?? '';
    if (/^text\/plain/i.test(partCt)) {
      const enc = getHeader(headers, 'content-transfer-encoding') ?? '7bit';
      return decodeEncoding(partBody, enc);
    }
  }
  return null;
}

function decodePart(text: string): string {
  return text;
}

function decodeEncoding(body: string, encoding: string): string {
  const enc = encoding.trim().toLowerCase();
  if (enc === 'quoted-printable') {
    return body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16))
      );
  }
  if (enc === 'base64') {
    try {
      return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf-8');
    } catch {
      return '';
    }
  }
  // 7bit / 8bit / binary / unknown → pass through
  return body;
}

function stripQuotedReply(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;
    if (/^On .+ wrote:\s*$/.test(line)) break;
    out.push(line);
  }
  return out.join('\n');
}

function stripSignature(text: string): string {
  const match = text.match(/^-- \s*$/m);
  if (!match) return text;
  return text.slice(0, match.index ?? text.length);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run test/provider/mime.test.ts
```

Expected: all 9 tests pass.

- [ ] **Step 5: Run full suite + typecheck**

```bash
npm run typecheck && npm test
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/provider/mime.ts test/provider/mime.test.ts
git commit -m "$(cat <<'EOF'
feat: add mime snippet extraction for readable previews

New src/provider/mime.ts handles text/plain root and multipart messages,
decodes quoted-printable and base64, strips quoted-reply tails and
signatures. Fails silently to empty string on unparseable input —
snippets are best-effort previews, never throw.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Fix IMAP search ordering + wire in snippet extractor + `since` support

**Files:**
- Create: `src/provider/search-ordering.ts` (pure helper for testability)
- Modify: `src/provider/imap.ts` (search method rewritten)
- Create: `test/provider/imap-search-ordering.test.ts`

- [ ] **Step 1: Write the failing test for the pure helper**

Create `test/provider/imap-search-ordering.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { pickNewestUids } from '../../src/provider/search-ordering.js';

describe('pickNewestUids', () => {
  it('returns the last N uids from an ascending list', () => {
    const uids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(pickNewestUids(uids, 3)).toEqual([8, 9, 10]);
  });

  it('returns all uids when list shorter than limit', () => {
    expect(pickNewestUids([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });

  it('returns empty array for empty input', () => {
    expect(pickNewestUids([], 10)).toEqual([]);
  });

  it('respects limit of 0', () => {
    expect(pickNewestUids([1, 2, 3], 0)).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const uids = [1, 2, 3, 4, 5];
    pickNewestUids(uids, 2);
    expect(uids).toEqual([1, 2, 3, 4, 5]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run test/provider/imap-search-ordering.test.ts
```

Expected: import error.

- [ ] **Step 3: Create the helper**

Create `src/provider/search-ordering.ts`:

```ts
/**
 * Given an ascending-UID list from IMAP SEARCH, return the newest N UIDs.
 * IMAP UIDs within a mailbox are monotonically assigned, so "newest" == tail.
 */
export function pickNewestUids(uids: readonly number[], limit: number): number[] {
  if (limit <= 0 || uids.length === 0) return [];
  return uids.slice(-limit);
}
```

- [ ] **Step 4: Run to verify pass**

```bash
npx vitest run test/provider/imap-search-ordering.test.ts
```

Expected: 5 pass.

- [ ] **Step 5: Rewrite `ImapProvider.search()` in `src/provider/imap.ts`**

Replace the entire `search` method body (currently lines ~30-87). The new implementation uses `client.search()` (returns UIDs only), picks the tail, then fetches exactly those UIDs and sorts newest-first:

```ts
  async search(
    mailbox: string,
    criteria: SearchCriteria,
    limit: number = 20
  ): Promise<Array<{ uid: number; envelope: { subject: string; from: Participant; date: string }; snippet: string; flags: string[] }>> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const searchQuery: Record<string, unknown> = {};
      if (criteria.from) searchQuery.from = criteria.from;
      if (criteria.to) searchQuery.to = criteria.to;
      if (criteria.subject) searchQuery.subject = criteria.subject;
      if (criteria.body) searchQuery.body = criteria.body;
      if (criteria.since) searchQuery.since = criteria.since;
      if (criteria.before) searchQuery.before = criteria.before;
      if (criteria.flagged !== undefined) searchQuery.flagged = criteria.flagged;
      if (criteria.seen !== undefined) searchQuery.seen = criteria.seen;

      const query = Object.keys(searchQuery).length > 0 ? searchQuery : { all: true };

      // Phase 1: cheap UID-only search. imapflow returns ascending UIDs.
      const allUids = (await this.client.search(query as any, { uid: true })) ?? [];
      if (allUids.length === 0) return [];

      const uidsToFetch = pickNewestUids(allUids, limit);
      if (uidsToFetch.length === 0) return [];

      // Phase 2: hydrate envelopes + partial source for the selected UIDs.
      const results: Array<{
        uid: number;
        envelope: { subject: string; from: Participant; date: string };
        snippet: string;
        flags: string[];
      }> = [];

      for await (const msg of this.client.fetch(
        uidsToFetch.join(','),
        {
          uid: true,
          envelope: true,
          flags: true,
          source: { start: 0, maxLength: 2048 },
        },
        { uid: true }
      )) {
        results.push({
          uid: msg.uid,
          envelope: {
            subject: msg.envelope?.subject ?? '(no subject)',
            from: toParticipant(msg.envelope?.from?.[0]),
            date: msg.envelope?.date?.toISOString() ?? new Date().toISOString(),
          },
          snippet: extractSnippet(msg.source ?? Buffer.alloc(0)),
          flags: Array.from(msg.flags ?? []),
        });
      }

      // Sort descending by date (newest first). IMAP UIDs are usually chronological
      // but not guaranteed, so sort on the envelope date we already have.
      results.sort(
        (a, b) => new Date(b.envelope.date).getTime() - new Date(a.envelope.date).getTime()
      );

      return results;
    } finally {
      lock.release();
    }
  }
```

Add the two new imports at the top of `src/provider/imap.ts`:

```ts
import { pickNewestUids } from './search-ordering.js';
import { extractSnippet } from './mime.js';
```

- [ ] **Step 6: Run full suite + typecheck**

```bash
npm run typecheck && npm test
```

Expected: all green. The executor test still works because its IMAP mock is a wholesale replacement and doesn't exercise the real `search()`.

- [ ] **Step 7: Commit**

```bash
git add src/provider/search-ordering.ts src/provider/imap.ts test/provider/imap-search-ordering.test.ts
git commit -m "$(cat <<'EOF'
fix: return newest-first results from IMAP search

Current behavior streamed fetch results in UID-ascending order and
stopped at limit, returning the OLDEST N matches instead of the
newest. The fix: SEARCH for UIDs only, slice the tail, then fetch
exactly those messages and sort descending by envelope date.

Also wires in the new mime snippet extractor so snippets are actual
body previews instead of raw header bytes.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Connection pool

**Files:**
- Create: `src/provider/imap-pool.ts`
- Create: `test/provider/imap-pool.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/provider/imap-pool.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { AccountConfig } from '../../src/types.js';
import { createLogger } from '../../src/logger.js';

// Track the ImapProvider instances created and control their behavior
const instances: Array<{
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  noop: ReturnType<typeof vi.fn>;
  connected: boolean;
}> = [];

vi.mock('../../src/provider/imap.js', () => ({
  ImapProvider: vi.fn().mockImplementation(function () {
    const inst = {
      connect: vi.fn(async function (this: typeof inst) { this.connected = true; }),
      disconnect: vi.fn(async function (this: typeof inst) { this.connected = false; }),
      noop: vi.fn().mockResolvedValue(undefined),
      connected: false,
    };
    instances.push(inst);
    return inst;
  }),
}));

vi.mock('../../src/provider/credentials.js', () => ({
  resolveCredentials: vi.fn().mockImplementation((account: any) => ({
    ...account,
    auth: { user: account.email, pass: 'pw' },
  })),
}));

import { ImapConnectionPool } from '../../src/provider/imap-pool.js';

const account: AccountConfig = {
  id: 'test',
  email: 'test@example.com',
  imap: { host: 'imap.example.com', port: 993, tls: true },
  smtp: { host: 'smtp.example.com', port: 587, tls: true },
};

let pool: ImapConnectionPool;

beforeEach(() => {
  instances.length = 0;
  pool = new ImapConnectionPool({
    accounts: [account],
    logger: createLogger('cli', { minLevel: 'error' }),
  });
});

afterEach(async () => {
  await pool.closeAll();
});

describe('ImapConnectionPool', () => {
  it('lazily connects on first borrow', async () => {
    expect(instances).toHaveLength(0);
    await pool.withConnection('test', async () => 'ok');
    expect(instances).toHaveLength(1);
    expect(instances[0].connect).toHaveBeenCalledTimes(1);
  });

  it('reuses the same connection on subsequent borrows', async () => {
    await pool.withConnection('test', async () => 'a');
    await pool.withConnection('test', async () => 'b');
    expect(instances).toHaveLength(1);
    expect(instances[0].connect).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent borrows on the same account', async () => {
    const events: string[] = [];
    const a = pool.withConnection('test', async () => {
      events.push('a-start');
      await new Promise((r) => setTimeout(r, 20));
      events.push('a-end');
    });
    const b = pool.withConnection('test', async () => {
      events.push('b-start');
      events.push('b-end');
    });
    await Promise.all([a, b]);
    expect(events).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('reconnects and retries once after a connection-drop error', async () => {
    let callCount = 0;
    const result = await pool.withConnection('test', async () => {
      callCount++;
      if (callCount === 1) {
        const err = new Error('socket closed') as Error & { code?: string };
        err.code = 'NoConnection';
        throw err;
      }
      return 'success';
    });
    expect(result).toBe('success');
    expect(callCount).toBe(2);
    // Old instance was torn down, new one created
    expect(instances.length).toBeGreaterThanOrEqual(2);
  });

  it('propagates the error when the retry also fails', async () => {
    const err = () => {
      const e = new Error('socket closed') as Error & { code?: string };
      e.code = 'NoConnection';
      return e;
    };
    await expect(
      pool.withConnection('test', async () => {
        throw err();
      })
    ).rejects.toThrow('socket closed');
  });

  it('does not retry non-connection errors', async () => {
    let callCount = 0;
    await expect(
      pool.withConnection('test', async () => {
        callCount++;
        throw new Error('some business logic error');
      })
    ).rejects.toThrow('some business logic error');
    expect(callCount).toBe(1);
  });

  it('closeAll disconnects every live connection', async () => {
    await pool.withConnection('test', async () => 'ok');
    expect(instances[0].connected).toBe(true);
    await pool.closeAll();
    expect(instances[0].disconnect).toHaveBeenCalled();
  });

  it('throws for unknown account', async () => {
    await expect(
      pool.withConnection('nope', async () => 'x')
    ).rejects.toThrow(/nope/i);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx vitest run test/provider/imap-pool.test.ts
```

Expected: import error on `imap-pool.js`.

- [ ] **Step 3: Implement the pool**

Create `src/provider/imap-pool.ts`:

```ts
import { ImapProvider } from './imap.js';
import { resolveCredentials } from './credentials.js';
import { getAccount } from './accounts.js';
import type { AccountConfig } from '../types.js';
import type { Logger } from '../logger.js';

interface PoolDeps {
  accounts: AccountConfig[];
  logger: Logger;
  /** Interval in ms for keepalive NOOPs. Default 60_000. Pass 0 to disable. */
  keepaliveIntervalMs?: number;
}

interface PoolEntry {
  provider: ImapProvider | null;
  queue: Promise<void>;
  keepaliveTimer: NodeJS.Timeout | null;
}

/**
 * Per-account IMAP connection pool.
 *
 * - Lazy connect on first borrow.
 * - Per-account serialization (imapflow is not safe for concurrent ops on one conn).
 * - Keepalive NOOP every ~60s to prevent idle disconnects.
 * - Reconnect-once on dropped-connection errors; otherwise propagate.
 * - closeAll() for clean shutdown.
 */
export class ImapConnectionPool {
  private readonly accounts: AccountConfig[];
  private readonly logger: Logger;
  private readonly keepaliveIntervalMs: number;
  private readonly entries = new Map<string, PoolEntry>();
  private closed = false;

  constructor(deps: PoolDeps) {
    this.accounts = deps.accounts;
    this.logger = deps.logger;
    this.keepaliveIntervalMs = deps.keepaliveIntervalMs ?? 60_000;
  }

  async withConnection<T>(
    accountId: string,
    fn: (imap: ImapProvider) => Promise<T>
  ): Promise<T> {
    if (this.closed) {
      throw new Error('ImapConnectionPool is closed');
    }
    // Validate account exists before anything else
    getAccount(this.accounts, accountId);

    const entry = this.getOrCreateEntry(accountId);

    // Chain this borrow onto the per-account queue so concurrent calls serialize.
    // The task resolves/rejects with the fn result; the queue uses a swallowed
    // copy so a single failing task never poisons subsequent calls.
    const task: Promise<T> = entry.queue.then(() =>
      this.runWithRetry(accountId, entry, fn)
    );
    entry.queue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    const shutdowns: Array<Promise<void>> = [];
    for (const [accountId, entry] of this.entries) {
      if (entry.keepaliveTimer) {
        clearInterval(entry.keepaliveTimer);
        entry.keepaliveTimer = null;
      }
      if (entry.provider) {
        const p = entry.provider;
        entry.provider = null;
        shutdowns.push(
          (async () => {
            try {
              await p.disconnect();
            } catch (err) {
              this.logger.warn(`Pool shutdown error for ${accountId}`, {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          })()
        );
      }
    }
    // Best-effort: wait up to 5s for all disconnects
    await Promise.race([
      Promise.all(shutdowns),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
  }

  private getOrCreateEntry(accountId: string): PoolEntry {
    let entry = this.entries.get(accountId);
    if (!entry) {
      entry = { provider: null, queue: Promise.resolve(), keepaliveTimer: null };
      this.entries.set(accountId, entry);
    }
    return entry;
  }

  private async runWithRetry<T>(
    accountId: string,
    entry: PoolEntry,
    fn: (imap: ImapProvider) => Promise<T>
  ): Promise<T> {
    const provider = await this.ensureConnected(accountId, entry);
    try {
      return await fn(provider);
    } catch (err) {
      if (!isConnectionDropError(err)) throw err;
      this.logger.warn(`IMAP connection dropped for ${accountId}, reconnecting`, {
        error: err instanceof Error ? err.message : String(err),
      });
      // Tear down dead provider
      await this.teardown(entry);
      const freshProvider = await this.ensureConnected(accountId, entry);
      // Retry exactly once
      return await fn(freshProvider);
    }
  }

  private async ensureConnected(
    accountId: string,
    entry: PoolEntry
  ): Promise<ImapProvider> {
    if (entry.provider) return entry.provider;
    const account = getAccount(this.accounts, accountId);
    const resolved = resolveCredentials(account);
    const provider = new ImapProvider(resolved);
    await provider.connect();
    entry.provider = provider;
    this.startKeepalive(accountId, entry);
    return provider;
  }

  private startKeepalive(accountId: string, entry: PoolEntry): void {
    if (this.keepaliveIntervalMs <= 0) return;
    if (entry.keepaliveTimer) return;
    entry.keepaliveTimer = setInterval(async () => {
      const p = entry.provider;
      if (!p) return;
      try {
        // imapflow exposes noop via the provider wrapper
        await (p as unknown as { noop: () => Promise<void> }).noop();
      } catch (err) {
        this.logger.warn(`Keepalive NOOP failed for ${accountId}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        // Mark provider dead; next borrow will reconnect
        await this.teardown(entry);
      }
    }, this.keepaliveIntervalMs);
    // Don't block process exit on the keepalive timer
    entry.keepaliveTimer.unref?.();
  }

  private async teardown(entry: PoolEntry): Promise<void> {
    if (entry.keepaliveTimer) {
      clearInterval(entry.keepaliveTimer);
      entry.keepaliveTimer = null;
    }
    const p = entry.provider;
    entry.provider = null;
    if (p) {
      try {
        await p.disconnect();
      } catch {
        // best-effort
      }
    }
  }
}

function isConnectionDropError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: string }).code ?? '';
  const msg = err.message ?? '';
  return (
    code === 'NoConnection' ||
    /socket\s*closed/i.test(msg) ||
    /connection\s*(reset|lost|closed|ended)/i.test(msg) ||
    /BYE/i.test(msg)
  );
}
```

- [ ] **Step 4: Add `noop()` method to `ImapProvider`**

Add to `src/provider/imap.ts` (anywhere in the class):

```ts
  async noop(): Promise<void> {
    await this.client.noop();
  }
```

- [ ] **Step 5: Run pool tests**

```bash
npx vitest run test/provider/imap-pool.test.ts
```

Expected: 8 pass. If the serialization test fails, re-check the queue logic — the trick is that each `enqueue` call must install a gate that resolves only after the previous call's `release()` fires.

- [ ] **Step 6: Run full suite + typecheck**

```bash
npm run typecheck && npm test
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/provider/imap.ts src/provider/imap-pool.ts test/provider/imap-pool.test.ts
git commit -m "$(cat <<'EOF'
feat: add per-account IMAP connection pool

New ImapConnectionPool keeps one connection per account warm across
tool calls, serializes concurrent borrows, runs a 60s keepalive NOOP,
and reconnects-retries-once on dropped connections. Shutdown gracefully
disconnects every live connection with a 5s ceiling.

Eliminates the per-call TLS-handshake+auth cost that was the dominant
latency in multi-call agent tasks.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Executor borrows from the pool

**Files:**
- Modify: `src/executor/executor.ts`
- Modify: `test/executor/executor.test.ts`

- [ ] **Step 1: Update executor test to provide a pool and assert borrow semantics**

Update `test/executor/executor.test.ts`. Add a mock pool fixture after the `vi.mock('../../src/provider/credentials.js', ...)` block:

```ts
// Mock pool that simply resolves credentials and calls fn with a fresh mock provider
vi.mock('../../src/provider/imap-pool.js', () => ({
  ImapConnectionPool: vi.fn().mockImplementation(function () {
    return {
      withConnection: vi.fn(async (_: string, fn: (imap: any) => Promise<any>) => {
        const { ImapProvider } = await import('../../src/provider/imap.js');
        const provider = new (ImapProvider as any)();
        await provider.connect();
        return fn(provider);
      }),
      closeAll: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));
```

Update the `beforeEach` block to construct the pool and pass it:

```ts
import { ImapConnectionPool } from '../../src/provider/imap-pool.js';

let db: Database;
let executor: Executor;
let pool: ImapConnectionPool;

beforeEach(() => {
  db = openDatabase(':memory:');
  pool = new ImapConnectionPool({
    accounts: [testAccount],
    logger: createLogger('cli', { minLevel: 'error' }),
  });
  executor = new Executor({
    db,
    accounts: [testAccount],
    pool,
    logger: createLogger('cli', { minLevel: 'error' }),
  });
});
```

- [ ] **Step 2: Run the test to confirm failure**

```bash
npx vitest run test/executor/executor.test.ts
```

Expected: type error — `ExecutorDeps` does not accept `pool`.

- [ ] **Step 3: Update `src/executor/executor.ts`**

Change `ExecutorDeps` and the constructor to accept a pool; replace every `new ImapProvider(); connect(); ...; disconnect()` block in `performAction` and `performUndo` with `pool.withConnection`.

Top of file:

```ts
import type { Database } from '../ledger/sqlite.js';
import type { AccountConfig, Intent, RiskLevel } from '../types.js';
import type { Logger } from '../logger.js';
import type { ImapConnectionPool } from '../provider/imap-pool.js';
import {
  createIntent,
  getIntent,
  updateIntentStatus,
} from '../ledger/intents.js';
import { logAudit } from '../ledger/audit.js';
import { getAccount } from '../provider/accounts.js';
import { resolveCredentials } from '../provider/credentials.js';
import { createSmtpTransport, sendMail } from '../provider/smtp.js';
import { generateUndoToken, getUndoExpiry, parseUndoToken } from './undo.js';

export interface ExecutorDeps {
  db: Database;
  accounts: AccountConfig[];
  pool: ImapConnectionPool;
  logger: Logger;
}

export class Executor {
  private db: Database;
  private accounts: AccountConfig[];
  private pool: ImapConnectionPool;
  private logger: Logger;

  constructor(deps: ExecutorDeps) {
    this.db = deps.db;
    this.accounts = deps.accounts;
    this.pool = deps.pool;
    this.logger = deps.logger;
  }
```

Rewrite `performAction` to use `this.pool.withConnection`. The body of the switch statement stays the same — only the surrounding connect/disconnect changes:

```ts
  private async performAction(
    intent: Intent
  ): Promise<Array<{ type: 'text'; text: string }>> {
    const account = getAccount(this.accounts, intent.account_id);
    const resolved = resolveCredentials(account);

    return this.pool.withConnection(intent.account_id, async (imap) => {
      switch (intent.tool) {
        case 'search_threads': {
          const results = await imap.search(
            (intent.params.mailbox as string) ?? 'INBOX',
            {
              from: intent.params.from as string | undefined,
              to: intent.params.to as string | undefined,
              subject: intent.params.subject as string | undefined,
              body: intent.params.body as string | undefined,
              since: intent.params.since
                ? new Date(intent.params.since as string)
                : undefined,
            },
            (intent.params.limit as number) ?? 20
          );
          return [{ type: 'text', text: JSON.stringify(results, null, 2) }];
        }

        case 'read_thread': {
          const uid = intent.params.uid as number;
          const mailbox = (intent.params.mailbox as string) ?? 'INBOX';
          const msg = await imap.fetchMessage(mailbox, uid);
          return [{ type: 'text', text: JSON.stringify(msg, null, 2) }];
        }

        case 'draft_reply': {
          const raw = Buffer.from(
            [
              `From: ${account.email}`,
              `To: ${intent.params.to as string}`,
              `Subject: ${intent.params.subject as string}`,
              intent.params.in_reply_to
                ? `In-Reply-To: ${intent.params.in_reply_to}`
                : '',
              intent.params.references
                ? `References: ${(intent.params.references as string[]).join(' ')}`
                : '',
              `Date: ${new Date().toUTCString()}`,
              '',
              intent.params.body as string,
            ]
              .filter(Boolean)
              .join('\r\n')
          );
          const result = await imap.createDraft(raw);
          return [
            {
              type: 'text',
              text: JSON.stringify({
                draft_id: result.uid,
                message: 'Draft created',
              }),
            },
          ];
        }

        case 'label_thread': {
          const uids = intent.params.uids as number[];
          const mailbox = (intent.params.mailbox as string) ?? 'INBOX';
          const action = intent.params.action as 'add' | 'remove';
          const label = intent.params.label as string;

          if (action === 'add') {
            await imap.setFlags(uids, [label], mailbox);
          } else {
            await imap.removeFlags(uids, [label], mailbox);
          }
          return [
            {
              type: 'text',
              text: `Label "${label}" ${action === 'add' ? 'applied' : 'removed'}`,
            },
          ];
        }

        case 'quarantine_thread': {
          const uids = intent.params.uids as number[];
          const mailbox = (intent.params.mailbox as string) ?? 'INBOX';
          const quarantine = await imap.getMailboxPath('quarantine');
          await imap.moveMessages(uids, mailbox, quarantine);
          return [
            {
              type: 'text',
              text: `Moved ${uids.length} message(s) to quarantine`,
            },
          ];
        }

        case 'queue_send': {
          // SMTP doesn't go through the pool — it creates its own transport
          const transport = createSmtpTransport(resolved);
          const result = await sendMail(transport, {
            from: account.email,
            to: intent.params.to as string,
            subject: intent.params.subject as string,
            text: intent.params.body as string,
            inReplyTo: intent.params.in_reply_to as string | undefined,
            references: intent.params.references as string[] | undefined,
          });
          return [
            {
              type: 'text',
              text: JSON.stringify({
                sent: true,
                messageId: result.messageId,
              }),
            },
          ];
        }

        case 'unsubscribe_sender': {
          const url = intent.params.unsubscribe_url as string;
          if (!url) {
            return [
              { type: 'text', text: 'No unsubscribe URL found for this message' },
            ];
          }
          if (url.startsWith('mailto:')) {
            return [
              {
                type: 'text',
                text: 'Mailto unsubscribe not supported directly. Use queue_send to send an unsubscribe email.',
              },
            ];
          }
          const response = await fetch(url, { method: 'POST' });
          return [
            {
              type: 'text',
              text: `Unsubscribe request sent (HTTP ${response.status})`,
            },
          ];
        }

        default:
          return [{ type: 'text', text: `Unknown tool: ${intent.tool}` }];
      }
    });
  }
```

Rewrite `performUndo` similarly:

```ts
  private async performUndo(
    intent: Intent,
    undoOp: { reverseAction: string; params: Record<string, unknown> }
  ): Promise<void> {
    await this.pool.withConnection(intent.account_id, async (imap) => {
      switch (undoOp.reverseAction) {
        case 'move_back_to_inbox': {
          const uids = intent.params.uids as number[];
          const quarantine = await imap.getMailboxPath('quarantine');
          const inbox = await imap.getMailboxPath('inbox');
          await imap.moveMessages(uids, quarantine, inbox);
          break;
        }

        case 'reverse_label': {
          const uids = intent.params.uids as number[];
          const mailbox = (intent.params.mailbox as string) ?? 'INBOX';
          const action = intent.params.action as 'add' | 'remove';
          const label = intent.params.label as string;

          if (action === 'add') {
            await imap.removeFlags(uids, [label], mailbox);
          } else {
            await imap.setFlags(uids, [label], mailbox);
          }
          break;
        }

        default:
          throw new Error(`Unknown undo action: ${undoOp.reverseAction}`);
      }
    });
  }
```

- [ ] **Step 4: Run executor tests**

```bash
npx vitest run test/executor/executor.test.ts
```

Expected: all pass with the mock pool forwarding to a mock ImapProvider.

- [ ] **Step 5: Run full suite + typecheck**

```bash
npm run typecheck && npm test
```

Expected: all green. `src/server/server.ts` and `src/cli/reviewer.ts` will now have type errors because `new Executor({...})` no longer accepts the old shape — we fix those in Task 6.

**If typecheck fails on server.ts / reviewer.ts:** expected — continue to Task 6 before committing. If it fails elsewhere, investigate.

- [ ] **Step 6: Commit with Task 6 wire-up**

Do not commit yet. Proceed to Task 6 and commit the executor + wire-up changes together (one cohesive unit: "executor uses pool; server/reviewer construct pool").

---

## Task 6: Wire the pool into server and reviewer

**Files:**
- Modify: `src/server/server.ts`
- Modify: `src/cli/reviewer.ts`
- Modify: `src/cli/serve.ts` (register shutdown hook)

- [ ] **Step 1: Update `src/server/server.ts`**

Change `createMcpServer` to construct a pool and return it alongside the MCP server so the caller can register shutdown. Also pass it to the `Executor`.

Modify the signature and return shape:

```ts
export interface McpServerBundle {
  server: McpServer;
  pool: ImapConnectionPool;
}

export async function createMcpServer(): Promise<McpServerBundle> {
  const logger = createLogger('mcp');

  // Verify Keychain access
  try {
    verifyKeychainAccess();
  } catch (error) {
    logger.error(
      `Keychain verification failed: ${error instanceof Error ? error.message : error}`
    );
    process.exit(1);
  }

  // Load accounts
  let accounts;
  try {
    accounts = loadAccounts();
  } catch (error) {
    logger.error(
      'Failed to load accounts. Run "npx agent-mail add-account" first.'
    );
    process.exit(1);
  }

  if (accounts.length === 0) {
    logger.error(
      'No accounts configured. Run "npx agent-mail add-account" first.'
    );
    process.exit(1);
  }

  // Open database
  const db = openDatabase();

  // Check for stuck executing intents (crash recovery)
  const stuck = checkStuckExecuting(db);
  if (stuck.length > 0) {
    logger.warn(
      `Found ${stuck.length} intent(s) stuck in 'executing' status (possible crash recovery).`,
      { intents: stuck.map((i) => ({ id: i.id, tool: i.tool })) }
    );
  }

  // Load policy
  const policy = loadPolicy();

  // Construct IMAP connection pool
  const pool = new ImapConnectionPool({ accounts, logger });

  // Create executor
  const executor = new Executor({ db, accounts, pool, logger });

  // … existing tool registration unchanged …

  logger.info(
    `agent-mail MCP server initialized with ${accounts.length} account(s) and ${ALL_TOOLS.length} tools`
  );

  return { server, pool };
}
```

Add the import at the top:

```ts
import { ImapConnectionPool } from '../provider/imap-pool.js';
```

- [ ] **Step 2: Update `src/cli/serve.ts` to register shutdown hooks**

```ts
import { existsSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from '../server/server.js';
import { ACCOUNTS_YAML_PATH } from '../config.js';

export async function serve(): Promise<void> {
  if (!existsSync(ACCOUNTS_YAML_PATH)) {
    process.stderr.write(
      "agent-mail: no accounts configured. Run 'npx agent-mail add-account' first.\n"
    );
    process.exit(1);
  }

  const { server, pool } = await createMcpServer();
  const transport = new StdioServerTransport();

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

  await server.connect(transport);
}
```

- [ ] **Step 3: Update `src/cli/reviewer.ts`**

Locate the `new Executor({ db, accounts, logger })` line (line 29) and update it:

```ts
import { ImapConnectionPool } from '../provider/imap-pool.js';
// … existing imports …

// Inside the reviewer startup function, before constructing the executor:
  const pool = new ImapConnectionPool({ accounts, logger });
  const executor = new Executor({ db, accounts, pool, logger });

  // Wire pool shutdown:
  const shutdown = async (code = 0) => {
    try {
      await pool.closeAll();
    } catch {
      /* best-effort */
    }
    process.exit(code);
  };
  process.once('SIGINT', () => void shutdown(0));
  process.once('SIGTERM', () => void shutdown(0));
```

- [ ] **Step 4: Run full suite + typecheck**

```bash
npm run typecheck && npm test
```

Expected: all green.

- [ ] **Step 5: Commit Tasks 5 + 6 together**

```bash
git add src/executor/executor.ts src/server/server.ts src/cli/serve.ts src/cli/reviewer.ts test/executor/executor.test.ts
git commit -m "$(cat <<'EOF'
refactor: executor borrows IMAP connections from the pool

The Executor now requires an ImapConnectionPool and uses
pool.withConnection for every IMAP operation instead of opening and
closing a fresh connection per call. serve and reviewer construct the
pool at startup and register SIGINT/SIGTERM handlers that call
closeAll() for a clean shutdown.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Attention signals module

**Files:**
- Create: `src/attention/signals.ts`
- Create: `test/attention/signals.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/attention/signals.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeSignals } from '../../src/attention/signals.js';
import type { EmailMessage, Participant } from '../../src/types.js';

const me = 'you@example.com';
const p = (address: string, name: string | null = null): Participant => ({
  address: address.toLowerCase(),
  name,
});

function makeMessage(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    uid: 1,
    messageId: 'msg-1@test.com',
    from: p('alice@example.com', 'Alice'),
    to: [p(me)],
    cc: [],
    date: '2026-04-12T10:00:00Z',
    subject: 'Test',
    bodyText: '',
    references: [],
    flags: [],
    mailbox: 'INBOX',
    ...overrides,
  };
}

describe('computeSignals — recipient signals', () => {
  it('detects direct-to-me', () => {
    const s = computeSignals(makeMessage(), {
      accountEmail: me,
      threadMessages: [],
    });
    expect(s.direct_to_me).toBe(true);
    expect(s.cc_to_me).toBe(false);
    expect(s.is_bulk).toBe(false);
  });

  it('detects cc-to-me (not direct)', () => {
    const msg = makeMessage({
      to: [p('other@example.com')],
      cc: [p(me)],
    });
    const s = computeSignals(msg, { accountEmail: me, threadMessages: [] });
    expect(s.direct_to_me).toBe(false);
    expect(s.cc_to_me).toBe(true);
  });

  it('detects bulk when not a recipient at all', () => {
    const msg = makeMessage({
      to: [p('list@example.com')],
      cc: [],
    });
    const s = computeSignals(msg, { accountEmail: me, threadMessages: [] });
    expect(s.direct_to_me).toBe(false);
    expect(s.is_bulk).toBe(true);
  });

  it('matches accountEmail case-insensitively', () => {
    const msg = makeMessage({ to: [p('YOU@EXAMPLE.COM')] });
    const s = computeSignals(msg, {
      accountEmail: 'You@Example.com',
      threadMessages: [],
    });
    expect(s.direct_to_me).toBe(true);
  });
});

describe('computeSignals — sender signals', () => {
  it('flags list mail by List-Id presence', () => {
    const msg = makeMessage({ listUnsubscribe: '<https://x/u>' });
    const s = computeSignals(msg, { accountEmail: me, threadMessages: [] });
    expect(s.is_list_mail).toBe(true);
  });

  it('flags automated senders', () => {
    const cases = [
      'noreply@github.com',
      'no-reply@shopify.com',
      'notifications@slack.com',
      'mailer-daemon@google.com',
    ];
    for (const addr of cases) {
      const msg = makeMessage({ from: p(addr) });
      const s = computeSignals(msg, { accountEmail: me, threadMessages: [] });
      expect(s.is_automated).toBe(true);
    }
  });

  it('does not flag normal human senders', () => {
    const msg = makeMessage({ from: p('alice@normalco.com') });
    const s = computeSignals(msg, { accountEmail: me, threadMessages: [] });
    expect(s.is_automated).toBe(false);
  });
});

describe('computeSignals — thread state', () => {
  it('is "new" for a single-message thread', () => {
    const msg = makeMessage();
    const s = computeSignals(msg, {
      accountEmail: me,
      threadMessages: [msg],
    });
    expect(s.thread_state).toBe('new');
  });

  it('is "awaiting_you" when the last message is from someone else to you', () => {
    const earlier = makeMessage({
      messageId: 'msg-1@test.com',
      from: p(me),
      to: [p('alice@example.com')],
      date: '2026-04-12T09:00:00Z',
    });
    const latest = makeMessage({
      messageId: 'msg-2@test.com',
      from: p('alice@example.com'),
      to: [p(me)],
      date: '2026-04-12T10:00:00Z',
      inReplyTo: 'msg-1@test.com',
    });
    const s = computeSignals(latest, {
      accountEmail: me,
      threadMessages: [earlier, latest],
    });
    expect(s.thread_state).toBe('awaiting_you');
  });

  it('is "awaiting_them" when the last message is from you', () => {
    const earlier = makeMessage({
      messageId: 'msg-1@test.com',
      from: p('alice@example.com'),
      to: [p(me)],
      date: '2026-04-12T09:00:00Z',
    });
    const latest = makeMessage({
      messageId: 'msg-2@test.com',
      from: p(me),
      to: [p('alice@example.com')],
      date: '2026-04-12T10:00:00Z',
      inReplyTo: 'msg-1@test.com',
    });
    const s = computeSignals(latest, {
      accountEmail: me,
      threadMessages: [earlier, latest],
    });
    expect(s.thread_state).toBe('awaiting_them');
  });

  it('overrides to "new" when the last message is automated', () => {
    const msg = makeMessage({
      from: p('notifications@github.com'),
      to: [p(me)],
    });
    const s = computeSignals(msg, {
      accountEmail: me,
      threadMessages: [msg],
    });
    expect(s.thread_state).toBe('new');
    expect(s.is_automated).toBe(true);
  });

  it('overrides to "new" when the message is list mail', () => {
    const msg = makeMessage({
      listUnsubscribe: '<https://x/u>',
      from: p('list@example.com'),
    });
    const s = computeSignals(msg, {
      accountEmail: me,
      threadMessages: [msg],
    });
    expect(s.thread_state).toBe('new');
  });
});

describe('computeSignals — reply context', () => {
  it('detects in_reply_to_your_message', () => {
    const yours = makeMessage({
      messageId: 'yours@test.com',
      from: p(me),
      to: [p('alice@example.com')],
    });
    const theirs = makeMessage({
      messageId: 'theirs@test.com',
      from: p('alice@example.com'),
      to: [p(me)],
      inReplyTo: 'yours@test.com',
    });
    const s = computeSignals(theirs, {
      accountEmail: me,
      threadMessages: [yours, theirs],
    });
    expect(s.in_reply_to_your_message).toBe(true);
  });

  it('detects is_reply_in_thread_you_started', () => {
    const yours = makeMessage({
      messageId: 'yours@test.com',
      from: p(me),
    });
    const theirs = makeMessage({
      messageId: 'theirs@test.com',
      from: p('alice@example.com'),
      inReplyTo: 'yours@test.com',
    });
    const s = computeSignals(theirs, {
      accountEmail: me,
      threadMessages: [yours, theirs],
    });
    expect(s.is_reply_in_thread_you_started).toBe(true);
  });
});

describe('computeSignals — network signals', () => {
  it('collects thread participants in first-appearance order', () => {
    const m1 = makeMessage({
      messageId: 'm1',
      from: p('alice@x.com'),
      to: [p('bob@x.com')],
      date: '2026-04-12T09:00:00Z',
    });
    const m2 = makeMessage({
      messageId: 'm2',
      from: p('bob@x.com'),
      to: [p('alice@x.com'), p('carol@x.com')],
      date: '2026-04-12T10:00:00Z',
      inReplyTo: 'm1',
    });
    const s = computeSignals(m2, {
      accountEmail: me,
      threadMessages: [m1, m2],
    });
    const addrs = s.thread_participants.map((x) => x.address);
    expect(addrs).toEqual(['alice@x.com', 'bob@x.com', 'carol@x.com']);
    expect(s.thread_participant_count).toBe(3);
    expect(s.thread_message_count).toBe(2);
  });

  it('marks is_small_group for <= 4 participants', () => {
    const s = computeSignals(makeMessage(), {
      accountEmail: me,
      threadMessages: [makeMessage()],
    });
    expect(s.is_small_group).toBe(true);
  });

  it('marks is_broadcast when the current message has >= 10 recipients', () => {
    const many = Array.from({ length: 11 }, (_, i) => p(`p${i}@x.com`));
    const msg = makeMessage({ to: many });
    const s = computeSignals(msg, { accountEmail: me, threadMessages: [msg] });
    expect(s.is_broadcast).toBe(true);
  });
});

describe('computeSignals — Z-reserved fields', () => {
  it('has null for LLM-derived fields in this MVP', () => {
    const s = computeSignals(makeMessage(), {
      accountEmail: me,
      threadMessages: [],
    });
    expect(s.has_deadline_language).toBeNull();
    expect(s.mentions_you_by_name).toBeNull();
    expect(s.urgency_score).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx vitest run test/attention/signals.test.ts
```

Expected: import error.

- [ ] **Step 3: Implement `src/attention/signals.ts`**

```ts
import type { EmailMessage, Participant } from '../types.js';

export interface MessageSignals {
  // ─── Recipient signals ───
  direct_to_me: boolean;
  cc_to_me: boolean;
  is_bulk: boolean;

  // ─── Sender signals ───
  is_list_mail: boolean;
  is_automated: boolean;

  // ─── Thread signals ───
  thread_state: 'new' | 'awaiting_you' | 'awaiting_them' | 'resolved';
  in_reply_to_your_message: boolean;
  is_reply_in_thread_you_started: boolean;

  // ─── Network signals ───
  thread_participants: Participant[];
  thread_participant_count: number;
  thread_message_count: number;
  is_small_group: boolean;
  is_broadcast: boolean;

  // ─── Reserved for Z (Apfel) — always null in this MVP ───
  has_deadline_language: boolean | null;
  mentions_you_by_name: boolean | null;
  urgency_score: number | null;
}

export interface SignalContext {
  accountEmail: string;
  /** Ordered oldest → newest. May be empty for context-less computation. */
  threadMessages: EmailMessage[];
}

const AUTOMATED_LOCAL_PARTS = [
  /^no-?reply$/i,
  /^noreply[-._]/i,
  /^notifications?$/i,
  /^mailer-daemon$/i,
  /^postmaster$/i,
  /^bounce/i,
  /^auto-?reply/i,
  /^donotreply/i,
];

const SMALL_GROUP_THRESHOLD = 4;
const BROADCAST_THRESHOLD = 10;

export function computeSignals(
  msg: EmailMessage,
  context: SignalContext
): MessageSignals {
  const me = context.accountEmail.toLowerCase();
  const directTo = msg.to.some((p) => p.address === me);
  const ccTo = !directTo && msg.cc.some((p) => p.address === me);
  const isBulk = !directTo && !ccTo;

  const isListMail = Boolean(msg.listUnsubscribe);
  const isAutomated = isAutomatedSender(msg.from.address);

  const threadMsgs = context.threadMessages;
  const threadParticipants = collectParticipants(threadMsgs);
  const threadParticipantCount = threadParticipants.length;
  const threadMessageCount = threadMsgs.length;

  // Thread state
  let threadState: MessageSignals['thread_state'];
  if (threadMsgs.length <= 1) {
    threadState = 'new';
  } else {
    const last = threadMsgs[threadMsgs.length - 1];
    threadState = last.from.address === me ? 'awaiting_them' : 'awaiting_you';
  }
  // Override: notifications / list mail are never "awaiting you"
  if (isListMail || isAutomated) {
    threadState = 'new';
  }

  // Reply context
  const yourIds = new Set(
    threadMsgs
      .filter((m) => m.from.address === me)
      .map((m) => m.messageId)
  );
  const inReplyToYourMessage = Boolean(
    msg.inReplyTo && yourIds.has(msg.inReplyTo)
  );
  const isReplyInThreadYouStarted =
    threadMsgs.length > 0 && threadMsgs[0].from.address === me;

  // Network signals
  const recipientCountOnThisMessage = msg.to.length + msg.cc.length;
  const isSmallGroup = threadParticipantCount > 0
    ? threadParticipantCount <= SMALL_GROUP_THRESHOLD
    : recipientCountOnThisMessage + 1 <= SMALL_GROUP_THRESHOLD; // +1 for sender
  const isBroadcast = recipientCountOnThisMessage >= BROADCAST_THRESHOLD;

  return {
    direct_to_me: directTo,
    cc_to_me: ccTo,
    is_bulk: isBulk,
    is_list_mail: isListMail,
    is_automated: isAutomated,
    thread_state: threadState,
    in_reply_to_your_message: inReplyToYourMessage,
    is_reply_in_thread_you_started: isReplyInThreadYouStarted,
    thread_participants: threadParticipants,
    thread_participant_count: threadParticipantCount,
    thread_message_count: threadMessageCount,
    is_small_group: isSmallGroup,
    is_broadcast: isBroadcast,
    has_deadline_language: null,
    mentions_you_by_name: null,
    urgency_score: null,
  };
}

function isAutomatedSender(address: string): boolean {
  const localPart = address.split('@')[0] ?? '';
  return AUTOMATED_LOCAL_PARTS.some((re) => re.test(localPart));
}

function collectParticipants(messages: EmailMessage[]): Participant[] {
  const seen = new Set<string>();
  const out: Participant[] = [];
  const add = (p: Participant) => {
    if (!p.address || seen.has(p.address)) return;
    seen.add(p.address);
    out.push(p);
  };
  for (const m of messages) {
    add(m.from);
    for (const t of m.to) add(t);
    for (const c of m.cc) add(c);
  }
  return out;
}
```

- [ ] **Step 4: Run attention tests**

```bash
npx vitest run test/attention/signals.test.ts
```

Expected: all pass.

- [ ] **Step 5: Run full suite + typecheck**

```bash
npm run typecheck && npm test
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/attention/signals.ts test/attention/signals.test.ts
git commit -m "$(cat <<'EOF'
feat: add attention signals module for message triage

Pure computeSignals(msg, context) returns a MessageSignals object
with recipient, sender, thread, and network signals derived from
envelope data and thread context. LLM-derived fields
(has_deadline_language, urgency_score, etc.) are reserved as null
for the Z phase's on-device model.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Wire `since` + signals into `search_threads`

**Files:**
- Modify: `src/tools/search-threads.ts` (add `since` to schema)
- Modify: `src/executor/executor.ts` (attach signals to search results)

- [ ] **Step 1: Update the tool schema**

Replace the `inputSchema` in `src/tools/search-threads.ts`:

```ts
import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

export const searchThreadsTool: ToolDefinition = {
  name: 'search_threads',
  description:
    'Search email threads. Returns snippets (subject, sender, date, attention signals) newest-first so you can decide which to read in full. Use `since` (ISO8601) to scope to a time window.',
  inputSchema: z.object({
    query: z.string().optional().describe('Search query text'),
    from: z.string().optional().describe('Filter by sender email/name'),
    to: z.string().optional().describe('Filter by recipient'),
    subject: z.string().optional().describe('Filter by subject'),
    since: z
      .string()
      .optional()
      .describe('ISO8601 datetime — only messages on or after this instant'),
    account_id: z
      .string()
      .optional()
      .describe('Account to search. Omit for default account.'),
    mailbox: z.string().optional().describe('Mailbox to search (default: INBOX)'),
    limit: z.number().optional().describe('Max results (default: 20)'),
  }),
  annotations: { readOnlyHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
```

- [ ] **Step 2: Attach signals in the executor's `search_threads` case**

In `src/executor/executor.ts`, replace the `case 'search_threads'` block. Note that `search()` returns `{ uid, envelope, snippet, flags }` — we need to decorate each result with a `MessageSignals` object computed with an empty thread context (message-level signals only; thread-level work lives in `get_overview`).

```ts
        case 'search_threads': {
          const results = await imap.search(
            (intent.params.mailbox as string) ?? 'INBOX',
            {
              from: intent.params.from as string | undefined,
              to: intent.params.to as string | undefined,
              subject: intent.params.subject as string | undefined,
              body: intent.params.body as string | undefined,
              since: intent.params.since
                ? new Date(intent.params.since as string)
                : undefined,
            },
            (intent.params.limit as number) ?? 20
          );

          // Decorate with message-level signals. Thread-level signals require
          // additional context fetching and are delivered by get_overview.
          const decorated = results.map((r) => {
            const stubMessage: EmailMessage = {
              uid: r.uid,
              messageId: `${r.uid}@${account.email}`,
              from: r.envelope.from,
              to: [],
              cc: [],
              date: r.envelope.date,
              subject: r.envelope.subject,
              bodyText: '',
              references: [],
              flags: r.flags,
              mailbox: (intent.params.mailbox as string) ?? 'INBOX',
            };
            return {
              ...r,
              signals: computeSignals(stubMessage, {
                accountEmail: account.email,
                threadMessages: [],
              }),
            };
          });

          return [{ type: 'text', text: JSON.stringify(decorated, null, 2) }];
        }
```

Add the imports to `src/executor/executor.ts`:

```ts
import type { EmailMessage } from '../types.js';
import { computeSignals } from '../attention/signals.js';
```

**Note:** we use a stub `EmailMessage` here because `ImapProvider.search()` doesn't fetch full envelopes with to/cc. For full triage signals the agent should use `get_overview` or `read_thread`. Message-level `direct_to_me` in particular will be `false` here because to/cc are empty — document this tradeoff in the tool description if needed. (For now it's acceptable; search_threads is a "find me candidates" tool, not a triage tool.)

- [ ] **Step 3: Run executor tests**

```bash
npx vitest run test/executor/executor.test.ts
```

Expected: all pass (the existing `search_threads` test asserts `intent.status` only, not the result content, so it still works).

- [ ] **Step 4: Run full suite + typecheck**

```bash
npm run typecheck && npm test
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/tools/search-threads.ts src/executor/executor.ts
git commit -m "$(cat <<'EOF'
feat: search_threads accepts since and returns attention signals

Adds ISO8601 'since' param for time-windowed searches and decorates
each result with message-level MessageSignals (sender + list + bulk
flags). Thread-level signals require thread context and are delivered
by the new get_overview tool instead.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: `get_overview` tool — skeleton with one category

Start with the simplest end-to-end vertical: one account, one mailbox, `unread` category only, no thread context, no dedup. Then layer on.

**Files:**
- Create: `src/tools/get-overview.ts`
- Create: `test/tools/get-overview.test.ts`
- Modify: `src/server/server.ts` (register tool)
- Modify: `src/server/middleware.ts` — no changes, but verify the tool fits the existing policy-engine path (it's read-only and shouldn't be gated).
- Modify: `src/policy/engine.ts` — add `get_overview` to the default policy as ungated.

- [ ] **Step 1: Check the policy engine default for unknown tools**

```bash
npx vitest run test/policy
```

Read the policy engine to understand how unknown tools are handled:

```bash
```

Open `src/policy/engine.ts` and locate the default policy. `get_overview` needs an entry so it's treated as ungated/read-only.

- [ ] **Step 2: Add `get_overview` to policy defaults**

Modify `src/policy/engine.ts` — locate the default tool policies object and add:

```ts
      get_overview: { risk: 'none', gate: 'ungated' },
```

(Place it alongside `search_threads` and `read_thread`. The exact structure matches the existing entries.)

- [ ] **Step 3: Write the failing test**

Create `test/tools/get-overview.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AccountConfig } from '../../src/types.js';

// Mock pool passes calls through to a per-test configured handler
const poolHandlers: Record<string, (imap: any) => Promise<any>> = {};
const accountImapBehavior: Record<string, any> = {};

vi.mock('../../src/provider/imap-pool.js', () => ({
  ImapConnectionPool: vi.fn().mockImplementation(function () {
    return {
      withConnection: vi.fn(async (accountId: string, fn: any) => {
        const behavior = accountImapBehavior[accountId];
        if (behavior?.throwOn === 'connect') {
          throw new Error(behavior.error ?? 'boom');
        }
        return fn(behavior?.imap ?? {});
      }),
      closeAll: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

import { ImapConnectionPool } from '../../src/provider/imap-pool.js';
import { createLogger } from '../../src/logger.js';
import { runGetOverview } from '../../src/tools/get-overview.js';

const personal: AccountConfig = {
  id: 'personal',
  email: 'you@example.com',
  imap: { host: 'imap.example.com', port: 993, tls: true },
  smtp: { host: 'smtp.example.com', port: 587, tls: true },
};
const work: AccountConfig = {
  id: 'work',
  email: 'you@work.com',
  imap: { host: 'imap.work.com', port: 993, tls: true },
  smtp: { host: 'smtp.work.com', port: 587, tls: true },
};

beforeEach(() => {
  for (const k of Object.keys(accountImapBehavior)) delete accountImapBehavior[k];
});

function fakeImap(config: {
  searchResults?: Record<string, number[]>;
  fetchResults?: Record<number, any>;
}) {
  return {
    searchUids: vi.fn(async (_mailbox: string, criteria: any) => {
      // Return configured UIDs keyed by the search "type" in the criteria
      const key = JSON.stringify(criteria);
      return config.searchResults?.[key] ?? [];
    }),
    fetchEnvelopes: vi.fn(async (_mailbox: string, uids: number[]) => {
      return uids
        .map((u) => config.fetchResults?.[u])
        .filter((m): m is any => m !== undefined);
    }),
    fetchMessage: vi.fn(async (_mailbox: string, uid: number) => {
      return config.fetchResults?.[uid];
    }),
  };
}

describe('runGetOverview', () => {
  it('returns threads for unread messages on a single account', async () => {
    const pool = new ImapConnectionPool({
      accounts: [personal],
      logger: createLogger('cli', { minLevel: 'error' }),
    });
    accountImapBehavior.personal = {
      imap: fakeImap({
        searchResults: {
          // The tool builds a criteria object — exact key doesn't matter for this
          // shape test; we use whatever the implementation actually uses.
        },
      }),
    };
    // Configure the imap more loosely:
    accountImapBehavior.personal.imap.searchUids = vi.fn(
      async (_m: string, criteria: any) => {
        if (criteria.unseen) return [101, 102];
        return [];
      }
    );
    accountImapBehavior.personal.imap.fetchEnvelopes = vi.fn(
      async (_m: string, uids: number[]) =>
        uids.map((uid) => ({
          uid,
          messageId: `<msg-${uid}@example.com>`,
          from: { address: 'alice@example.com', name: 'Alice' },
          to: [{ address: 'you@example.com', name: null }],
          cc: [],
          date: '2026-04-12T10:00:00Z',
          subject: `Subject ${uid}`,
          bodyText: '',
          references: [],
          flags: [],
          mailbox: 'INBOX',
          snippet: `snippet ${uid}`,
          listUnsubscribe: undefined,
        }))
    );

    const result = await runGetOverview({
      pool,
      accounts: [personal],
      input: { include: ['unread'] },
    });

    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].account_id).toBe('personal');
    expect(result.accounts[0].error).toBeNull();
    expect(result.accounts[0].threads).toHaveLength(2);
    expect(result.accounts[0].threads[0].categories).toContain('unread');
    expect(result.accounts[0].threads[0].signals).toBeDefined();
    expect(result.accounts[0].threads[0].latest_message.snippet).toBe('snippet 101');
    expect(result.summary.total_threads).toBe(2);
    expect(result.summary.by_category.unread).toBe(2);
  });

  it('isolates per-account failures', async () => {
    const pool = new ImapConnectionPool({
      accounts: [personal, work],
      logger: createLogger('cli', { minLevel: 'error' }),
    });
    accountImapBehavior.personal = {
      imap: {
        searchUids: vi.fn(async () => []),
        fetchEnvelopes: vi.fn(async () => []),
      },
    };
    accountImapBehavior.work = {
      throwOn: 'connect',
      error: 'work account is down',
    };

    const result = await runGetOverview({
      pool,
      accounts: [personal, work],
      input: { include: ['unread'] },
    });

    expect(result.accounts).toHaveLength(2);
    const workBundle = result.accounts.find((a) => a.account_id === 'work');
    expect(workBundle?.error).toContain('work account is down');
    expect(workBundle?.threads).toEqual([]);
    const personalBundle = result.accounts.find((a) => a.account_id === 'personal');
    expect(personalBundle?.error).toBeNull();
  });

  it('defaults to a 7-day window when since is omitted', async () => {
    const pool = new ImapConnectionPool({
      accounts: [personal],
      logger: createLogger('cli', { minLevel: 'error' }),
    });
    const captured: any[] = [];
    accountImapBehavior.personal = {
      imap: {
        searchUids: vi.fn(async (_m: string, criteria: any) => {
          captured.push(criteria);
          return [];
        }),
        fetchEnvelopes: vi.fn(async () => []),
      },
    };

    const before = Date.now();
    await runGetOverview({
      pool,
      accounts: [personal],
      input: { include: ['unread'] },
    });
    const after = Date.now();

    // The unread search should have been called with a `since` ~7 days ago
    const unreadCriteria = captured.find((c) => c.unseen);
    expect(unreadCriteria).toBeDefined();
    const sinceMs = new Date(unreadCriteria.since).getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(sinceMs).toBeGreaterThanOrEqual(before - sevenDaysMs - 5000);
    expect(sinceMs).toBeLessThanOrEqual(after - sevenDaysMs + 5000);
  });
});
```

- [ ] **Step 4: Run to confirm failure**

```bash
npx vitest run test/tools/get-overview.test.ts
```

Expected: import error on `get-overview.js`.

- [ ] **Step 5: Implement `src/tools/get-overview.ts` (skeleton with unread only)**

```ts
import { z } from 'zod';
import type { ToolDefinition, AccountConfig, Participant, EmailMessage } from '../types.js';
import type { ImapConnectionPool } from '../provider/imap-pool.js';
import { computeSignals, type MessageSignals } from '../attention/signals.js';

const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_LIMIT_PER_CATEGORY = 25;
const SUPPORTED_CATEGORIES = ['unread', 'flagged', 'recent_direct', 'awaiting_you'] as const;
type Category = (typeof SUPPORTED_CATEGORIES)[number];

export const getOverviewTool: ToolDefinition = {
  name: 'get_overview',
  description:
    'Returns a rich, attention-tagged snapshot of recent mail across all configured accounts. Use this when the user asks general questions like "what do I need to be aware of this week" — one call replaces many search_threads calls.',
  inputSchema: z.object({
    accounts: z.array(z.string()).optional().describe('Account IDs to include. Omit for all.'),
    since: z
      .string()
      .optional()
      .describe('ISO8601 datetime. Defaults to 7 days ago.'),
    mailboxes: z
      .array(z.string())
      .optional()
      .describe('Mailboxes to scan per account. Defaults to [INBOX].'),
    include: z
      .array(z.enum(SUPPORTED_CATEGORIES))
      .optional()
      .describe('Which candidate sets to include. Defaults to all four.'),
    limit_per_category: z
      .number()
      .optional()
      .describe('Max threads per category per account. Default 25.'),
  }),
  annotations: { readOnlyHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};

// ─── Types ─────────────────────────────────────────────────────────────

export interface OverviewInput {
  accounts?: string[];
  since?: string;
  mailboxes?: string[];
  include?: Category[];
  limit_per_category?: number;
}

export interface OverviewThread {
  thread_id: string;
  account_id: string;
  mailbox: string;
  categories: Category[];
  latest_message: {
    message_id: string;
    uid: number;
    from: Participant;
    to: Participant[];
    cc: Participant[];
    date: string;
    subject: string;
    snippet: string;
    flags: string[];
  };
  thread: {
    message_count: number;
    first_date: string;
    latest_date: string;
    truncated: boolean;
  };
  signals: MessageSignals;
}

export interface OverviewAccountBundle {
  account_id: string;
  email: string;
  error: string | null;
  threads: OverviewThread[];
}

export interface OverviewResult {
  generated_at: string;
  window: { since: string; until: string };
  accounts: OverviewAccountBundle[];
  summary: {
    total_threads: number;
    by_category: Record<string, number>;
    by_account: Record<string, number>;
  };
}

// ─── Orchestration ────────────────────────────────────────────────────

interface RunDeps {
  pool: ImapConnectionPool;
  accounts: AccountConfig[];
  input: OverviewInput;
}

export async function runGetOverview(deps: RunDeps): Promise<OverviewResult> {
  const now = new Date();
  const since = deps.input.since
    ? new Date(deps.input.since)
    : new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const mailboxes = deps.input.mailboxes ?? ['INBOX'];
  const categories: Category[] = deps.input.include ?? [...SUPPORTED_CATEGORIES];
  const limitPerCategory = deps.input.limit_per_category ?? DEFAULT_LIMIT_PER_CATEGORY;

  const requestedIds = deps.input.accounts ?? deps.accounts.map((a) => a.id);
  const requested = deps.accounts.filter((a) => requestedIds.includes(a.id));

  const settled = await Promise.allSettled(
    requested.map((account) =>
      collectAccountBundle({
        pool: deps.pool,
        account,
        mailboxes,
        categories,
        since,
        limitPerCategory,
      })
    )
  );

  const bundles: OverviewAccountBundle[] = settled.map((r, idx) => {
    const account = requested[idx];
    if (r.status === 'fulfilled') return r.value;
    const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
    return {
      account_id: account.id,
      email: account.email,
      error: msg,
      threads: [],
    };
  });

  // Summary
  const by_category: Record<string, number> = {};
  const by_account: Record<string, number> = {};
  let total = 0;
  for (const b of bundles) {
    by_account[b.account_id] = b.threads.length;
    total += b.threads.length;
    for (const t of b.threads) {
      for (const c of t.categories) {
        by_category[c] = (by_category[c] ?? 0) + 1;
      }
    }
  }

  return {
    generated_at: now.toISOString(),
    window: { since: since.toISOString(), until: now.toISOString() },
    accounts: bundles,
    summary: { total_threads: total, by_category, by_account },
  };
}

interface CollectDeps {
  pool: ImapConnectionPool;
  account: AccountConfig;
  mailboxes: string[];
  categories: Category[];
  since: Date;
  limitPerCategory: number;
}

async function collectAccountBundle(deps: CollectDeps): Promise<OverviewAccountBundle> {
  const threads = await deps.pool.withConnection(deps.account.id, async (imap) => {
    const found: OverviewThread[] = [];

    for (const mailbox of deps.mailboxes) {
      // Per-category: collect UIDs, fetch envelopes, project to OverviewThreads
      if (deps.categories.includes('unread')) {
        const uids = (await (imap as any).searchUids(mailbox, {
          unseen: true,
          since: deps.since,
        })) as number[];
        const newest = uids.slice(-deps.limitPerCategory);
        const messages = (await (imap as any).fetchEnvelopes(
          mailbox,
          newest
        )) as Array<EmailMessage & { snippet?: string }>;
        for (const msg of messages) {
          found.push(toOverviewThread(deps.account, mailbox, msg, ['unread']));
        }
      }
    }

    return found;
  });

  return {
    account_id: deps.account.id,
    email: deps.account.email,
    error: null,
    threads,
  };
}

function toOverviewThread(
  account: AccountConfig,
  mailbox: string,
  msg: EmailMessage & { snippet?: string },
  categories: Category[]
): OverviewThread {
  const signals = computeSignals(msg, {
    accountEmail: account.email,
    threadMessages: [msg],
  });
  return {
    thread_id: hashMessageId(msg.messageId),
    account_id: account.id,
    mailbox,
    categories,
    latest_message: {
      message_id: msg.messageId,
      uid: msg.uid,
      from: msg.from,
      to: msg.to,
      cc: msg.cc,
      date: msg.date,
      subject: msg.subject,
      snippet: msg.snippet ?? '',
      flags: msg.flags,
    },
    thread: {
      message_count: 1,
      first_date: msg.date,
      latest_date: msg.date,
      truncated: false,
    },
    signals,
  };
}

function hashMessageId(id: string): string {
  // Simple deterministic hash — not cryptographic. Stable across runs for a given id.
  let h = 5381;
  for (let i = 0; i < id.length; i++) {
    h = (h * 33) ^ id.charCodeAt(i);
  }
  return `t_${(h >>> 0).toString(16)}`;
}
```

**Note:** the `searchUids` and `fetchEnvelopes` methods referenced here don't yet exist on `ImapProvider`. We add them in Step 6.

- [ ] **Step 6: Add `searchUids` and `fetchEnvelopes` to `ImapProvider`**

Add these methods to `src/provider/imap.ts`:

```ts
  /** Return the full list of UIDs matching a search criterion, ascending. */
  async searchUids(
    mailbox: string,
    criteria: {
      from?: string;
      subject?: string;
      body?: string;
      since?: Date;
      before?: Date;
      flagged?: boolean;
      seen?: boolean;
      unseen?: boolean;
      answered?: boolean;
      unanswered?: boolean;
    }
  ): Promise<number[]> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const query: Record<string, unknown> = {};
      if (criteria.from) query.from = criteria.from;
      if (criteria.subject) query.subject = criteria.subject;
      if (criteria.body) query.body = criteria.body;
      if (criteria.since) query.since = criteria.since;
      if (criteria.before) query.before = criteria.before;
      if (criteria.flagged !== undefined) query.flagged = criteria.flagged;
      if (criteria.seen !== undefined) query.seen = criteria.seen;
      if (criteria.unseen !== undefined) query.unseen = criteria.unseen;
      if (criteria.answered !== undefined) query.answered = criteria.answered;
      if (criteria.unanswered !== undefined) query.unanswered = criteria.unanswered;
      const uids = (await this.client.search(query as any, { uid: true })) ?? [];
      return uids;
    } finally {
      lock.release();
    }
  }

  /** Fetch envelopes + partial source for a specific list of UIDs. Returns EmailMessage objects with a `snippet` field. */
  async fetchEnvelopes(
    mailbox: string,
    uids: number[]
  ): Promise<Array<EmailMessage & { snippet: string }>> {
    if (uids.length === 0) return [];
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const results: Array<EmailMessage & { snippet: string }> = [];
      for await (const msg of this.client.fetch(
        uids.join(','),
        {
          uid: true,
          envelope: true,
          flags: true,
          source: { start: 0, maxLength: 2048 },
        },
        { uid: true }
      )) {
        const source = msg.source?.toString('utf-8') ?? '';
        const inReplyTo = extractHeader(source, 'In-Reply-To');
        const references =
          extractHeader(source, 'References')?.split(/\s+/).filter(Boolean) ?? [];
        const listUnsubscribe = extractHeader(source, 'List-Unsubscribe');

        results.push({
          uid: msg.uid,
          messageId: msg.envelope?.messageId ?? `${msg.uid}@unknown`,
          from: toParticipant(msg.envelope?.from?.[0]),
          to: toParticipants(msg.envelope?.to),
          cc: toParticipants(msg.envelope?.cc),
          date: msg.envelope?.date?.toISOString() ?? new Date().toISOString(),
          subject: msg.envelope?.subject ?? '(no subject)',
          bodyText: '',
          inReplyTo: inReplyTo ?? undefined,
          references,
          flags: Array.from(msg.flags ?? []),
          listUnsubscribe: listUnsubscribe ?? undefined,
          mailbox,
          snippet: extractSnippet(msg.source ?? Buffer.alloc(0)),
        });
      }
      return results;
    } finally {
      lock.release();
    }
  }
```

- [ ] **Step 7: Run the overview tests**

```bash
npx vitest run test/tools/get-overview.test.ts
```

Expected: 3 pass.

- [ ] **Step 8: Run full suite + typecheck**

```bash
npm run typecheck && npm test
```

Expected: all green.

- [ ] **Step 9: Register `get_overview` in the server**

Update `src/server/server.ts`:

```ts
import { getOverviewTool, runGetOverview } from '../tools/get-overview.js';
```

Add `getOverviewTool` to `ALL_TOOLS`:

```ts
const ALL_TOOLS: ToolDefinition[] = [
  searchThreadsTool,
  readThreadTool,
  getOverviewTool,
  // ... rest unchanged
];
```

Add a special-case handler (similar to `get_pending_actions`) that calls `runGetOverview` directly, since it doesn't fit the per-account executor pattern:

Inside the tool registration loop in `src/server/server.ts`, before the `standard tools` block:

```ts
    // get_overview runs directly against the pool (multi-account)
    if (toolDef.name === 'get_overview') {
      server.tool(
        toolDef.name,
        toolDef.description,
        toolDef.inputSchema.shape,
        async (params: Record<string, unknown>) => {
          try {
            const result = await runGetOverview({
              pool,
              accounts,
              input: params as any,
            });
            return {
              content: [
                { type: 'text' as const, text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (error) {
            logger.error('get_overview failed', {
              error: error instanceof Error ? error.message : String(error),
            });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: true,
                    message: error instanceof Error ? error.message : String(error),
                  }),
                },
              ],
            };
          }
        }
      );
      continue;
    }
```

- [ ] **Step 10: Run full suite + typecheck**

```bash
npm run typecheck && npm test
```

Expected: all green.

- [ ] **Step 11: Commit**

```bash
git add src/tools/get-overview.ts src/provider/imap.ts src/server/server.ts src/policy/engine.ts test/tools/get-overview.test.ts
git commit -m "$(cat <<'EOF'
feat: add get_overview tool (skeleton with unread category)

New multi-account fat primitive that returns a rich attention-tagged
snapshot in one call. This commit implements the end-to-end vertical
with the unread category only — flagged, recent_direct, awaiting_you,
dedup, and thread context land in subsequent commits.

Also adds ImapProvider.searchUids and fetchEnvelopes helpers so the
tool can run two-phase (search UIDs, then hydrate) queries cleanly.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: `get_overview` — add all four categories with dedup

**Files:**
- Modify: `src/tools/get-overview.ts`
- Modify: `test/tools/get-overview.test.ts`

- [ ] **Step 1: Add failing tests for the other three categories and dedup**

Append to `test/tools/get-overview.test.ts`:

```ts
describe('runGetOverview — all categories', () => {
  it('returns flagged, recent_direct, awaiting_you', async () => {
    const pool = new ImapConnectionPool({
      accounts: [personal],
      logger: createLogger('cli', { minLevel: 'error' }),
    });

    accountImapBehavior.personal = {
      imap: {
        searchUids: vi.fn(async (_m: string, criteria: any) => {
          if (criteria.unseen) return [101];
          if (criteria.flagged) return [201];
          if (criteria.unanswered) return [301];
          // recent_direct is a plain since query
          if (criteria.since && !criteria.unseen && !criteria.flagged && !criteria.unanswered) {
            return [401];
          }
          return [];
        }),
        fetchEnvelopes: vi.fn(async (_m: string, uids: number[]) =>
          uids.map((uid) => ({
            uid,
            messageId: `<m${uid}@x.com>`,
            from: { address: 'alice@x.com', name: null },
            to: [{ address: 'you@example.com', name: null }],
            cc: [],
            date: '2026-04-12T10:00:00Z',
            subject: `s${uid}`,
            bodyText: '',
            references: [],
            flags: [],
            mailbox: 'INBOX',
            snippet: `snip ${uid}`,
            listUnsubscribe: undefined,
          }))
        ),
      },
    };

    const result = await runGetOverview({
      pool,
      accounts: [personal],
      input: {},
    });

    const threads = result.accounts[0].threads;
    const uids = threads.map((t) => t.latest_message.uid);
    expect(uids).toContain(101);
    expect(uids).toContain(201);
    expect(uids).toContain(301);
    expect(uids).toContain(401);
  });

  it('dedupes threads that appear in multiple categories', async () => {
    const pool = new ImapConnectionPool({
      accounts: [personal],
      logger: createLogger('cli', { minLevel: 'error' }),
    });

    // Same UID 999 appears in both unread and flagged
    accountImapBehavior.personal = {
      imap: {
        searchUids: vi.fn(async (_m: string, criteria: any) => {
          if (criteria.unseen) return [999];
          if (criteria.flagged) return [999];
          return [];
        }),
        fetchEnvelopes: vi.fn(async (_m: string, uids: number[]) =>
          uids.map((uid) => ({
            uid,
            messageId: `<shared@x.com>`,
            from: { address: 'alice@x.com', name: null },
            to: [{ address: 'you@example.com', name: null }],
            cc: [],
            date: '2026-04-12T10:00:00Z',
            subject: 'shared',
            bodyText: '',
            references: [],
            flags: ['\\Flagged'],
            mailbox: 'INBOX',
            snippet: 'shared snippet',
            listUnsubscribe: undefined,
          }))
        ),
      },
    };

    const result = await runGetOverview({
      pool,
      accounts: [personal],
      input: { include: ['unread', 'flagged'] },
    });

    expect(result.accounts[0].threads).toHaveLength(1);
    const categories = result.accounts[0].threads[0].categories;
    expect(categories).toContain('unread');
    expect(categories).toContain('flagged');
  });

  it('filters recent_direct to messages where you are in to', async () => {
    const pool = new ImapConnectionPool({
      accounts: [personal],
      logger: createLogger('cli', { minLevel: 'error' }),
    });

    accountImapBehavior.personal = {
      imap: {
        searchUids: vi.fn(async (_m: string, criteria: any) => {
          if (criteria.since && !criteria.unseen && !criteria.flagged && !criteria.unanswered) {
            return [500, 501];
          }
          return [];
        }),
        fetchEnvelopes: vi.fn(async (_m: string, uids: number[]) =>
          uids.map((uid) => {
            const direct = uid === 500;
            return {
              uid,
              messageId: `<m${uid}@x.com>`,
              from: { address: 'alice@x.com', name: null },
              to: direct
                ? [{ address: 'you@example.com', name: null }]
                : [{ address: 'list@x.com', name: null }],
              cc: [],
              date: '2026-04-12T10:00:00Z',
              subject: `s${uid}`,
              bodyText: '',
              references: [],
              flags: [],
              mailbox: 'INBOX',
              snippet: `snip ${uid}`,
              listUnsubscribe: undefined,
            };
          })
        ),
      },
    };

    const result = await runGetOverview({
      pool,
      accounts: [personal],
      input: { include: ['recent_direct'] },
    });

    const uids = result.accounts[0].threads.map((t) => t.latest_message.uid);
    expect(uids).toContain(500); // direct-to-you
    expect(uids).not.toContain(501); // not direct
  });

  it('filters awaiting_you to threads where state is awaiting_you', async () => {
    const pool = new ImapConnectionPool({
      accounts: [personal],
      logger: createLogger('cli', { minLevel: 'error' }),
    });

    accountImapBehavior.personal = {
      imap: {
        searchUids: vi.fn(async (_m: string, criteria: any) => {
          if (criteria.unanswered) return [700];
          return [];
        }),
        fetchEnvelopes: vi.fn(async (_m: string, uids: number[]) =>
          uids.map((uid) => ({
            uid,
            messageId: `<m${uid}@x.com>`,
            from: { address: 'notifications@github.com', name: null },
            to: [{ address: 'you@example.com', name: null }],
            cc: [],
            date: '2026-04-12T10:00:00Z',
            subject: `s${uid}`,
            bodyText: '',
            references: [],
            flags: [],
            mailbox: 'INBOX',
            snippet: 'pr notification',
            listUnsubscribe: undefined,
          }))
        ),
      },
    };

    const result = await runGetOverview({
      pool,
      accounts: [personal],
      input: { include: ['awaiting_you'] },
    });

    // Automated notifications should NOT be awaiting_you even though UNANSWERED
    expect(result.accounts[0].threads).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx vitest run test/tools/get-overview.test.ts
```

Expected: failures because the current implementation only handles `unread`.

- [ ] **Step 3: Rewrite `collectAccountBundle` to handle all four categories with dedup**

Replace `collectAccountBundle` in `src/tools/get-overview.ts`:

```ts
async function collectAccountBundle(deps: CollectDeps): Promise<OverviewAccountBundle> {
  const threads = await deps.pool.withConnection(deps.account.id, async (imap) => {
    // uid → { message, categories }
    const seen = new Map<
      number,
      { message: EmailMessage & { snippet: string }; categories: Set<Category>; mailbox: string }
    >();

    for (const mailbox of deps.mailboxes) {
      const catUidLists = await gatherCandidateUids(imap, mailbox, deps);

      // Union UIDs for a single fetch call per mailbox
      const allUids = new Set<number>();
      for (const uids of Object.values(catUidLists)) {
        for (const u of uids) allUids.add(u);
      }
      if (allUids.size === 0) continue;

      const envelopes = (await (imap as any).fetchEnvelopes(
        mailbox,
        Array.from(allUids)
      )) as Array<EmailMessage & { snippet: string }>;

      const envelopesByUid = new Map(envelopes.map((e) => [e.uid, e]));

      for (const [cat, uids] of Object.entries(catUidLists) as Array<[Category, number[]]>) {
        for (const uid of uids) {
          const env = envelopesByUid.get(uid);
          if (!env) continue;

          // recent_direct post-filter: must be direct-to-you
          if (cat === 'recent_direct') {
            const me = deps.account.email.toLowerCase();
            const isDirect = env.to.some((p) => p.address === me);
            if (!isDirect) continue;
          }

          // awaiting_you post-filter: thread_state must be awaiting_you
          // (signals computed with empty thread context at this stage —
          // a single-message thread awaiting_you means the latest message is not from you
          // AND the sender isn't automated/list)
          if (cat === 'awaiting_you') {
            const me = deps.account.email.toLowerCase();
            const signals = computeSignals(env, {
              accountEmail: deps.account.email,
              threadMessages: [env],
            });
            // Single-message signal overrides thread_state to 'new' always,
            // so for this category we check directionally:
            if (env.from.address === me) continue;
            if (signals.is_automated || signals.is_list_mail) continue;
          }

          const entry = seen.get(uid);
          if (entry) {
            entry.categories.add(cat);
          } else {
            seen.set(uid, {
              message: env,
              categories: new Set([cat]),
              mailbox,
            });
          }
        }
      }
    }

    const found: OverviewThread[] = [];
    for (const { message, categories, mailbox } of seen.values()) {
      found.push(toOverviewThread(deps.account, mailbox, message, Array.from(categories)));
    }
    // Sort newest-first by latest message date
    found.sort(
      (a, b) =>
        new Date(b.latest_message.date).getTime() -
        new Date(a.latest_message.date).getTime()
    );
    return found;
  });

  return {
    account_id: deps.account.id,
    email: deps.account.email,
    error: null,
    threads,
  };
}

async function gatherCandidateUids(
  imap: any,
  mailbox: string,
  deps: CollectDeps
): Promise<Partial<Record<Category, number[]>>> {
  const out: Partial<Record<Category, number[]>> = {};
  const clip = (xs: number[]) => xs.slice(-deps.limitPerCategory);

  if (deps.categories.includes('unread')) {
    const uids = (await imap.searchUids(mailbox, {
      unseen: true,
      since: deps.since,
    })) as number[];
    out.unread = clip(uids);
  }
  if (deps.categories.includes('flagged')) {
    const uids = (await imap.searchUids(mailbox, { flagged: true })) as number[];
    out.flagged = clip(uids);
  }
  if (deps.categories.includes('recent_direct')) {
    const uids = (await imap.searchUids(mailbox, { since: deps.since })) as number[];
    out.recent_direct = clip(uids);
  }
  if (deps.categories.includes('awaiting_you')) {
    const uids = (await imap.searchUids(mailbox, {
      since: deps.since,
      unanswered: true,
    })) as number[];
    out.awaiting_you = clip(uids);
  }
  return out;
}
```

- [ ] **Step 4: Run overview tests**

```bash
npx vitest run test/tools/get-overview.test.ts
```

Expected: all tests pass (3 original + 4 new = 7).

- [ ] **Step 5: Run full suite + typecheck**

```bash
npm run typecheck && npm test
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/tools/get-overview.ts test/tools/get-overview.test.ts
git commit -m "$(cat <<'EOF'
feat: get_overview now covers all four candidate categories

Adds flagged, recent_direct, and awaiting_you alongside unread.
Each category's UIDs go through a post-filter (direct-to-you or
thread-state check) and are unioned at the mailbox level with a
single fetch call. Threads appearing in multiple categories are
deduped and tagged with all matching categories.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: `get_overview` — thread context for thread-level signals

Thread-level signals (`thread_state: 'awaiting_you'` across multiple messages, `in_reply_to_your_message`, participant aggregation, etc.) need the whole thread, not just the candidate message. This task adds thread context fetching with the 5-message tail truncation.

**Files:**
- Modify: `src/tools/get-overview.ts`
- Modify: `test/tools/get-overview.test.ts`

- [ ] **Step 1: Add failing tests for thread context**

Append to `test/tools/get-overview.test.ts`:

```ts
describe('runGetOverview — thread context', () => {
  it('aggregates thread participants across messages', async () => {
    const pool = new ImapConnectionPool({
      accounts: [personal],
      logger: createLogger('cli', { minLevel: 'error' }),
    });

    // Two messages in one thread; candidate is the latest
    accountImapBehavior.personal = {
      imap: {
        searchUids: vi.fn(async (_m: string, criteria: any) => {
          if (criteria.unseen) return [12];
          return [];
        }),
        fetchEnvelopes: vi.fn(async (_m: string, uids: number[]) =>
          uids.map(() => ({
            uid: 12,
            messageId: '<m2@x.com>',
            from: { address: 'bob@x.com', name: null },
            to: [{ address: 'you@example.com', name: null }],
            cc: [{ address: 'carol@x.com', name: null }],
            date: '2026-04-12T11:00:00Z',
            subject: 'Re: planning',
            bodyText: '',
            inReplyTo: '<m1@x.com>',
            references: ['<m1@x.com>'],
            flags: [],
            mailbox: 'INBOX',
            snippet: 'latest reply',
            listUnsubscribe: undefined,
          }))
        ),
        fetchThreadContext: vi.fn(async (_m: string, _rootIds: string[]) => [
          {
            uid: 11,
            messageId: '<m1@x.com>',
            from: { address: 'alice@x.com', name: null },
            to: [{ address: 'bob@x.com', name: null }],
            cc: [],
            date: '2026-04-12T10:00:00Z',
            subject: 'planning',
            bodyText: '',
            references: [],
            flags: [],
            mailbox: 'INBOX',
            snippet: 'earlier message',
            listUnsubscribe: undefined,
          },
          {
            uid: 12,
            messageId: '<m2@x.com>',
            from: { address: 'bob@x.com', name: null },
            to: [{ address: 'you@example.com', name: null }],
            cc: [{ address: 'carol@x.com', name: null }],
            date: '2026-04-12T11:00:00Z',
            subject: 'Re: planning',
            bodyText: '',
            inReplyTo: '<m1@x.com>',
            references: ['<m1@x.com>'],
            flags: [],
            mailbox: 'INBOX',
            snippet: 'latest reply',
            listUnsubscribe: undefined,
          },
        ]),
      },
    };

    const result = await runGetOverview({
      pool,
      accounts: [personal],
      input: { include: ['unread'] },
    });

    const thread = result.accounts[0].threads[0];
    expect(thread.thread.message_count).toBe(2);
    expect(thread.signals.thread_participant_count).toBeGreaterThanOrEqual(3);
    const addrs = thread.signals.thread_participants.map((p) => p.address);
    expect(addrs).toContain('alice@x.com');
    expect(addrs).toContain('bob@x.com');
    expect(addrs).toContain('carol@x.com');
    expect(addrs).toContain('you@example.com');
    expect(thread.signals.thread_state).toBe('awaiting_you');
  });

  it('marks thread.truncated when thread is longer than the tail window', async () => {
    const pool = new ImapConnectionPool({
      accounts: [personal],
      logger: createLogger('cli', { minLevel: 'error' }),
    });

    // 10-message thread, tail window is 5 → truncated: true
    const buildMsg = (uid: number) => ({
      uid,
      messageId: `<m${uid}@x.com>`,
      from: { address: uid % 2 === 0 ? 'alice@x.com' : 'bob@x.com', name: null },
      to: [{ address: 'you@example.com', name: null }],
      cc: [],
      date: new Date(2026, 3, 12, 10, uid).toISOString(),
      subject: 'long thread',
      bodyText: '',
      references: ['<m1@x.com>'],
      inReplyTo: uid > 1 ? `<m${uid - 1}@x.com>` : undefined,
      flags: [],
      mailbox: 'INBOX',
      snippet: `msg ${uid}`,
      listUnsubscribe: undefined,
    });

    accountImapBehavior.personal = {
      imap: {
        searchUids: vi.fn(async (_m: string, criteria: any) => {
          if (criteria.unseen) return [10];
          return [];
        }),
        fetchEnvelopes: vi.fn(async (_m: string, uids: number[]) =>
          uids.map((u) => buildMsg(u))
        ),
        fetchThreadContext: vi.fn(async () =>
          Array.from({ length: 10 }, (_, i) => buildMsg(i + 1))
        ),
      },
    };

    const result = await runGetOverview({
      pool,
      accounts: [personal],
      input: { include: ['unread'] },
    });

    const thread = result.accounts[0].threads[0];
    expect(thread.thread.message_count).toBe(10);
    expect(thread.thread.truncated).toBe(true);
  });
});
```

- [ ] **Step 2: Add `fetchThreadContext` to `ImapProvider`**

In `src/provider/imap.ts`, add:

```ts
  /**
   * Fetch additional messages from a mailbox whose References/In-Reply-To
   * mention any of the given root Message-Ids. Used to reconstruct thread
   * context for a candidate message.
   *
   * Caps the result at `maxMessages` (default 50) to defend against cycles
   * or huge threads.
   */
  async fetchThreadContext(
    mailbox: string,
    rootMessageIds: string[],
    maxMessages = 50
  ): Promise<Array<EmailMessage & { snippet: string }>> {
    if (rootMessageIds.length === 0) return [];
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      // IMAP HEADER search for References OR In-Reply-To containing any root id
      // imapflow supports { header: { References: 'value' } }
      const results: Array<EmailMessage & { snippet: string }> = [];
      const seenUids = new Set<number>();

      for (const root of rootMessageIds) {
        const orQuery = {
          or: [
            { header: { References: root } },
            { header: { 'In-Reply-To': root } },
            { header: { 'Message-Id': root } },
          ],
        };
        const uids = (await this.client.search(orQuery as any, { uid: true })) ?? [];
        const newUids = uids.filter((u) => !seenUids.has(u));
        for (const u of newUids) seenUids.add(u);
        if (newUids.length === 0) continue;

        // Limit per-root to protect against cycles
        const clipped = newUids.slice(0, maxMessages - results.length);
        if (clipped.length === 0) break;

        for await (const msg of this.client.fetch(
          clipped.join(','),
          {
            uid: true,
            envelope: true,
            flags: true,
            source: { start: 0, maxLength: 2048 },
          },
          { uid: true }
        )) {
          const source = msg.source?.toString('utf-8') ?? '';
          const inReplyTo = extractHeader(source, 'In-Reply-To');
          const references =
            extractHeader(source, 'References')?.split(/\s+/).filter(Boolean) ?? [];

          results.push({
            uid: msg.uid,
            messageId: msg.envelope?.messageId ?? `${msg.uid}@unknown`,
            from: toParticipant(msg.envelope?.from?.[0]),
            to: toParticipants(msg.envelope?.to),
            cc: toParticipants(msg.envelope?.cc),
            date: msg.envelope?.date?.toISOString() ?? new Date().toISOString(),
            subject: msg.envelope?.subject ?? '(no subject)',
            bodyText: '',
            inReplyTo: inReplyTo ?? undefined,
            references,
            flags: Array.from(msg.flags ?? []),
            mailbox,
            snippet: extractSnippet(msg.source ?? Buffer.alloc(0)),
          });
          if (results.length >= maxMessages) break;
        }
        if (results.length >= maxMessages) break;
      }

      // Sort chronologically
      results.sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
      );
      return results;
    } finally {
      lock.release();
    }
  }
```

- [ ] **Step 3: Update `collectAccountBundle` to fetch thread context**

The current `collectAccountBundle` in `src/tools/get-overview.ts` builds OverviewThreads from a single message. Replace the final loop that produces OverviewThreads so it fetches thread context for each candidate and applies the 5-message tail truncation:

```ts
    const found: OverviewThread[] = [];
    for (const { message, categories, mailbox } of seen.values()) {
      // Thread root: first References entry, or inReplyTo, or the message itself
      const rootId =
        message.references[0] ?? message.inReplyTo ?? message.messageId;

      // Fetch up to 50 thread messages from the same mailbox
      let threadMessages: Array<EmailMessage & { snippet?: string }> = [];
      try {
        threadMessages = (await (imap as any).fetchThreadContext(
          mailbox,
          [rootId]
        )) as Array<EmailMessage & { snippet?: string }>;
      } catch {
        threadMessages = [message]; // best-effort
      }

      if (threadMessages.length === 0) {
        threadMessages = [message];
      }

      // Ensure the candidate itself is in the thread list
      if (!threadMessages.some((m) => m.uid === message.uid)) {
        threadMessages.push(message);
        threadMessages.sort(
          (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
        );
      }

      const fullMessageCount = threadMessages.length;
      const TAIL_WINDOW = 5;
      let truncated = false;
      let contextForSignals = threadMessages;
      if (fullMessageCount > TAIL_WINDOW) {
        contextForSignals = threadMessages.slice(-TAIL_WINDOW);
        truncated = true;
      }

      const signals = computeSignals(message, {
        accountEmail: deps.account.email,
        threadMessages: contextForSignals,
      });

      found.push({
        thread_id: hashMessageId(rootId),
        account_id: deps.account.id,
        mailbox,
        categories: Array.from(categories),
        latest_message: {
          message_id: message.messageId,
          uid: message.uid,
          from: message.from,
          to: message.to,
          cc: message.cc,
          date: message.date,
          subject: message.subject,
          snippet: message.snippet ?? '',
          flags: message.flags,
        },
        thread: {
          message_count: fullMessageCount,
          first_date: threadMessages[0].date,
          latest_date: threadMessages[threadMessages.length - 1].date,
          truncated,
        },
        signals,
      });
    }
```

Remove the old `toOverviewThread` helper since it's now inlined (or keep it as a stub — but the cleaner move is to delete it).

- [ ] **Step 4: Run overview tests**

```bash
npx vitest run test/tools/get-overview.test.ts
```

Expected: all pass (9 tests).

- [ ] **Step 5: Run full suite + typecheck**

```bash
npm run typecheck && npm test
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/provider/imap.ts src/tools/get-overview.ts test/tools/get-overview.test.ts
git commit -m "$(cat <<'EOF'
feat: get_overview fetches thread context for thread-level signals

Adds ImapProvider.fetchThreadContext which searches a mailbox for
messages referencing a root Message-Id (capped at 50 to defend against
cycles). get_overview now uses the full thread for each candidate to
compute thread_state, participants, and thread_message_count, and
marks thread.truncated when the thread exceeds the 5-message tail
window used for signal computation.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review checklist

Before declaring the plan complete, verify against the spec:

**Spec coverage:**

| Spec section | Task(s) |
|---|---|
| Fix ordering bug | Task 3 |
| Connection pool | Tasks 4, 5, 6 |
| Readable snippets | Tasks 2, 3 |
| `since` on search_threads | Task 8 |
| `get_overview` tool | Tasks 9, 10, 11 |
| Attention signals module | Task 7 |
| Stable Message-Id in responses | Task 1 (EmailMessage retains messageId); Tasks 9-11 (thread_id hash) |
| Participant type | Task 1 |
| Per-account error isolation | Task 9 (allSettled) |
| Thread tail truncation | Task 11 |
| `get_overview` registered in server | Task 9 |
| Shutdown hook for pool | Task 6 |
| Policy engine default for `get_overview` | Task 9 |

**Placeholder scan:** no "TODO" / "implement later" / "add error handling" patterns. All code blocks are complete.

**Type consistency:**
- `MessageSignals` defined once in Task 7, referenced in Tasks 8, 9, 10, 11.
- `Participant` defined in Task 1, used everywhere.
- `ImapConnectionPool.withConnection(accountId, fn)` signature used identically in Tasks 4, 5, 9, 10, 11.
- `OverviewThread`, `OverviewAccountBundle`, `OverviewResult` defined in Task 9, extended/used in Tasks 10, 11.
- `searchUids`, `fetchEnvelopes` on `ImapProvider` introduced in Task 9 and used in Tasks 10, 11.
- `fetchThreadContext` on `ImapProvider` introduced in Task 11.

---

## Known limitations (carried from the spec)

1. Cross-mailbox thread reconstruction not supported (Sent-folder replies may cause wrong `thread_state`).
2. Plus-addressing / aliases — primary email only.
3. HTML-only message bodies return empty snippets and empty body text.
4. Sender familiarity signal not computed (deferred to Z).
5. Cross-thread participant graph not computed (deferred to Z).
6. LLM-derived signals (deadline, urgency, named mentions) return null (deferred to Z with Apfel).
