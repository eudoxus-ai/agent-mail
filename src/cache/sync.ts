import type { Database } from '../ledger/sqlite.js';
import type { Logger } from '../logger.js';
import type { SyncProvider, MailboxDescriptor, SyncEnvelope } from './ports.js';
import { upsertMessage, attachBody, deleteMessages, withTransaction } from './store.js';
import {
  getMailboxState,
  upsertMailboxState,
  purgeMailbox,
  cachedUids,
  pendingBodyUids,
} from './state.js';

/**
 * The sync engine. Owns (uidvalidity, highestmodseq) bookkeeping and drives a
 * SyncProvider; knows nothing about tools, and never writes to IMAP.
 *
 * Runs in the daemon, which is the single writer. See "Process model" in
 * docs/superpowers/specs/2026-07-31-local-message-cache-design.md.
 */

export const HOLDING_MAILBOX = 'agent-mail-holding';

/**
 * Default synced set (design D3). Gmail's All Mail (\All) is deliberately
 * absent: it holds a near-copy of every message, so including it roughly
 * doubles cache size and backfill time while adding almost nothing reachable.
 */
export const DEFAULT_MAILBOX_SELECTORS = [
  'INBOX',
  '\\Sent',
  '\\Archive',
  HOLDING_MAILBOX,
];

/** Design D4. null means unbounded. */
export const DEFAULT_BACKFILL_DAYS = 730;

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_BODY_BATCH_SIZE = 50;
/**
 * How many recent messages the no-CONDSTORE fallback re-reads per run to catch
 * flag changes. Bounded because that path has no "what changed" primitive and
 * would otherwise refetch the entire mailbox every tick.
 */
const FALLBACK_FLAG_WINDOW = 500;

export type SyncMode = 'backfill' | 'delta' | 'fallback' | 'error';

export interface MailboxSyncResult {
  mailbox: string;
  mode: SyncMode;
  ingested: number;
  vanished: number;
  bodiesFetched: number;
  backfillComplete: boolean;
  purged: boolean;
  error?: string;
}

export interface SyncOptions {
  accountId: string;
  provider: SyncProvider;
  /** Selectors: a literal path, or a special-use flag like '\\Sent'. */
  mailboxes?: string[];
  backfillDays?: number | null;
  batchSize?: number;
  bodyBatchSize?: number;
  /** Cap batches per run so one call can't monopolize the daemon. */
  maxBatches?: number;
  logger?: Logger;
  now?: () => number;
}

/**
 * Map selectors onto real mailbox paths.
 *
 * Special-use flags rather than names, because providers disagree: Gmail's Sent
 * is '[Gmail]/Sent Mail', iCloud's is 'Sent Messages'. Both advertise '\Sent'.
 * A selector that matches nothing is skipped — plenty of accounts have no
 * Archive, and that isn't an error.
 */
export function resolveMailboxes(
  descriptors: MailboxDescriptor[],
  selectors: string[] = DEFAULT_MAILBOX_SELECTORS
): string[] {
  const resolved: string[] = [];

  for (const selector of selectors) {
    if (selector.startsWith('\\')) {
      const match = descriptors.find(
        (d) => d.specialUse?.toLowerCase() === selector.toLowerCase()
      );
      if (match) resolved.push(match.path);
      continue;
    }

    const match = descriptors.find(
      (d) => d.path.toLowerCase() === selector.toLowerCase()
    );
    if (match) resolved.push(match.path);
  }

  return [...new Set(resolved)];
}

function backfillSince(
  backfillDays: number | null | undefined,
  now: number
): Date | undefined {
  const days = backfillDays === undefined ? DEFAULT_BACKFILL_DAYS : backfillDays;
  if (days === null) return undefined;
  return new Date(now - days * 24 * 60 * 60 * 1000);
}

