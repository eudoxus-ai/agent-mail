import type { Database } from '../ledger/sqlite.js';
import type { Logger } from '../logger.js';
import { updateFlags, deleteMessages, withTransaction } from './store.js';
import { getMailboxState, upsertMailboxState } from './state.js';

/**
 * Post-mutation cache maintenance (design D2).
 *
 * The cache is never authoritative for a write. Every mutation has already
 * happened on the server by the time these run; this only keeps the local
 * mirror from showing something the agent just changed. Two parts:
 *
 *   1. An optimistic echo of the known delta, so an agent that holds 20
 *      messages and immediately searches doesn't see them still in INBOX.
 *   2. A priority-resync mark, so the next sync tick reconciles that mailbox
 *      first. The echo is overwritten by whatever the server actually says.
 *
 * Nothing here can fail a mail operation: every entry point swallows errors.
 * A wrong cache is a stale search result; a thrown error here would turn a
 * successful hold into a reported failure.
 */

export type InvalidationEffect = 'moved' | 'flags_changed' | 'deleted' | 'appended';

export interface InvalidationInput {
  accountId: string;
  mailbox: string;
  uids: number[];
  effect: InvalidationEffect;
  detail?: {
    toMailbox?: string;
    flagsAdded?: string[];
    flagsRemoved?: string[];
  };
}

export function invalidate(
  db: Database,
  input: InvalidationInput,
  logger?: Logger
): void {
  try {
    const state = getMailboxState(db, input.accountId, input.mailbox);
    // Nothing cached for this mailbox yet — the eventual backfill will pick it
    // up. Marking it dirty would be meaningless.
    if (!state?.uidvalidity) return;

    const uidvalidity = state.uidvalidity;

    withTransaction(db, () => {
      switch (input.effect) {
        case 'moved':
        case 'deleted':
          // A move out of this mailbox looks identical to a delete from this
          // mailbox's perspective. The destination copy arrives with a new UID
          // on the next sync of that mailbox — inventing one here would be
          // guessing at a value only the server can assign.
          deleteMessages(db, {
            accountId: input.accountId,
            mailbox: input.mailbox,
            uidvalidity,
            uids: input.uids,
          });
          break;

        case 'flags_changed':
          applyFlagEcho(db, input, uidvalidity);
          break;

        case 'appended':
          // Nothing to echo: the new message has a server-assigned UID we
          // don't know. Marking the mailbox dirty is the whole action.
          break;
      }
    });

    markDirty(db, input.accountId, input.mailbox);

    if (input.detail?.toMailbox) {
      markDirty(db, input.accountId, input.detail.toMailbox);
    }
  } catch (error) {
    logger?.warn('cache: invalidation failed (mail operation unaffected)', {
      account_id: input.accountId,
      mailbox: input.mailbox,
      effect: input.effect,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function applyFlagEcho(
  db: Database,
  input: InvalidationInput,
  uidvalidity: number
): void {
  const added = input.detail?.flagsAdded ?? [];
  const removed = input.detail?.flagsRemoved ?? [];
  if (added.length === 0 && removed.length === 0) return;

  for (const uid of input.uids) {
    const row = db
      .prepare(
        `SELECT flags FROM messages
         WHERE account_id = ? AND mailbox = ? AND uidvalidity = ? AND uid = ?`
      )
      .get(input.accountId, input.mailbox, uidvalidity, uid) as
      | { flags: string }
      | undefined;
    if (!row) continue;

    let flags: string[];
    try {
      flags = JSON.parse(row.flags) as string[];
    } catch {
      flags = [];
    }

    const lowerRemoved = new Set(removed.map((f) => f.toLowerCase()));
    const next = flags.filter((f) => !lowerRemoved.has(f.toLowerCase()));
    for (const flag of added) {
      if (!next.some((f) => f.toLowerCase() === flag.toLowerCase())) {
        next.push(flag);
      }
    }

    updateFlags(db, {
      accountId: input.accountId,
      mailbox: input.mailbox,
      uidvalidity,
      uid,
      flags: next,
    });
  }
}

/**
 * Mark a mailbox for priority resync by clearing its last_delta_at. The sync
 * loop treats a null timestamp as "sync this first".
 */
export function markDirty(db: Database, accountId: string, mailbox: string): void {
  upsertMailboxState(db, accountId, mailbox, { last_delta_at: null });
}

/** Mailboxes awaiting a priority resync, most-urgent-first. */
export function dirtyMailboxes(
  db: Database,
  accountId: string
): string[] {
  return (
    db
      .prepare(
        `SELECT mailbox FROM mailbox_state
         WHERE account_id = ? AND last_delta_at IS NULL
         ORDER BY mailbox`
      )
      .all(accountId) as Array<{ mailbox: string }>
  ).map((r) => r.mailbox);
}
