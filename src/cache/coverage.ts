import type { Database } from '../ledger/sqlite.js';

/**
 * What the cache actually has, so responses can say so.
 *
 * The dangerous failure mode for a mail cache isn't being slow, it's being
 * silently incomplete — returning three results when the server would have
 * returned five, with nothing to indicate the difference. Every cache-backed
 * response carries this so the agent can tell "no results" from "no results in
 * the two years I have locally".
 */

export type CacheState = 'fresh' | 'stale' | 'backfilling' | 'unavailable';

export interface MailboxCoverage {
  complete: boolean;
  oldest: string | null;
  messages: number;
}

export interface CacheCoverage {
  state: CacheState;
  last_synced_at: string | null;
  coverage: Record<string, Record<string, MailboxCoverage>>;
}

interface CoverageRow {
  account_id: string;
  mailbox: string;
  backfill_complete: number;
  oldest_date: number | null;
  last_delta_at: number | null;
}

export function getCoverage(
  db: Database,
  accountIds: string[],
  options: { freshnessWindowSeconds: number; now?: number; mailbox?: string }
): CacheCoverage {
  const now = options.now ?? Date.now();

  if (accountIds.length === 0) {
    return { state: 'unavailable', last_synced_at: null, coverage: {} };
  }

  const placeholders = accountIds.map(() => '?').join(', ');
  // Scoped to the mailbox actually being searched. Without this, state for any
  // synced mailbox made an unsynced one (Drafts, say) look servable, and the
  // cache would answer with an empty result while suppressing the IMAP
  // fallback — silently missing mail, which is the failure this whole design
  // exists to avoid.
  const mailboxClause = options.mailbox ? ' AND s.mailbox = ?' : '';
  const args = options.mailbox ? [...accountIds, options.mailbox] : accountIds;

  const rows = db
    .prepare(
      `SELECT s.account_id, s.mailbox, s.backfill_complete, s.oldest_date, s.last_delta_at,
              (SELECT COUNT(*) FROM messages m
               WHERE m.account_id = s.account_id AND m.mailbox = s.mailbox) AS messages
       FROM mailbox_state s
       WHERE s.account_id IN (${placeholders})${mailboxClause}`
    )
    .all(...args) as unknown as Array<CoverageRow & { messages: number }>;

  if (rows.length === 0) {
    return { state: 'unavailable', last_synced_at: null, coverage: {} };
  }

  // Every requested account must have state for that scope. A multi-account
  // search where only one account has synced would otherwise report `fresh`
  // and quietly return that account's results alone.
  const covered = new Set(rows.map((r) => r.account_id));
  if (accountIds.some((id) => !covered.has(id))) {
    return { state: 'unavailable', last_synced_at: null, coverage: {} };
  }

  const coverage: Record<string, Record<string, MailboxCoverage>> = {};
  let newestDelta: number | null = null;
  let anyIncomplete = false;

  for (const row of rows) {
    coverage[row.account_id] ??= {};
    coverage[row.account_id][row.mailbox] = {
      complete: row.backfill_complete === 1,
      oldest: row.oldest_date ? new Date(row.oldest_date).toISOString() : null,
      messages: row.messages,
    };

    if (row.backfill_complete !== 1) anyIncomplete = true;
    if (row.last_delta_at != null) {
      newestDelta = newestDelta === null ? row.last_delta_at : Math.max(newestDelta, row.last_delta_at);
    }
  }

  // Staleness is judged on the OLDEST successful sync, not the newest: if one
  // account synced a second ago and another hasn't in a day, the answer as a
  // whole is a day stale. Taking the max would hide the lagging account.
  const oldestDelta = rows.reduce<number | null>((acc, row) => {
    if (row.last_delta_at == null) return acc;
    return acc === null ? row.last_delta_at : Math.min(acc, row.last_delta_at);
  }, null);

  let state: CacheState;
  // A state row with no successful sync yet is not servable: the mailbox is
  // known but nothing has been read from it.
  if (oldestDelta === null || rows.some((r) => r.last_delta_at == null)) {
    state = 'unavailable';
  } else if (now - oldestDelta > options.freshnessWindowSeconds * 1000) {
    // The daemon is probably not running.
    state = 'stale';
  } else if (anyIncomplete) {
    state = 'backfilling';
  } else {
    state = 'fresh';
  }

  return {
    state,
    last_synced_at: newestDelta === null ? null : new Date(newestDelta).toISOString(),
    coverage,
  };
}

/**
 * Whether the cache should serve a read at all.
 *
 * `backfilling` counts as usable: backfill is newest-first, so recent mail is
 * already there, and the coverage block tells the caller where the floor is.
 */
export function isServable(state: CacheState): boolean {
  return state === 'fresh' || state === 'backfilling';
}