function ingestEnvelopes(
  db: Database,
  accountId: string,
  uidvalidity: number,
  envelopes: SyncEnvelope[]
): void {
  if (envelopes.length === 0) return;
  withTransaction(db, () => {
    for (const env of envelopes) {
      upsertMessage(db, {
        accountId,
        message: env.message,
        uidvalidity,
        modseq: env.modseq,
        internalDate: env.internalDate,
        size: env.size,
        listId: env.listId,
        attachments: env.attachments,
        snippet: env.snippet,
      });
    }
  });
}

function refreshOldestDate(
  db: Database,
  accountId: string,
  mailbox: string
): void {
  const row = db
    .prepare(
      `SELECT MIN(date) AS oldest FROM messages
       WHERE account_id = ? AND mailbox = ? AND date > 0`
    )
    .get(accountId, mailbox) as { oldest: number | null };
  upsertMailboxState(db, accountId, mailbox, { oldest_date: row.oldest ?? null });
}

/** Sync every resolved mailbox for one account, isolating per-mailbox failures. */
export async function syncAccount(
  db: Database,
  options: SyncOptions
): Promise<MailboxSyncResult[]> {
  const descriptors = await options.provider.listMailboxes();
  const mailboxes = resolveMailboxes(descriptors, options.mailboxes);

  const results: MailboxSyncResult[] = [];
  for (const mailbox of mailboxes) {
    results.push(await syncMailbox(db, options, mailbox));
  }
  return results;
}

export async function syncMailbox(
  db: Database,
  options: SyncOptions,
  mailbox: string
): Promise<MailboxSyncResult> {
  const { accountId, provider } = options;
  const now = options.now ?? Date.now;

  const result: MailboxSyncResult = {
    mailbox,
    mode: 'backfill',
    ingested: 0,
    vanished: 0,
    bodiesFetched: 0,
    backfillComplete: false,
    purged: false,
  };

  try {
    const snapshot = await provider.snapshot(mailbox);
    let state = getMailboxState(db, accountId, mailbox);

    // UIDVALIDITY is the server telling us our UIDs no longer mean what they
    // meant. Everything cached for this mailbox is suspect, so drop it rather
    // than risk acting on a UID that now points at a different message.
    if (state?.uidvalidity != null && state.uidvalidity !== snapshot.uidValidity) {
      options.logger?.warn('cache: uidvalidity changed, purging mailbox', {
        account_id: accountId,
        mailbox,
        was: state.uidvalidity,
        now: snapshot.uidValidity,
      });
      purgeMailbox(db, accountId, mailbox);
      result.purged = true;
      state = getMailboxState(db, accountId, mailbox);
    }

    upsertMailboxState(db, accountId, mailbox, {
      uidvalidity: snapshot.uidValidity,
      uidnext: snapshot.uidNext,
      last_error: null,
    });

    const backfillDone = state?.backfill_complete === 1 && !result.purged;

    if (!backfillDone) {
      result.mode = 'backfill';
      Object.assign(result, await runBackfill(db, options, mailbox, snapshot.uidValidity, snapshot.highestModseq));
    } else if (state?.highestmodseq != null) {
      const delta = await runDelta(db, options, mailbox, state.uidvalidity!, state.highestmodseq);
      Object.assign(result, delta);
    } else {
      result.mode = 'fallback';
      Object.assign(result, await runFallback(db, options, mailbox, snapshot.uidValidity, state?.uidnext ?? 0));
    }

    result.bodiesFetched = await drainBodies(db, options, mailbox, snapshot.uidValidity);

    refreshOldestDate(db, accountId, mailbox);
    upsertMailboxState(db, accountId, mailbox, { last_delta_at: now() });

    const finalState = getMailboxState(db, accountId, mailbox);
    result.backfillComplete = finalState?.backfill_complete === 1;

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.logger?.error('cache: mailbox sync failed', {
      account_id: accountId,
      mailbox,
      error: message,
    });
    upsertMailboxState(db, accountId, mailbox, { last_error: message });
    return { ...result, mode: 'error', error: message };
  }
}

