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

/**
 * Bodies fetched per provider call inside a drain. Small on purpose: iCloud
 * in particular serves large FETCHes slowly enough to hit the borrow timeout,
 * and the chunk is the unit of loss when that happens.
 */
const BODY_CHUNK = 10;

/**
 * How often to re-read the flag window on a server without CONDSTORE. Long
 * enough that it is not a per-tick cost, short enough that a flag changed in
 * another client shows up the same session.
 */
const FALLBACK_FLAG_INTERVAL_MS = 30 * 60_000;

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
  /** The generation the sync ran against; the body drain needs it to match. */
  uidvalidity?: number;
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
/**
 * A mailbox to sync: where it lives on the server, and the name its rows are
 * cached under.
 *
 * The two differ on namespaced servers. A Dovecot-style server prefixes every
 * personal folder with `INBOX.`, so the holding folder is
 * `INBOX.agent-mail-holding` — but the executor and every tool ask for
 * `agent-mail-holding`. Caching under the server path would make those queries
 * return nothing for that account, which is the missing-mailbox bug moved one
 * layer up. So: talk to the server by `path`, store under `storeAs`.
 */
export interface ResolvedMailbox {
  path: string;
  storeAs: string;
}

export function resolveMailboxes(
  descriptors: MailboxDescriptor[],
  selectors: string[] = DEFAULT_MAILBOX_SELECTORS
): ResolvedMailbox[] {
  const resolved: ResolvedMailbox[] = [];
  const seen = new Set<string>();
  const push = (entry: ResolvedMailbox) => {
    if (!seen.has(entry.path)) {
      seen.add(entry.path);
      resolved.push(entry);
    }
  };

  for (const selector of selectors) {
    if (selector.startsWith('\\')) {
      const match = descriptors.find(
        (d) => d.specialUse?.toLowerCase() === selector.toLowerCase()
      );
      // Special-use folders keep their server path as the store name — nothing
      // queries them by an alias, and renaming them would orphan every row
      // already cached for existing accounts.
      if (match) push({ path: match.path, storeAs: match.path });
      continue;
    }

    const wanted = selector.toLowerCase();
    const exact = descriptors.find((d) => d.path.toLowerCase() === wanted);
    if (exact) {
      push({ path: exact.path, storeAs: selector });
      continue;
    }

    // Namespaced servers hide the folder behind a prefix; the last path
    // segment is what the selector actually names. Whole-segment match only —
    // a substring match would sync somebody's unrelated folder into the
    // canonical name.
    const suffix = descriptors.find((d) => {
      const parts = d.path.split(d.delimiter ?? '/');
      return parts[parts.length - 1]?.toLowerCase() === wanted;
    });
    if (suffix) push({ path: suffix.path, storeAs: selector });
  }

  return resolved;
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

/**
 * Address the server by the real path while every internal name — db rows,
 * state, logs, results — uses the canonical store name. One wrapper at the
 * boundary beats threading two names through every helper, and it makes the
 * invariant structural: nothing inside the sync can accidentally write a
 * server path into the cache.
 */
function translatePath(provider: SyncProvider, storeAs: string, path: string): SyncProvider {
  const toServer = (mailbox: string) => (mailbox === storeAs ? path : mailbox);
  // Envelopes carry the mailbox they were fetched from, and ingest trusts
  // that over the caller — so the translation has to cover the return leg too,
  // or rows land in the cache under the server path after all.
  const toStore = (envelopes: SyncEnvelope[]) =>
    envelopes.map((env) =>
      env.message.mailbox === path
        ? { ...env, message: { ...env.message, mailbox: storeAs } }
        : env
    );
  return {
    listMailboxes: () => provider.listMailboxes(),
    snapshot: (mailbox) => provider.snapshot(toServer(mailbox)),
    listUids: (mailbox, options) => provider.listUids(toServer(mailbox), options),
    fetchEnvelopes: async (mailbox, uids) =>
      toStore(await provider.fetchEnvelopes(toServer(mailbox), uids)),
    fetchBodies: (mailbox, uids) => provider.fetchBodies(toServer(mailbox), uids),
    delta: async (mailbox, known) => {
      const delta = await provider.delta(toServer(mailbox), known);
      return delta === null ? null : { ...delta, changed: toStore(delta.changed) };
    },
  };
}

export async function syncMailbox(
  db: Database,
  options: SyncOptions,
  target: string | ResolvedMailbox
): Promise<MailboxSyncResult> {
  const { path, storeAs } =
    typeof target === 'string' ? { path: target, storeAs: target } : target;
  const mailbox = storeAs;
  if (path !== storeAs) {
    options = { ...options, provider: translatePath(options.provider, storeAs, path) };
  }
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
    result.uidvalidity = snapshot.uidValidity;

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

    // Record the envelope sync as done BEFORE touching bodies.
    //
    // Bodies used to be fetched first, so a body fetch that hit the pool's
    // timeout threw past this line and the mailbox was marked failed with its
    // timestamp never advancing — while its envelopes had synced perfectly.
    // Status then reported the whole account stale and unusable, every tick,
    // for as long as any body fetch was slow. Envelopes are what searches,
    // sender sweeps and coverage actually use; bodies only add full-text.
    refreshOldestDate(db, accountId, mailbox);
    upsertMailboxState(db, accountId, mailbox, { last_delta_at: now() });

    // Bodies are drained separately, by the caller, on their own borrow — see
    // drainMailboxBodies. Sharing this one meant a slow body fetch consumed the
    // envelope sync's timeout budget and took the whole mailbox down with it.

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
 * Fetch a batch of queued message bodies for one mailbox.
 *
 * Separate from `syncMailbox` and called with its own connection, because the
 * pool's operation timeout applies per borrow. Sharing one meant a slow body
 * fetch — 50 full messages against a sluggish server — consumed the envelope
 * sync's budget, and a timeout there marked the whole mailbox failed even
 * though its envelopes had landed perfectly.
 *
 * Best-effort by design: bodies only add full-text search. Failures are
 * recorded as what they are and the rows stay `pending` for the next pass.
 */
export async function drainMailboxBodies(
  db: Database,
  options: SyncOptions,
  target: string | ResolvedMailbox,
  uidvalidity: number
): Promise<number> {
  const { path, storeAs } =
    typeof target === 'string' ? { path: target, storeAs: target } : target;
  const mailbox = storeAs;
  if (path !== storeAs) {
    options = { ...options, provider: translatePath(options.provider, storeAs, path) };
  }
  const { accountId } = options;
  try {
    return await drainBodies(db, options, mailbox, uidvalidity);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.logger?.warn('cache: body fetch failed, envelopes are still current', {
      account_id: accountId,
      mailbox,
      error: message,
    });
    upsertMailboxState(db, accountId, mailbox, {
      last_error: `message bodies could not be fetched (envelopes are current): ${message}`,
    });
    return 0;
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
      // A completed backfill has just read every envelope in the mailbox, so
      // flags are current by definition. Without this the very next fallback
      // tick would re-read the newest 500 for no reason.
      upsertMailboxState(db, accountId, mailbox, {
        backfill_complete: 1,
        last_flag_sync_at: now(),
      });
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

  // Only the part of the vanished list we actually hold means anything here.
  //
  // iCloud re-announces a mailbox's entire lifetime expunge history on every
  // SELECT — observed as 37164 UIDs on a 5957-message INBOX, the identical
  // number every tick, none of them cached. Deleting that list is a no-op by
  // construction, and warning about it every tick is an alarm that cries wolf
  // on schedule. So the reported list is intersected with the cache first,
  // and everything downstream — the deletion, the warning, the counts — works
  // on the intersection. The full reported size still lands in the debug line,
  // because a divergence between reported and cached is itself the signal.
  const goneCached =
    goneUids.length === 0
      ? goneUids
      : (() => {
          const held = new Set(cachedUids(db, accountId, mailbox, uidvalidity));
          return goneUids.filter((uid) => held.has(uid));
        })();

  // A *cached* vanished set this large is a real mass deletion, or corruption
  // reaching rows we hold — either deserves a human's attention, and filtering
  // must not silence it.
  if (goneCached.length > 5_000) {
    options.logger?.warn('cache: unusually large vanished set in delta', {
      account_id: accountId,
      mailbox,
      vanished_cached: goneCached.length,
      vanished_reported: goneUids.length,
      hint: 'a large share of the cached mailbox was deleted server-side',
    });
  }

  let vanished = 0;
  if (goneCached.length > 0) {
    withTransaction(db, () => {
      vanished = deleteMessages(db, {
        accountId,
        mailbox,
        uidvalidity,
        uids: goneCached,
      });
    });
  }

  options.logger?.debug?.('cache: delta sizes', {
    account_id: accountId,
    mailbox,
    changed: delta.changed.length,
    vanished_reported: goneUids.length,
    vanished_cached: goneCached.length,
    vanished_deleted: vanished,
  });

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

  // Arrivals every tick; the flag window only periodically.
  //
  // Without CONDSTORE there is no way to ask "what changed", so the only way to
  // notice a flag change made elsewhere is to re-read envelopes. Doing that
  // every tick is a fixed cost that never converges: on one real account it
  // meant re-ingesting the same 6363 messages every minute, forever, while two
  // mailboxes timed out at 300s and never finished at all. Arrivals are the
  // cheap half and the half that matters for freshness, so they stay per-tick;
  // the expensive half runs on an interval.
  const state = getMailboxState(db, accountId, mailbox);
  const flagsDue =
    state?.last_flag_sync_at == null ||
    now() - state.last_flag_sync_at >= FALLBACK_FLAG_INTERVAL_MS;

  const recent = flagsDue ? serverUids.slice(-FALLBACK_FLAG_WINDOW) : [];
  const toFetch = [...new Set([...arrivals, ...recent])].sort((a, b) => a - b);

  const envelopes =
    toFetch.length > 0 ? await provider.fetchEnvelopes(mailbox, toFetch) : [];
  if (envelopes.length > 0) ingestEnvelopes(db, accountId, uidvalidity, envelopes);

  if (flagsDue) {
    upsertMailboxState(db, accountId, mailbox, { last_flag_sync_at: now() });
  }

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

  // Small chunks, persisted as they land. One provider call for the whole
  // batch meant one all-or-nothing wait: a timeout at message 49 of 50 threw
  // away 48 finished downloads, and on a server slow enough to time out that
  // is the same bodies re-downloaded and re-lost every tick, forever. A chunk
  // that fails now costs at most BODY_CHUNK messages of progress, and the
  // failure propagates after the earlier chunks are safely on disk.
  let fetched = 0;
  for (let start = 0; start < uids.length; start += BODY_CHUNK) {
    const chunk = uids.slice(start, start + BODY_CHUNK);
    let bodies;
    try {
      bodies = await provider.fetchBodies(mailbox, chunk);
    } catch (error) {
      // Stop here rather than throw: everything before this chunk is already
      // on disk and the count has to say so. The rest stays pending for the
      // next pass, on what will be a fresh connection.
      const message = error instanceof Error ? error.message : String(error);
      options.logger?.warn('cache: body chunk failed, keeping earlier chunks', {
        account_id: accountId,
        mailbox,
        fetched_before_failure: fetched,
        remaining: uids.length - start,
        error: message,
      });
      upsertMailboxState(db, accountId, mailbox, {
        last_error: `message bodies could not be fetched (envelopes are current): ${message}`,
      });
      return fetched;
    }
    const byUid = new Map(bodies.map((b) => [b.uid, b]));

    withTransaction(db, () => {
      for (const uid of chunk) {
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
  }

  return fetched;
}
