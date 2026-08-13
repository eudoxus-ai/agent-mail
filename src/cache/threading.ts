import type { Database } from '../ledger/sqlite.js';

/**
 * Persistent threading.
 *
 * provider/threading.ts unions only the messages one search returned, which is
 * why a reply sitting in Sent never joins its thread (documented limitation #1
 * in the April design). Here the union-find lives in SQLite and spans every
 * message ever ingested, across mailboxes and sync runs.
 *
 * thread_links is kept fully path-compressed: every message_id points directly
 * at its root, so resolving a thread is a single indexed SELECT. Merges pay for
 * that by rewriting the losing side, which is bounded by idx_thread_root.
 */

export interface LinkInput {
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
}

export interface LinkResult {
  /** The canonical root for this message's thread. */
  root: string;
  /** Roots that were absorbed into `root` by this call, if any. */
  merged: string[];
}

/**
 * Pick the canonical root among candidates.
 *
 * Lexicographically smallest, deliberately: it makes the outcome independent of
 * the order messages arrive in. Re-syncing a mailbox, or backfilling older mail
 * after newer mail, converges on the same root either way — which is what makes
 * ingest idempotent.
 */
function canonicalRoot(candidates: string[]): string {
  return candidates.reduce((a, b) => (a <= b ? a : b));
}

function normalizeIds(input: LinkInput): string[] {
  const ids = [input.messageId, input.inReplyTo ?? '', ...(input.references ?? [])]
    .map((id) => (id ?? '').trim())
    .filter(Boolean);
  return [...new Set(ids)];
}

/**
 * Link a message into the thread graph, merging any threads its references
 * connect. Returns the canonical root and any roots absorbed by the merge.
 *
 * Caller is responsible for the surrounding transaction.
 */
export function linkMessage(db: Database, input: LinkInput): LinkResult {
  const ids = normalizeIds(input);
  if (ids.length === 0) {
    return { root: input.messageId, merged: [] };
  }

  const placeholders = ids.map(() => '?').join(', ');
  const existing = db
    .prepare(
      `SELECT DISTINCT root_id FROM thread_links WHERE message_id IN (${placeholders})`
    )
    .all(...ids) as Array<{ root_id: string }>;

  const knownRoots = existing.map((r) => r.root_id);
  // With no prior knowledge the message's own id seeds the thread. References
  // are included as candidates so a reply that arrives before its parent still
  // lands on the same root the parent will later resolve to.
  const root = canonicalRoot(knownRoots.length > 0 ? [...knownRoots, ...ids] : ids);

  const merged = knownRoots.filter((r) => r !== root);
  if (merged.length > 0) {
    const mergedPlaceholders = merged.map(() => '?').join(', ');
    db.prepare(
      `UPDATE thread_links SET root_id = ? WHERE root_id IN (${mergedPlaceholders})`
    ).run(root, ...merged);
  }

  const insert = db.prepare(
    `INSERT INTO thread_links (message_id, root_id) VALUES (?, ?)
     ON CONFLICT(message_id) DO UPDATE SET root_id = excluded.root_id`
  );
  for (const id of ids) {
    insert.run(id, root);
  }

  return { root, merged };
}

/** Resolve a message id to its thread root. Returns the id itself if unknown. */
export function resolveRoot(db: Database, messageId: string): string {
  const row = db
    .prepare(`SELECT root_id FROM thread_links WHERE message_id = ?`)
    .get(messageId) as { root_id: string } | undefined;
  return row?.root_id ?? messageId;
}

/**
 * Propagate a merge into the denormalized messages.thread_id column.
 * Separate from linkMessage so threading stays testable without the messages
 * table, and so a caller ingesting in bulk can batch the rewrite.
 */
export function applyMerge(db: Database, root: string, merged: string[]): void {
  if (merged.length === 0) return;
  const placeholders = merged.map(() => '?').join(', ');
  db.prepare(
    `UPDATE messages SET thread_id = ? WHERE thread_id IN (${placeholders})`
  ).run(root, ...merged);
}

/**
 * Thread id for a message that has no usable Message-Id. Such a message can't
 * participate in the reference graph at all, so it gets a synthetic identity
 * that keeps it in a thread of its own instead of colliding with every other
 * header-less message.
 */
export function syntheticThreadId(
  accountId: string,
  mailbox: string,
  uid: number
): string {
  return `nomsgid:${accountId}:${mailbox}:${uid}`;
}