/**
 * Newest-first, resumable backfill.
 *
 * Newest-first matters: the cache is useful for recent mail within seconds and
 * stays useful while the long tail fills in. backfill_cursor is the lowest UID
 * ingested so far, so an interrupted run resumes at the next batch down rather
 * than starting over.
 */
async function runBackfill(
  db: Database,
  options: SyncOptions,
  mailbox: string,
  uidvalidity: number,
  highestModseq: number | null
): Promise<Partial<MailboxSyncResult>> {
  const { accountId, provider } = options;
  const now = options.now ?? Date.now;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;

  const state = getMailboxState(db, accountId, mailbox);

  // Capture HIGHESTMODSEQ at the START of backfill, not the end. Anything that
  // changes while we're backfilling then shows up in the first delta, instead
  // of falling into the gap between "backfill finished" and "delta started".
  if (state?.highestmodseq == null && highestModseq != null) {
    upsertMailboxState(db, accountId, mailbox, { highestmodseq: highestModseq });
  }

  const uids = await provider.listUids(mailbox, {
    since: backfillSince(options.backfillDays, now()),
  });

  let cursor = state?.backfill_cursor ?? null;
  let ingested = 0;
  let batches = 0;

  for (;;) {
    const floor = cursor;
    const remaining = floor === null ? uids : uids.filter((u) => u < floor);
    if (remaining.length === 0) {
      upsertMailboxState(db, accountId, mailbox, { backfill_complete: 1 });
      return { ingested, backfillComplete: true };
    }

    if (batches >= maxBatches) {
      return { ingested, backfillComplete: false };
    }

    const batch = remaining.slice(-batchSize);
    const envelopes = await provider.fetchEnvelopes(mailbox, batch);
    ingestEnvelopes(db, accountId, uidvalidity, envelopes);
    ingested += envelopes.length;

    cursor = Math.min(...batch);
    upsertMailboxState(db, accountId, mailbox, { backfill_cursor: cursor });
    batches += 1;
  }
}

/** CONDSTORE/QRESYNC delta — one round trip for "what changed". */
async function runDelta(
  db: Database,
  options: SyncOptions,
  mailbox: string,
  uidvalidity: number,
  highestModseq: number
): Promise<Partial<MailboxSyncResult>> {
  const { accountId, provider } = options;

  const delta = await provider.delta(mailbox, { uidValidity: uidvalidity, highestModseq });

  if (delta === null) {
    // Server withdrew CONDSTORE support (or never had it and state was stale).
    const state = getMailboxState(db, accountId, mailbox);
    return {
      mode: 'fallback',
      ...(await runFallback(db, options, mailbox, uidvalidity, state?.uidnext ?? 0)),
    };
  }

  if (delta.uidValidity !== uidvalidity) {
    // Raced a UIDVALIDITY change between snapshot and delta. Purge and let the
    // next run backfill from scratch rather than merge two generations.
    purgeMailbox(db, accountId, mailbox);
    return { mode: 'backfill', purged: true, ingested: 0, vanished: 0 };
  }

  // On a CONDSTORE-only server, expunges arrive as sequence numbers and
  // `vanished` is unusable. Fall back to diffing cached UIDs against the
  // server's list — one extra UID SEARCH, and the only way deletions
  // propagate at all on those servers.
  const goneUids =
    delta.vanishedReliable === false
      ? await reconcileDeletions(db, options, mailbox, uidvalidity)
      : delta.vanished;

  let vanished = 0;
  if (goneUids.length > 0) {
    withTransaction(db, () => {
      vanished = deleteMessages(db, {
        accountId,
        mailbox,
        uidvalidity,
        uids: goneUids,
      });
    });
  }

  ingestEnvelopes(db, accountId, uidvalidity, delta.changed);

  if (delta.highestModseq != null) {
    upsertMailboxState(db, accountId, mailbox, { highestmodseq: delta.highestModseq });
  }

  return { mode: 'delta', ingested: delta.changed.length, vanished };
}

/**
 * Which cached UIDs the server no longer lists.
 *
 * Used when a delta response can't be trusted to report deletions. Costs one
 * UID SEARCH, which is cheap — the server returns bare numbers, no envelopes.
 */
async function reconcileDeletions(
  db: Database,
  options: SyncOptions,
  mailbox: string,
  uidvalidity: number
): Promise<number[]> {
  const now = options.now ?? Date.now;
  const serverUids = new Set(
    await options.provider.listUids(mailbox, {
      since: backfillSince(options.backfillDays, now()),
    })
  );
  return cachedUids(db, options.accountId, mailbox, uidvalidity).filter(
    (uid) => !serverUids.has(uid)
  );
}

/**
 * No-CONDSTORE fallback.
 *
 * Without a "what changed since" primitive there are only two cheap questions:
 * which UIDs are new (above the stored UIDNEXT) and which cached UIDs the
 * server no longer lists. Flag changes have no cheap answer at all, so we
 * re-read a bounded window of recent messages and accept that a flag change on
 * old mail can lag. Correct but coarse, and only reachable on servers that
 * don't implement a 2011 RFC.
 */
async function runFallback(
  db: Database,
  options: SyncOptions,
  mailbox: string,
  uidvalidity: number,
  knownUidNext: number
): Promise<Partial<MailboxSyncResult>> {
  const { accountId, provider } = options;
  const now = options.now ?? Date.now;

  const serverUids = await provider.listUids(mailbox, {
    since: backfillSince(options.backfillDays, now()),
  });
  const serverSet = new Set(serverUids);

  const arrivals = serverUids.filter((u) => u >= knownUidNext);

  const cached = cachedUids(db, accountId, mailbox, uidvalidity);
  const gone = cached.filter((u) => !serverSet.has(u));

  let vanished = 0;
  if (gone.length > 0) {
    withTransaction(db, () => {
      vanished = deleteMessages(db, { accountId, mailbox, uidvalidity, uids: gone });
    });
  }

  const recent = serverUids.slice(-FALLBACK_FLAG_WINDOW);
  const toFetch = [...new Set([...arrivals, ...recent])].sort((a, b) => a - b);

  const envelopes = await provider.fetchEnvelopes(mailbox, toFetch);
  ingestEnvelopes(db, accountId, uidvalidity, envelopes);

  return { mode: 'fallback', ingested: envelopes.length, vanished };
}

/**
 * Fetch bodies for messages whose envelopes have already landed.
 *
 * Kept separate from envelope ingest so envelopes — the part that makes the
 * cache useful — aren't held up behind multi-megabyte body downloads.
 */
async function drainBodies(
  db: Database,
  options: SyncOptions,
  mailbox: string,
  uidvalidity: number
): Promise<number> {
  const { accountId, provider } = options;
  const limit = options.bodyBatchSize ?? DEFAULT_BODY_BATCH_SIZE;

  const uids = pendingBodyUids(db, accountId, mailbox, limit);
  if (uids.length === 0) return 0;

  const bodies = await provider.fetchBodies(mailbox, uids);
  const byUid = new Map(bodies.map((b) => [b.uid, b]));

  let fetched = 0;
  withTransaction(db, () => {
    for (const uid of uids) {
      const row = db
        .prepare(
          `SELECT id FROM messages
           WHERE account_id = ? AND mailbox = ? AND uidvalidity = ? AND uid = ?`
        )
        .get(accountId, mailbox, uidvalidity, uid) as { id: number } | undefined;
      if (!row) continue;

      const body = byUid.get(uid);
      if (!body) {
        // The server didn't return this part. Mark it failed rather than
        // leaving it pending forever and re-requesting it every tick.
        db.prepare(`UPDATE messages SET body_state = 'failed' WHERE id = ?`).run(row.id);
        continue;
      }

      attachBody(db, row.id, {
        text: body.text,
        html: body.html,
        charset: body.charset,
      });
      fetched += 1;
    }
  });

  return fetched;
}
