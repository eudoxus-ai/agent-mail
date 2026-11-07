import type { Database } from '../ledger/sqlite.js';
import type { AccountConfig, Intent, RiskLevel } from '../types.js';
import { isListMail } from '../attention/signals.js';
import { classifyCategory, type Category } from '../attention/category.js';
import type { Logger } from '../logger.js';
import type { ImapConnectionPool } from '../provider/imap-pool.js';
import type { ImapProvider } from '../provider/imap.js';
import {
  createIntent,
  getIntent,
  getReversalLinks,
  linkReversal,
  updateIntentStatus,
  updateIntentStatusIfCurrent,
  withImmediateTransaction,
} from '../ledger/intents.js';
import { extractSnippetFromPart } from '../provider/mime.js';
import { parseSweep } from '../tools/hold-by-sender.js';
import { logAudit } from '../ledger/audit.js';
import { buildAuditSummary } from '../ledger/audit-summary.js';
import { getAccount } from '../provider/accounts.js';
import { resolveCredentials } from '../provider/credentials.js';
import {
  buildDraftMessage,
  createSmtpTransport,
  sendMail,
} from '../provider/smtp.js';
import {
  assertSafeRemoteUrl,
  createTimedAbortSignal,
} from '../provider/url-safety.js';
import { generateUndoToken, getUndoExpiry, parseUndoToken } from './undo.js';
import { buildUndoHint } from '../lib/undo-hint.js';
import { isConnectionDropError } from '../provider/imap-pool.js';
import { fanOut } from './fan-out.js';
import { locateMessages } from './locate.js';
import { parseTargets, type Target } from '../tools/target.js';
import {
  insertIntentTargets,
  getIntentTargets,
  updateIntentTargetDestinations,
  type IntentTargetInsert,
  type IntentTargetRow,
} from '../ledger/intent-targets.js';
import { updateIntentProgress, getIntentProgress, type IntentProgress } from '../ledger/intents.js';
import { checkStuckExecuting } from '../ledger/db.js';
import {
  describeWorkerState,
  INSTALL_HINT,
  type WorkerState,
} from '../ledger/worker-heartbeat.js';
import { decodeCursor, encodeCursor, type SearchCursor } from '../lib/search-cursor.js';
import { projectResult } from '../lib/envelope-projection.js';
import { searchCache, countByAccount } from '../cache/query.js';
import { getCoverage, isServable } from '../cache/coverage.js';
import { diffResults, logDivergence } from '../cache/shadow.js';
import { invalidate } from '../cache/invalidate.js';
import { stageAttachment, AttachmentTooLargeError } from '../cache/attachment-store.js';
import { INLINE_MAX_BYTES } from '../tools/get-attachment.js';
import { DEFAULT_CACHE_CONFIG, type CacheConfig } from '../cache/config.js';

/** One account's share of a hold. See `holdTargets`. */
interface AccountHoldResult {
  account_id: string;
  per_mailbox: Array<{ mailbox: string; message_count: number; uids: number[] }>;
  envelopes: Array<{
    account_id: string;
    uid: number;
    mailbox: string;
    subject: string;
    from: string;
    message_id?: string;
    /** Undefined on a dry run, or if the snapshot call failed. */
    uidvalidity?: number;
  }>;
  errors: Array<{ uid: number; account_id: string; mailbox: string; reason: string }>;
  failures: string[];
  /** Mailboxes done with, so a re-run after a dropped connection skips them. */
  finished: Set<string>;
}

/**
 * Thrown from `holdBySender` when the replies-present policy gate blocks the
 * move. Carries the structured payload returned to the caller AND a human
 * summary used as the intent's `error_detail` so audit logs tell the truth
 * (otherwise the intent would land as "executed" with a "Held messages from X"
 * summary, which is misleading since zero messages moved).
 *
 * Caught by `executeImmediate`'s catch block, which marks the intent `failed`,
 * emits a `failed` audit entry, and returns the structured payload instead of
 * rethrowing.
 */
class HoldBySenderBlockedError extends Error {
  readonly payload: Record<string, unknown>;
  readonly errorDetail: { message: string; code: string };

  constructor(payload: Record<string, unknown>, summary: string) {
    super(summary);
    this.name = 'HoldBySenderBlockedError';
    this.payload = payload;
    this.errorDetail = {
      message: summary,
      code: (payload.code as string) ?? 'blocked',
    };
  }
}

interface SearchThreadResult {
  account_id: string;
  mailbox: string;
  uid: number;
  from_address: string;
  from_name: string | null;
  envelope: {
    message_id: string;
    subject: string;
    from: { address: string; name: string | null };
    date: string;
  };
  snippet: string;
  flags: string[];
  list_id: string | null;
  list_unsubscribe: string | null;
  is_list_mail: boolean;
  category: Category;
  target: { account_id: string; uid: number; mailbox: string };
}

interface SearchThreadsMultiPayload {
  accounts_searched: string[];
  accounts_available: string[];
  per_account_errors?: Record<string, string>;
  per_account_counts?: Record<string, number>;
  results: SearchThreadResult[];
  next_cursor?: string;
  /**
   * Present only on cache-backed responses. Lets the caller distinguish
   * "no results" from "no results within the window I have cached locally".
   */
  cache?: {
    state: string;
    last_synced_at: string | null;
    coverage: Record<string, Record<string, unknown>>;
  };
}

/**
 * The depth at which a queue this long has to be a bug.
 *
 * Not backpressure. The old cap of 8 existed because queued background work
 * was not durable — a promise chain in process memory that a restart
 * vaporized, leaving every intent marked `executing` forever — so bounding the
 * depth bounded the loss. Queued work is on disk now and survives a restart,
 * which is why fifty holds in one go is a reasonable thing to do and no longer
 * needs refusing. This bound exists only so a runaway loop cannot fill the
 * ledger unnoticed.
 */
export const QUEUE_SANITY_LIMIT = 1000;

/** Raised when the queue is so deep that something is looping. */
export class QueueOverflowError extends Error {
  constructor(
    readonly queued: number,
    readonly limit: number
  ) {
    super(
      `${queued} actions are already queued (limit ${limit}). That is far more than ` +
        'a person files by hand, so something is probably looping. Nothing was queued ' +
        'by this call.'
    );
    this.name = 'QueueOverflowError';
  }
}

/**
 * Raised when a recorded UID belongs to a mailbox generation that no longer
 * exists. The message the UID named is gone; some unrelated message may now
 * answer to that number.
 */
export class GenerationMismatchError extends Error {
  constructor(
    readonly mailbox: string,
    readonly recorded: number,
    readonly current: number
  ) {
    super(
      `${mailbox} uidvalidity changed (recorded ${recorded}, now ${current}): ` +
        'the recorded UIDs no longer identify the same messages, so nothing was moved. ' +
        'Find the messages again with a search and act on the current UIDs.'
    );
    this.name = 'GenerationMismatchError';
  }
}

/** The subset of the IMAP surface the generation guard needs. */
function describeCacheOnly(accounts: string[]): string {
  return accounts.length === 0
    ? ''
    : ` ${accounts.join(', ')} refused the List-Id search, so this sweep used ` +
        'the local cache there. That covers only the mail the cache has backfilled.';
}

/**
 * Whether something is still working on an executing intent. Decided from the
 * ledger, because queued jobs run in the daemon, whose pool this process can't
 * see. Two signals mean alive: a live worker lease, or fresh progress.
 */
function intentLiveness(db: Database, intent: Intent, now = Date.now()) {
  const updatedAt = getIntentProgress(db, intent.id)?.updated_at;
  const progressAgeMs = updatedAt != null ? now - new Date(updatedAt).getTime() : null;
  const liveLease =
    intent.claimed_by != null &&
    intent.lease_expires_at != null &&
    new Date(intent.lease_expires_at).getTime() > now;
  // Progress lands at least once per mailbox per pass, well inside the
  // operation timeout; anything fresher than this window is being written by a
  // live job.
  const freshProgress = progressAgeMs != null && progressAgeMs < PROGRESS_STALE_AFTER_MS;
  return { liveLease, progressAgeMs, alive: liveLease || freshProgress };
}

interface GenerationReader {
  mailboxSnapshot(mailbox: string): Promise<{ uidValidity: number }>;
}

/**
 * Refuse to replay UIDs recorded in a generation the mailbox has since left.
 *
 * IMAP UIDs are unique only within a `(mailbox, UIDVALIDITY)` pair. Every
 * replay path — restore, undo, and the durable queue's at-least-once retry —
 * moves mail by a UID recorded earlier, so crossing a generation boundary moves
 * whatever now happens to answer to that number.
 *
 * Pass the generation belonging to the mailbox the UIDs will be read *out of*.
 * For a hold's targets that is `destination_uidvalidity` (the holding folder),
 * not `uidvalidity` (where the mail came from) — checking the latter would
 * guard a mailbox nobody is addressing by UID.
 *
 * A `null` recorded generation predates the column. Those rows are let through
 * with a warning: refusing them would break undo for everything already in the
 * ledger, which is a certain harm against a speculative one.
 */
export async function assertGenerationMatches(
  imap: GenerationReader,
  mailbox: string,
  recorded: number | null,
  opts: {
    logger?: { warn(message: string, meta?: Record<string, unknown>): void };
    /** Memoizes snapshots so a batch of targets costs one round trip. */
    cache?: Map<string, number>;
    context?: string;
  } = {}
): Promise<void> {
  if (recorded == null) {
    opts.logger?.warn('replaying a target with no recorded uidvalidity', {
      mailbox,
      context: opts.context,
    });
    return;
  }

  let current = opts.cache?.get(mailbox);
  if (current === undefined) {
    current = (await imap.mailboxSnapshot(mailbox)).uidValidity;
    opts.cache?.set(mailbox, current);
  }

  if (current !== recorded) {
    throw new GenerationMismatchError(mailbox, recorded, current);
  }
}

/**
 * Progress older than this on an unclaimed executing intent means nothing is
 * writing it any more. Live jobs update progress at least once per mailbox per
 * pass, bounded by the pool's 5-minute operation timeout — 10 minutes is past
 * anything a healthy job produces, with slack for a slow provider.
 */
const PROGRESS_STALE_AFTER_MS = 10 * 60_000;

/** The most of a message body `read_thread` hands to the agent. */
const READ_THREAD_MAX_BODY_CHARS = 20_000;
const LIST_SENDERS_DEFAULT_LIMIT = 200;
const SKIPPED_REPLIED_MAX_TARGETS = 50;
const GET_INTENT_DEFAULT_TARGETS = 50;

/** How much of an account a capped scan actually reached. */
interface ScanCoverage {
  scanned: number;
  truncated: boolean;
  oldest_scanned: string | null;
}

function scanCoverage(dates: string[], scanLimit: number): ScanCoverage {
  const oldest = dates.reduce<string | null>(
    (min, date) => (!min || new Date(date) < new Date(min) ? date : min),
    null
  );
  return { scanned: dates.length, truncated: dates.length >= scanLimit, oldest_scanned: oldest };
}

/**
 * Tools that change mail. Only these can be meaningfully orphaned by a restart
 * — a read that died with the process changed nothing.
 */
const MUTATING_TOOLS = new Set([
  'hold_messages',
  'hold_by_sender',
  'restore_messages',
  'label_thread',
  'queue_send',
  'draft_reply',
  'unsubscribe_sender',
  'undo_intent',
]);

/** Exported for tests: only mutations can be orphaned by a restart. */
export function isMutatingTool(tool: string): boolean {
  return MUTATING_TOOLS.has(tool);
}

export interface ExecutorDeps {
  db: Database;
  accounts: AccountConfig[];
  pool: ImapConnectionPool;
  logger: Logger;
  /**
   * Local message cache. Optional: when absent (or when its mode is `off`)
   * every read goes to IMAP exactly as before. The cache is an optimization,
   * never a dependency.
   */
  cache?: Database;
  cacheConfig?: CacheConfig;
}

export class Executor {
  private db: Database;
  private accounts: AccountConfig[];
  private pool: ImapConnectionPool;
  private logger: Logger;
  /**
   * Intent IDs for which an undo is currently in flight. Used as an in-process
   * mutex to prevent two concurrent undo requests from both executing the
   * reversible IMAP side effect before the DB CAS has a chance to settle.
   */
  private readonly pendingUndos = new Set<string>();
  private cache: Database | null;
  private cacheConfig: CacheConfig;

  constructor(deps: ExecutorDeps) {
    this.db = deps.db;
    this.accounts = deps.accounts;
    this.pool = deps.pool;
    this.logger = deps.logger;
    this.cache = deps.cache ?? null;
    this.cacheConfig = deps.cacheConfig ?? DEFAULT_CACHE_CONFIG;
  }

  /** How much accepted work is waiting on the daemon. */
  queueLoad(): { queued: number; limit: number } {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM intents WHERE status = 'queued'`)
      .get() as { n: number };
    return { queued: Number(row.n ?? 0), limit: QUEUE_SANITY_LIMIT };
  }

  /** Fire-and-forget cache maintenance after a successful IMAP mutation (D2). */
  private echoToCache(input: Parameters<typeof invalidate>[1]): void {
    if (!this.cache) return;
    invalidate(this.cache, input, this.logger);
  }

  async executeImmediate(params: {
    tool: string;
    toolParams: Record<string, unknown>;
    accountId: string;
    agentId: string;
    risk: RiskLevel;
  }): Promise<{ intent: Intent; result: Array<{ type: 'text'; text: string }> }> {
    const intent = createIntent(this.db, {
      account_id: params.accountId,
      tool: params.tool,
      params: params.toolParams,
      risk: params.risk,
      agent_id: params.agentId,
    });

    logAudit(this.db, {
      intent_id: intent.id,
      account_id: params.accountId,
      action: 'created',
      actor: params.agentId,
      detail: buildAuditSummary(params.tool, 'created', params.toolParams),
    });

    // Set executing status for crash consistency
    updateIntentStatus(this.db, intent.id, 'executing');
    logAudit(this.db, {
      intent_id: intent.id,
      account_id: params.accountId,
      action: 'executing',
      actor: 'policy',
      detail: buildAuditSummary(params.tool, 'executing', params.toolParams),
    });

    try {
      const result = await this.performAction(intent);

      const isDryRun = params.toolParams.dry_run === true;

      const undoToken = isDryRun
        ? null
        : generateUndoToken(params.tool, params.toolParams);
      const undoExpiry = isDryRun ? null : getUndoExpiry(params.tool);

      updateIntentStatus(this.db, intent.id, 'executed', {
        resolved_by: 'policy',
        undo_token: undoToken ?? undefined,
        undo_expires_at: undoExpiry ?? undefined,
      });

      logAudit(this.db, {
        intent_id: intent.id,
        account_id: params.accountId,
        action: 'executed',
        actor: 'policy',
        detail: buildAuditSummary(params.tool, 'executed', params.toolParams),
      });

      return { intent: getIntent(this.db, intent.id)!, result };
    } catch (error) {
      const errorDetail =
        error instanceof HoldBySenderBlockedError
          ? error.errorDetail
          : { message: error instanceof Error ? error.message : String(error) };
      updateIntentStatus(this.db, intent.id, 'failed', {
        error_detail: errorDetail,
      });
      logAudit(this.db, {
        intent_id: intent.id,
        account_id: params.accountId,
        action: 'failed',
        actor: 'policy',
        detail: buildAuditSummary(params.tool, 'failed', params.toolParams, errorDetail),
      });
      // Blocked-by-policy is not a crash — swallow the sentinel and return
      // the structured payload so the agent can act on it. Any other error
      // propagates as before.
      if (error instanceof HoldBySenderBlockedError) {
        return {
          intent: getIntent(this.db, intent.id)!,
          result: [{ type: 'text', text: JSON.stringify(error.payload, null, 2) }],
        };
      }
      throw error;
    }
  }

  /**
   * No-intent read path for scans. Scans are idempotent reads tracked by
   * `scan_jobs`, not the `intents` ledger, so this reuses the same fan-out read
   * logic as `performAction` WITHOUT creating an intent or audit rows. Returns
   * the raw payload (the same object the synchronous tool dispatch serializes).
   *
   * Used by both the sync dispatch path (wrapped in `withTimeout`) and the
   * async `ScanJobRunner.start` background work closure.
   */
  async runRead(
    tool: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    // Build a minimal intent-shaped object: the multi read methods only read
    // `intent.params`. account_id is irrelevant for fan-out reads (they derive
    // targets from params.account_ids or all accounts).
    const pseudoIntent = {
      id: 'scan',
      account_id: '',
      tool,
      params,
      risk: 'none',
      status: 'executing',
      error_detail: null,
      agent_id: null,
      created_at: new Date().toISOString(),
      resolved_at: null,
      resolved_by: null,
      undo_token: null,
      undo_expires_at: null,
    } as Intent;

    switch (tool) {
      case 'search_threads':
        return this.searchThreadsMulti(pseudoIntent);
      case 'list_senders':
        return this.listSendersMulti(pseudoIntent);
      default:
        throw new Error(`runRead: unsupported tool "${tool}"`);
    }
  }

  /**
   * Find messages from this sender that the server's FROM search did not return.
   *
   * The match in `hold_by_sender` is performed by the IMAP server, and it does
   * not always mean what the spec says. iCloud's covers only the first ~29
   * characters of the sender address, measured across four senders: for
   * `MattressFirm@email.mattressfirm.com`, `email.mattressfi` matched all 24
   * messages and `email.mattressfir` — one character longer, ending at offset
   * 30 — matched none. Nor does it fail cleanly to zero: a sweep for
   * `mail.zillow.com` came back with 1 of 59, which looks like a result.
   *
   * The local cache stores the address parsed out of the IMAP ENVELOPE and
   * matches it with a plain LIKE, so it finds what the server's index cannot.
   *
   * Strictly one-way. The cache has a backfill floor and a sync interval, so it
   * under-reports in its own way: a cache hit the server missed is evidence,
   * but a cache miss proves nothing. So this only ever adds UIDs to a sweep —
   * letting it subtract would turn its coverage gaps into silently missed
   * holds, which is the bug being fixed, relocated.
   */
  private async recoverMissedBySender(args: {
    accountId: string;
    mailbox: string;
    from?: string;
    listId?: string;
    before?: Date;
    limit: number;
    alreadyFound: number[];
    imap: { mailboxSnapshot(mailbox: string): Promise<{ uidValidity: number }> };
  }): Promise<{ uids: number[]; checked: boolean; reason?: string }> {
    // `no cache` is distinct from an unusable one: with no cache configured
    // there is nothing to report, whereas an unusable cache means the
    // cross-check did not happen and the caller should not read completeness
    // into the result.
    if (!this.cache) return { uids: [], checked: false, reason: 'no cache' };
    if (this.cacheConfig.mode === 'off') {
      return { uids: [], checked: false, reason: 'cache mode is off' };
    }

    const attempt = this.readFromCache({
      accountIds: [args.accountId],
      mailbox: args.mailbox,
      from: args.from,
      listId: args.listId,
      before: args.before,
      limit: args.limit,
    });
    if (!attempt) return { uids: [], checked: false, reason: 'cache read failed' };
    if (!attempt.servable) {
      return { uids: [], checked: false, reason: `cache ${attempt.coverage.state}` };
    }

    const found = new Set(args.alreadyFound);
    const candidates = attempt.rows.filter((row) => !found.has(row.uid));
    if (candidates.length === 0) return { uids: [], checked: true };

    // A cached UID is only meaningful in the generation it was cached in. The
    // snapshot costs a round trip, so it is only taken when there is something
    // to validate.
    let current: number;
    try {
      current = (await args.imap.mailboxSnapshot(args.mailbox)).uidValidity;
    } catch {
      // Cannot prove the UIDs are current, so do not act on them. Under-holding
      // is recoverable; moving the wrong messages is not.
      return { uids: [], checked: false, reason: 'could not read mailbox generation' };
    }

    const usable = candidates.filter((row) => row.uidvalidity === current);
    if (usable.length < candidates.length) {
      this.logger.warn('cache: ignoring sender matches from a stale generation', {
        account_id: args.accountId,
        mailbox: args.mailbox,
        ignored: candidates.length - usable.length,
      });
    }
    return { uids: usable.map((row) => row.uid), checked: true };
  }

  /**
   * Write the action to the queue and hand back its id. Nothing runs here.
   *
   * Bulk mailbox sweeps over a slow provider can outlast any client's patience,
   * and a client-side timeout is not a signal about what happened on the
   * server — the same timeout can mean "finished, response lost" or "never
   * ran". Returning the id first makes the outcome knowable either way: poll
   * `get_intent` for the terminal status.
   *
   * The work used to run right here, in a fire-and-forget closure. That made
   * the id a promise this process could not keep: a restart vaporized the
   * closure and left the intent reading `executing` forever, indistinguishable
   * from a slow provider. The daemon performs it now, and `queued` is a state
   * that survives on disk.
   */
  async enqueue(params: {
    tool: string;
    toolParams: Record<string, unknown>;
    accountId: string;
    agentId: string;
    risk: RiskLevel;
  }): Promise<Intent> {
    const { queued, limit } = this.queueLoad();
    if (queued >= limit) {
      // Refuse before creating an intent, so nothing is left behind to
      // reconcile — the caller can retry the identical call verbatim.
      throw new QueueOverflowError(queued, limit);
    }

    const intent = createIntent(this.db, {
      account_id: params.accountId,
      tool: params.tool,
      params: params.toolParams,
      risk: params.risk,
      agent_id: params.agentId,
    });

    logAudit(this.db, {
      intent_id: intent.id,
      account_id: params.accountId,
      action: 'created',
      actor: params.agentId,
      detail: buildAuditSummary(params.tool, 'created', params.toolParams),
    });

    // `queued`, not `executing`. The distinction is the whole point: executing
    // claims something is happening, and for a year the most common reason it
    // was not was that nothing was ever going to.
    updateIntentStatus(this.db, intent.id, 'queued');

    return getIntent(this.db, intent.id)!;
  }

  /**
   * Run an intent a worker has already claimed.
   *
   * The claim moved it to `executing` and stamped the lease; this performs the
   * action and settles the ledger. Unlike the other two paths it never throws:
   * the caller is a drain loop, and an escaping rejection there takes the
   * daemon — and every other queued job — down with it.
   */
  async performQueued(
    intent: Intent
  ): Promise<{ status: 'executed' | 'failed'; result?: Array<{ type: 'text'; text: string }> }> {
    const toolParams = intent.params;

    logAudit(this.db, {
      intent_id: intent.id,
      account_id: intent.account_id,
      action: 'executing',
      actor: 'worker',
      detail: buildAuditSummary(intent.tool, 'executing', toolParams),
    });

    try {
      const result = await this.performAction(intent);

      const isDryRun = toolParams.dry_run === true;
      updateIntentStatus(this.db, intent.id, 'executed', {
        resolved_by: 'worker',
        undo_token: isDryRun
          ? undefined
          : (generateUndoToken(intent.tool, toolParams) ?? undefined),
        undo_expires_at: isDryRun ? undefined : (getUndoExpiry(intent.tool) ?? undefined),
      });
      logAudit(this.db, {
        intent_id: intent.id,
        account_id: intent.account_id,
        action: 'executed',
        actor: 'worker',
        detail: buildAuditSummary(intent.tool, 'executed', toolParams),
      });

      return { status: 'executed', result };
    } catch (error) {
      const errorDetail =
        error instanceof HoldBySenderBlockedError
          ? error.errorDetail
          : { message: error instanceof Error ? error.message : String(error) };

      updateIntentStatus(this.db, intent.id, 'failed', { error_detail: errorDetail });
      logAudit(this.db, {
        intent_id: intent.id,
        account_id: intent.account_id,
        action: 'failed',
        actor: 'worker',
        detail: buildAuditSummary(intent.tool, 'failed', toolParams, errorDetail),
      });
      this.logger.warn('Queued execution failed', {
        intent_id: intent.id,
        tool: intent.tool,
        error: errorDetail.message,
      });

      // Blocked-by-policy is a result, not a crash — it is already recorded
      // and there is nobody to rethrow to.
      return {
        status: 'failed',
        result:
          error instanceof HoldBySenderBlockedError
            ? [{ type: 'text', text: JSON.stringify(error.payload, null, 2) }]
            : undefined,
      };
    }
  }

  async createGatedIntent(params: {
    tool: string;
    toolParams: Record<string, unknown>;
    accountId: string;
    agentId: string;
    risk: RiskLevel;
  }): Promise<Intent> {
    const intent = createIntent(this.db, {
      account_id: params.accountId,
      tool: params.tool,
      params: params.toolParams,
      risk: params.risk,
      agent_id: params.agentId,
    });

    logAudit(this.db, {
      intent_id: intent.id,
      account_id: params.accountId,
      action: 'created',
      actor: params.agentId,
      detail: buildAuditSummary(params.tool, 'created', params.toolParams),
    });

    this.logger.info(
      `Gated intent created: ${intent.id} (${params.tool}) — awaiting approval`
    );

    return intent;
  }

  async approveAndExecute(
    intentId: string,
    editedParams?: Record<string, unknown>
  ): Promise<Intent> {
    const intent = withImmediateTransaction(this.db, () => {
      const current = getIntent(this.db, intentId);
      if (!current) {
        throw new Error(`Intent not found: ${intentId}`);
      }

      const claimed = updateIntentStatusIfCurrent(
        this.db,
        intentId,
        'pending',
        'executing',
        { resolved_by: 'user' }
      );
      if (!claimed) {
        const latest = getIntent(this.db, intentId);
        throw new Error(
          `Intent ${intentId} is ${latest?.status ?? 'missing'}, not pending`
        );
      }

      if (editedParams) {
        // When the reviewer edits params, remove draft_id so the executor
        // uses the edited fields instead of fetching the original draft.
        const { draft_id: _, ...paramsWithoutDraft } = editedParams;
        this.db.prepare('UPDATE intents SET params = ? WHERE id = ?')
          .run(JSON.stringify(paramsWithoutDraft), intentId);
      }

      logAudit(this.db, {
        intent_id: intentId,
        account_id: current.account_id,
        action: 'approved',
        actor: 'user',
        detail: buildAuditSummary(current.tool, 'approved', current.params),
      });
      // Both 'approved' and 'executing' are logged inside the same transaction
      // so they always appear as an atomic pair in the audit log. The user
      // approval signal and the execution kick-off are intentionally collapsed
      // into one unit — the CAS (pending → executing) already captures the
      // approval decision durably.
      logAudit(this.db, {
        intent_id: intentId,
        account_id: current.account_id,
        action: 'executing',
        actor: 'user',
        detail: buildAuditSummary(current.tool, 'executing', current.params),
      });

      return getIntent(this.db, intentId)!;
    });

    try {
      await this.performAction(intent);

      const isDryRun = intent.params.dry_run === true;
      const undoToken = isDryRun
        ? null
        : generateUndoToken(intent.tool, intent.params);
      const undoExpiry = isDryRun ? null : getUndoExpiry(intent.tool);

      updateIntentStatus(this.db, intentId, 'executed', {
        resolved_by: 'user',
        undo_token: undoToken ?? undefined,
        undo_expires_at: undoExpiry ?? undefined,
      });
      logAudit(this.db, {
        intent_id: intentId,
        account_id: intent.account_id,
        action: 'executed',
        actor: 'user',
        detail: buildAuditSummary(intent.tool, 'executed', intent.params),
      });

      return getIntent(this.db, intentId)!;
    } catch (error) {
      const errorDetail = {
        message: error instanceof Error ? error.message : String(error),
      };
      updateIntentStatus(this.db, intentId, 'failed', {
        error_detail: errorDetail,
      });
      logAudit(this.db, {
        intent_id: intentId,
        account_id: intent.account_id,
        action: 'failed',
        actor: 'user',
        detail: buildAuditSummary(intent.tool, 'failed', intent.params, errorDetail),
      });
      throw error;
    }
  }

  async rejectIntent(intentId: string, reason?: string): Promise<Intent> {
    return withImmediateTransaction(this.db, () => {
      const intent = getIntent(this.db, intentId);
      if (!intent) throw new Error(`Intent not found: ${intentId}`);

      const rejected = updateIntentStatusIfCurrent(
        this.db,
        intentId,
        'pending',
        'rejected',
        { resolved_by: 'user' }
      );
      if (!rejected) {
        const latest = getIntent(this.db, intentId);
        throw new Error(
          `Intent ${intentId} is ${latest?.status ?? 'missing'}, not pending`
        );
      }

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

      return getIntent(this.db, intentId)!;
    });
  }

  /**
   * Withdraw work no worker has claimed. The compare-and-swap is what makes
   * this safe against the drain loop: claiming also moves an intent out of
   * `queued`, so exactly one of the two wins.
   */
  private cancelQueued(
    id: string,
    actor: string
  ): { intent_id: string; cancelled: boolean; status: string } {
    const cancelled = updateIntentStatusIfCurrent(this.db, id, 'queued', 'rejected', {
      resolved_by: actor,
      error_detail: { code: 'cancelled', message: 'Cancelled before it started.' },
    });
    const latest = getIntent(this.db, id);
    if (cancelled && latest) {
      logAudit(this.db, {
        intent_id: id,
        account_id: latest.account_id,
        action: 'rejected',
        actor,
        detail: buildAuditSummary(latest.tool, 'rejected', latest.params),
      });
    }
    return { intent_id: id, cancelled, status: latest?.status ?? 'not_found' };
  }

  async undoIntent(
    intentId: string
  ): Promise<{ success: boolean; message: string }> {
    // Prevent duplicate concurrent undo calls from executing the reversible IMAP
    // side effect. The in-process guard fires synchronously after the has() check
    // with no await in between, so no two calls can both pass it in the same
    // event-loop turn. add() runs immediately after the check so that the
    // finally block always cleans up the slot, even on early returns.
    if (this.pendingUndos.has(intentId)) {
      return { success: false, message: 'Undo already in progress for this intent' };
    }
    this.pendingUndos.add(intentId);

    try {
      const intent = getIntent(this.db, intentId);
      if (!intent) return { success: false, message: 'Intent not found' };
      if (intent.status !== 'executed') {
        return {
          success: false,
          message: `Cannot undo: intent is ${intent.status}`,
        };
      }
      if (!intent.undo_token) {
        return { success: false, message: 'No undo token available' };
      }

      const undoOp = parseUndoToken(intent.undo_token);

      if (undoOp.reverseAction === 'not_reversible') {
        return {
          success: false,
          message: `Action ${intent.tool} is not reversible`,
        };
      }

      if (
        intent.undo_expires_at &&
        new Date(intent.undo_expires_at) < new Date()
      ) {
        return { success: false, message: 'Undo window has expired' };
      }

      const undoResult = await this.performUndo(intent, undoOp);

      const undone = updateIntentStatusIfCurrent(
        this.db,
        intentId,
        'executed',
        'undone',
        { resolved_by: 'user' }
      );
      if (!undone) {
        const latest = getIntent(this.db, intentId);
        return {
          success: false,
          message: `Cannot undo: intent is ${latest?.status ?? 'missing'}`,
        };
      }

      logAudit(this.db, {
        intent_id: intentId,
        account_id: intent.account_id,
        action: 'undone',
        actor: 'user',
        detail: buildAuditSummary(intent.tool, 'undone', intent.params),
      });

      const unconfirmed = undoResult?.unconfirmed ?? 0;
      return {
        success: true,
        message:
          `Undone: ${intent.tool}` +
          (unconfirmed > 0
            ? `. ${unconfirmed} target(s) could not be located, so they were left alone.`
            : ''),
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.pendingUndos.delete(intentId);
    }
  }

  async threadHasReplies(
    accountId: string,
    mailbox: string,
    uids: number[]
  ): Promise<boolean> {
    return (await this.repliedUids(accountId, mailbox, uids)).size > 0;
  }

  /**
   * Which of these messages belong to a conversation worth leaving alone: a
   * thread someone replied to, or one the user wrote into. That covers more than
   * messages with a direct reply. An answer to mail the user sent has no reply of
   * its own, and it is the live end of the thread.
   */
  async repliedUids(
    accountId: string,
    mailbox: string,
    uids: number[]
  ): Promise<Set<number>> {
    return this.pool.withConnection(accountId, async (imap) => {
      // Envelopes rather than full messages: the gate needs only Message-Ids,
      // and a UID that has since gone simply isn't returned. It can't be moved
      // either, so it has no thread to protect and must not fail the rest.
      const selected = await imap.fetchEnvelopes(mailbox, uids);
      const selectedIds = selected.map((message) => message.messageId).filter(Boolean);
      const thread = await imap.replyThreadIds(mailbox, selectedIds, uids);

      const ancestryOf = (message: (typeof selected)[number]) =>
        [message.inReplyTo, ...message.references].filter((id): id is string => Boolean(id));
      const ancestors = [...new Set(selected.flatMap(ancestryOf))];

      // The user's own mail lives in Sent, not beside what it answers, and a
      // thread they took part in is the one most worth protecting. That runs
      // both ways: their reply to a selected message, and a selected message
      // that answers something they sent.
      for (const sent of await imap.sentMailboxes()) {
        if (sent === mailbox) continue;
        for (const id of await imap.replyThreadIds(sent, selectedIds, [])) thread.add(id);
        for (const id of await imap.messageIdsIn(sent, ancestors)) thread.add(id);
      }

      const inThread = (message: (typeof selected)[number]) =>
        [message.messageId, ...ancestryOf(message)].some((id) => thread.has(id));
      return new Set(selected.filter(inThread).map((message) => message.uid));
    });
  }

  private async resolveQueuedSend(
    intent: Intent,
    account: AccountConfig
  ): Promise<{
    from: string;
    to: string | string[];
    subject: string;
    text: string;
    inReplyTo?: string;
    references?: string[];
  }> {
    const draftId = intent.params.draft_id as number | undefined;
    if (draftId !== undefined) {
      const draft = await this.pool.withConnection(
        intent.account_id,
        async (imap) => {
          const draftsMailbox = await imap.getMailboxPath('drafts');
          return imap.fetchMessage(draftsMailbox, draftId);
        }
      );

      if (!draft.bodyText.trim()) {
        throw new Error(`Could not read the body of draft ${draftId}, so it was not sent`);
      }

      return {
        from: account.email,
        to: draft.to.map((participant) => participant.address).filter(Boolean),
        subject: draft.subject,
        text: draft.bodyText,
        inReplyTo: draft.inReplyTo,
        references: draft.references,
      };
    }

    return {
      from: account.email,
      to: intent.params.to as string,
      subject: intent.params.subject as string,
      text: intent.params.body as string,
      inReplyTo: intent.params.in_reply_to as string | undefined,
      references: intent.params.references as string[] | undefined,
    };
  }

  private async searchThreadsMulti(intent: Intent): Promise<SearchThreadsMultiPayload> {
    const requestedIds = (intent.params.account_ids as string[] | undefined) ?? null;
    const allIds = this.accounts.map((a) => a.id);
    const targetIds = requestedIds ?? allIds;

    const unknown = targetIds.filter((id) => !allIds.includes(id));
    if (unknown.length > 0) {
      throw new Error(`Unknown account_ids: ${unknown.join(', ')}`);
    }

    const mailbox = (intent.params.mailbox as string) ?? 'INBOX';
    const rawCursor = intent.params.cursor as string | undefined;
    const decodedCursor = rawCursor ? decodeCursor(rawCursor) : null;
    // When a cursor is present, we need BOTH `before` and `lastUid` to move
    // forward correctly across boundary-timestamp groups. Passing
    // `cursor.before` to IMAP as strictly-less-than would drop every message
    // that shares the cursor boundary timestamp but has uid > lastUid — they
    // would become unreachable. Instead pad the IMAP `before` by 1 ms so
    // boundary-timestamp rows come through, then post-filter below using a
    // `(date, uid)` tuple comparison against the cursor.
    const effectiveBefore = decodedCursor
      ? new Date(new Date(decodedCursor.before).getTime() + 1).toISOString()
      : (intent.params.before as string | undefined);
    const baseCriteria = {
      from: intent.params.from as string | undefined,
      to: intent.params.to as string | undefined,
      subject: intent.params.subject as string | undefined,
      since: intent.params.since
        ? new Date(intent.params.since as string)
        : undefined,
      before: effectiveBefore ? new Date(effectiveBefore) : undefined,
    };
    const limit = (intent.params.limit as number) ?? 20;
    const query = intent.params.query as string | undefined;
    // When paging with a cursor we may need to fetch more than `limit` from
    // IMAP: boundary-timestamp rows that tie with the cursor (`date ==
    // cursor.before`) can be mixed with already-seen rows. The tuple filter
    // drops the seen ones, so to guarantee we can still fill `limit` we over-
    // fetch up to the group size. `limit * 2` is a safe upper bound because
    // at most `limit` rows at the boundary were already returned on page 1.
    const imapFetchLimit = decodedCursor ? limit * 2 : limit;

    // Cache read path. `on` serves from the cache when coverage allows;
    // `shadow` computes the cache answer but still returns IMAP's, logging any
    // divergence. Either way a cache failure falls through to IMAP.
    const cacheAttempt =
      this.cache && this.cacheConfig.mode !== 'off'
        ? this.readFromCache({
            accountIds: targetIds,
            mailbox,
            query,
            from: baseCriteria.from,
            to: baseCriteria.to,
            subject: baseCriteria.subject,
            since: baseCriteria.since,
            before: baseCriteria.before,
            limit,
          })
        : null;

    if (cacheAttempt && this.cacheConfig.mode === 'on' && cacheAttempt.servable) {
      return this.buildCachePayload(cacheAttempt, allIds, limit, intent, decodedCursor);
    }

    const fanResult = await fanOut({
      pool: this.pool,
      accountIds: targetIds,
      label: 'search_threads',
      fn: async (accountId, imap) => {
        // Quotes mark a phrase for the cache; to a server they are literal text.
        const serverQuery = query?.replaceAll('"', '');
        const resultSets = serverQuery
          ? await Promise.all([
              imap.search(mailbox, { ...baseCriteria, subject: serverQuery }, imapFetchLimit),
              imap.search(mailbox, { ...baseCriteria, body: serverQuery }, imapFetchLimit),
            ])
          : [await imap.search(mailbox, baseCriteria, imapFetchLimit)];

        const merged = new Map<number, Awaited<(typeof resultSets)[number][number]>>();
        for (const set of resultSets) {
          for (const result of set) {
            merged.set(result.uid, result);
          }
        }
        const baseResults = Array.from(merged.values()).map((r) => ({
          account_id: accountId,
          mailbox,
          ...r,
          from_address: r.envelope?.from?.address ?? '',
          from_name: r.envelope?.from?.name ?? null,
          list_id: r.list_id ?? null,
          list_unsubscribe: r.list_unsubscribe ?? null,
          is_list_mail: isListMail(r.list_unsubscribe, r.list_id),
          category: classifyCategory({
            list_id: r.list_id ?? null,
            list_unsubscribe: r.list_unsubscribe ?? null,
            subject: r.envelope?.subject ?? '',
          }),
          target: { account_id: accountId, uid: r.uid, mailbox },
        }));

        // Populate snippet for threads that don't already have one.
        // Only runs when include_snippets: true — each call adds one extra IMAP round-trip
        // (N+1 calls per page). Default is off to keep searches fast.
        if (intent.params.include_snippets === true) {
          await Promise.all(
            baseResults.map(async (r) => {
              if (!r.snippet) {
                r.snippet = await imap.fetchSnippet(mailbox, r.uid);
              }
            })
          );
        }

        return baseResults;
      },
    });

    // Apply cursor filter: keep rows strictly older than `cursor.before`, and
    // rows at the boundary date only if their `{account_id, mailbox, uid}`
    // tuple was NOT already emitted on the previous page. UIDs are only
    // unique per account/mailbox, so a scalar UID comparison would drop
    // cross-account boundary rows (e.g. account B's uid=5 at the same
    // timestamp as account A's uid=100).
    const cursorBoundaryMs = decodedCursor
      ? new Date(decodedCursor.before).getTime()
      : null;
    const boundarySeenKeys = decodedCursor
      ? new Set(
          decodedCursor.boundary_seen.map(
            (r) => `${r.account_id}\x00${r.mailbox}\x00${r.uid}`
          )
        )
      : null;
    const allResults = Object.values(fanResult.per_account)
      .flat()
      .filter((r) => {
        if (cursorBoundaryMs === null || boundarySeenKeys === null) return true;
        const rowMs = new Date(r.envelope.date).getTime();
        if (rowMs < cursorBoundaryMs) return true;
        if (rowMs === cursorBoundaryMs) {
          return !boundarySeenKeys.has(
            `${r.account_id}\x00${r.mailbox}\x00${r.uid}`
          );
        }
        return false;
      })
      .sort(
        (a, b) =>
          new Date(b.envelope.date).getTime() - new Date(a.envelope.date).getTime()
      )
      .slice(0, limit);

    const per_account_counts: Record<string, number> = {};
    for (const [accountId, rows] of Object.entries(fanResult.per_account)) {
      per_account_counts[accountId] = (rows as any[]).length;
    }

    const fields = intent.params.fields as string[] | undefined;
    const projected = allResults.map((r) => projectResult(r, fields));

    const payload: SearchThreadsMultiPayload = {
      accounts_searched: fanResult.accounts_searched,
      accounts_available: allIds,
      per_account_counts,
      results: projected as unknown as SearchThreadResult[],
    };
    if (Object.keys(fanResult.errors).length > 0) {
      payload.per_account_errors = fanResult.errors;
    }
    if (allResults.length >= limit && allResults.length > 0) {
      const oldest = allResults[allResults.length - 1];
      const boundaryDate = oldest.envelope.date;
      const boundaryMs = new Date(boundaryDate).getTime();
      // Every row on this page sharing the oldest date must be recorded, not
      // just the last one — otherwise page 2 would re-emit the boundary rows
      // we already returned. Capped at `limit` entries.
      const boundary_seen = allResults
        .filter((r) => new Date(r.envelope.date).getTime() === boundaryMs)
        .map((r) => ({
          account_id: r.account_id,
          mailbox: r.mailbox,
          uid: r.uid,
        }));
      payload.next_cursor = encodeCursor({
        before: boundaryDate,
        boundary_seen,
      });
    }

    // Shadow mode: IMAP's answer is what ships; the cache answer is only
    // compared against it. This is the gate that has to pass before anyone
    // flips mode to `on`.
    if (cacheAttempt && this.cacheConfig.mode === 'shadow') {
      const diff = diffResults(allResults, cacheAttempt.rows);
      logDivergence(
        this.logger,
        { mailbox, query, account_ids: targetIds, limit, cache_state: cacheAttempt.coverage.state },
        diff
      );
    }

    return payload;
  }

  /** Run the cache-side query, tolerating any failure by returning null. */
  private readFromCache(params: {
    accountIds: string[];
    mailbox: string;
    query?: string;
    from?: string;
    listId?: string;
    to?: string;
    subject?: string;
    since?: Date;
    before?: Date;
    limit: number;
  }): {
    rows: ReturnType<typeof searchCache>;
    coverage: ReturnType<typeof getCoverage>;
    servable: boolean;
  } | null {
    if (!this.cache) return null;
    try {
      const coverage = getCoverage(this.cache, params.accountIds, {
        freshnessWindowSeconds: this.cacheConfig.freshnessWindowSeconds,
        // Coverage must be judged for the mailbox actually being searched.
        mailbox: params.mailbox,
      });
      const rows = searchCache(this.cache, params);
      return { rows, coverage, servable: isServable(coverage.state) };
    } catch (error) {
      this.logger.warn('cache: read failed, falling back to IMAP', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private buildCachePayload(
    attempt: NonNullable<ReturnType<Executor['readFromCache']>>,
    allIds: string[],
    limit: number,
    intent: Intent,
    cursor: SearchCursor | null
  ): SearchThreadsMultiPayload {
    const fields = intent.params.fields as string[] | undefined;

    // `before` was padded by 1 ms so rows sharing the previous page's boundary
    // timestamp come back rather than being skipped. They must then be
    // filtered by the tuple already emitted, exactly as the IMAP path does —
    // otherwise page two repeats page one and, when enough messages share a
    // timestamp, the cursor stops advancing.
    const rows = cursor ? applyCursorBoundary(attempt.rows, cursor) : attempt.rows;

    const payload: SearchThreadsMultiPayload = {
      accounts_searched: Object.keys(countByAccount(rows)),
      accounts_available: allIds,
      per_account_counts: countByAccount(rows),
      results: rows.map((r) => projectResult(r as never, fields)) as never,
    };

    // Coverage travels with every cache-backed answer so "no results" can be
    // distinguished from "no results within what I have locally".
    payload.cache = {
      state: attempt.coverage.state,
      last_synced_at: attempt.coverage.last_synced_at,
      coverage: attempt.coverage.coverage,
    };

    if (rows.length >= limit && rows.length > 0) {
      const oldest = rows[rows.length - 1];
      const boundaryMs = new Date(oldest.envelope.date).getTime();
      payload.next_cursor = encodeCursor({
        before: oldest.envelope.date,
        boundary_seen: rows
          .filter((r) => new Date(r.envelope.date).getTime() === boundaryMs)
          .map((r) => ({
            account_id: r.account_id,
            mailbox: r.mailbox,
            uid: r.uid,
          })),
      });
    }

    return payload;
  }

  /**
   * A snapshot of everything that explains a hang.
   *
   * The connection pool lives in this process and nowhere else, so a separate
   * CLI cannot observe it. Without this, a stalled background action is
   * indistinguishable from one that was never picked up.
   */
  private collectDiagnostics(): Record<string, unknown> {
    const pool = this.pool.diagnostics();

    // Exclude the diagnostics call itself, and every other read-only tool.
    //
    // Reads are recorded as intents too and are `executing` for the duration,
    // so an unfiltered list always contains at least this call observing
    // itself — reported as an orphan, on an idle server, which is precisely
    // when someone reaches for this. Only mutations can be meaningfully
    // orphaned: a read that vanished with the process changed nothing and has
    // nothing to re-run.
    //
    // Alive versus orphaned is decided from the LEDGER, not from this
    // process's connection pool. Queued jobs execute in the daemon, whose pool
    // this process cannot see — so "no operation in flight here" is
    // structurally blind, and it produced false orphans on actively-working
    // jobs whose attached advice was "re-run them". Two signals mean alive: a
    // live worker lease (the daemon owns it and is heartbeating), or progress
    // fresh enough that something is clearly still writing it. Orphaned means
    // both are dead — the fingerprint of the old in-process path dying
    // mid-action, which is the one case re-running is the right advice for.
    const now = Date.now();
    const inProgress: Array<Record<string, unknown>> = [];
    const orphaned: Array<Record<string, unknown>> = [];

    for (const intent of checkStuckExecuting(this.db)) {
      if (!MUTATING_TOOLS.has(intent.tool)) continue;

      const progress = getIntentProgress(this.db, intent.id);
      const targets = getIntentTargets(this.db, intent.id);
      const { liveLease, progressAgeMs, alive } = intentLiveness(this.db, intent, now);

      const entry: Record<string, unknown> = {
        intent_id: intent.id,
        tool: intent.tool,
        account_id: intent.account_id,
        created_at: intent.created_at,
        age_seconds: Math.round((now - new Date(`${intent.created_at}Z`).getTime()) / 1000),
        progress,
        targets_recorded: targets.length,
        targets_unconfirmed: targets.filter((t) => t.destination_uid === null).length,
      };

      if (alive) {
        entry.alive_because = liveLease
          ? `worker ${intent.claimed_by} holds a live lease`
          : `progress updated ${Math.round((progressAgeMs ?? 0) / 1000)}s ago`;
        inProgress.push(entry);
      } else {
        orphaned.push(entry);
      }
    }

    const busy = pool.accounts.filter((a) => a.in_flight !== null);
    const queued = pool.accounts.filter((a) => a.borrow_queue_depth > 0);

    const worker = describeWorkerState(this.db);

    return {
      // First, deliberately. Nothing else in here matters if the thing that
      // performs queued work is not running, and burying it under connection
      // statistics is exactly how that gets missed.
      worker,
      generated_at: new Date().toISOString(),
      runtime: {
        node: process.version,
        pid: process.pid,
        uptime_seconds: Math.round(process.uptime()),
      },
      // Leak tell: opened minus closed should equal live, and live should
      // never exceed the number of configured accounts.
      connections: {
        opened: pool.opened,
        closed: pool.closed,
        live: pool.live,
        accounts_configured: this.accounts.length,
        leaked: pool.opened - pool.closed !== pool.live || pool.live > this.accounts.length,
      },
      // Two different queues exist and they must not share a name.
      // worker.queued_count is the DURABLE queue: accepted work in the ledger,
      // visible from every process, drained by the daemon. This block is the
      // IMAP borrow queue: operations waiting for THIS process's connection to
      // an account — the daemon's pool is separate and not visible here. After
      // the durable queue landed, these depths sit at zero in the MCP process
      // almost always, and that is normal rather than a contradiction.
      imap_pool: {
        scope: 'this process only — the daemon has its own pool',
        accounts: pool.accounts,
        operation_timeout_ms: pool.operation_timeout_ms,
      },
      // Accepted work waiting on the daemon. Durable: it is in the ledger, so
      // a restart delays it rather than losing it.
      queue: this.queueLoad(),
      in_progress_intents: inProgress,
      orphaned_intents: orphaned,
      interpretation: buildInterpretation({
        busyCount: busy.length,
        queuedCount: queued.length,
        inProgressCount: inProgress.length,
        stuckCount: orphaned.length,
        longestElapsedMs: Math.max(0, ...busy.map((a) => a.in_flight!.elapsed_ms)),
        timeoutMs: pool.operation_timeout_ms,
        worker,
      }),
    };
  }

  private async fetchAttachment(
    intent: Intent
  ): Promise<Array<{ type: 'text'; text: string }>> {
    const target = intent.params.target as Target;
    const partId = intent.params.part_id as string;
    const inline = intent.params.inline === true;
    const maxBytes = this.cacheConfig.maxAttachmentBytes;
    // Target.mailbox is optional across the tool surface; INBOX is the
    // documented default everywhere else, so match it here.
    const mailbox = target.mailbox ?? 'INBOX';

    const fetched = await this.pool.withConnection(target.account_id, (imap) =>
      imap.fetchAttachment(mailbox, target.uid, partId, maxBytes)
    );

    if (!fetched) {
      throw new Error(
        `No attachment at part_id "${partId}" on ${mailbox}:${target.uid}`
      );
    }

    if (inline) {
      if (fetched.content.byteLength > INLINE_MAX_BYTES) {
        throw new Error(
          `Attachment is ${fetched.content.byteLength} bytes, too large to inline (limit ${INLINE_MAX_BYTES}). Omit "inline" to stage it on disk instead.`
        );
      }
      return [
        {
          type: 'text',
          text: JSON.stringify(
            {
              filename: fetched.filename,
              mime_type: fetched.mimeType,
              size: fetched.content.byteLength,
              content_base64: fetched.content.toString('base64'),
            },
            null,
            2
          ),
        },
      ];
    }

    try {
      const staged = stageAttachment({
        filename: fetched.filename,
        partId,
        content: fetched.content,
        maxBytes,
      });

      return [
        {
          type: 'text',
          text: JSON.stringify(
            {
              filename: staged.filename,
              mime_type: fetched.mimeType,
              size: staged.size,
              path: staged.path,
              expires_at: staged.expiresAt.toISOString(),
            },
            null,
            2
          ),
        },
      ];
    } catch (error) {
      if (error instanceof AttachmentTooLargeError) {
        throw new Error(
          `${error.message}. Raise cache.max_attachment_bytes if you need it.`
        );
      }
      throw error;
    }
  }

  private async listSendersMulti(intent: Intent): Promise<{
    accounts_searched: string[];
    accounts_available: string[];
    per_account_errors?: Record<string, string>;
    coverage: Record<string, ScanCoverage>;
    senders_total: number;
    senders: Array<{
      account_id: string;
      from: string;
      count: number;
      sample_uids: number[];
      has_unsubscribe: boolean;
      is_list_mail_ratio: number;
      latest_date: string;
    }>;
  }> {
    const requested = (intent.params.account_ids as string[] | undefined) ?? null;
    const allIds = this.accounts.map((a) => a.id);
    const targetIds = requested ?? allIds;
    const unknown = targetIds.filter((id) => !allIds.includes(id));
    if (unknown.length > 0) throw new Error(`Unknown account_ids: ${unknown.join(', ')}`);

    const mailbox = (intent.params.mailbox as string) ?? 'INBOX';
    const minCount = (intent.params.min_count as number) ?? 1;
    const sampleSize = (intent.params.sample_size as number) ?? 5;
    const scanLimit = (intent.params.scan_limit as number) ?? 500;
    const sendersLimit = (intent.params.limit as number) ?? LIST_SENDERS_DEFAULT_LIMIT;
    const coverage: Record<string, ScanCoverage> = {};
    const criteria = {
      since: intent.params.since ? new Date(intent.params.since as string) : undefined,
      before: intent.params.before ? new Date(intent.params.before as string) : undefined,
    };

    const fanResult = await fanOut({
      pool: this.pool,
      accountIds: targetIds,
      fn: async (accountId, imap) => {
        const raw = await imap.search(mailbox, criteria, scanLimit);
        coverage[accountId] = scanCoverage(raw.map((r) => r.envelope.date), scanLimit);
        const groups = new Map<string, {
          from: string;
          uids: number[];
          withUnsub: number;
          listMail: number;
          latest: string;
        }>();
        for (const r of raw) {
          const addr = r.envelope.from.address;
          if (!addr) continue;
          const g = groups.get(addr) ?? { from: addr, uids: [], withUnsub: 0, listMail: 0, latest: '' };
          g.uids.push(r.uid);
          if (r.list_unsubscribe) g.withUnsub += 1;
          if (isListMail(r.list_unsubscribe, r.list_id)) g.listMail += 1;
          if (!g.latest || new Date(r.envelope.date).getTime() > new Date(g.latest).getTime()) {
            g.latest = r.envelope.date;
          }
          groups.set(addr, g);
        }
        return Array.from(groups.values())
          .filter((g) => g.uids.length >= minCount)
          .map((g) => ({
            account_id: accountId,
            from: g.from,
            count: g.uids.length,
            sample_uids: g.uids.slice(0, sampleSize),
            has_unsubscribe: g.withUnsub > 0,
            is_list_mail_ratio: g.listMail / g.uids.length,
            latest_date: g.latest,
          }));
      },
    });

    const allSenders = Object.values(fanResult.per_account)
      .flat()
      .sort((a, b) => b.count - a.count);
    const senders = allSenders.slice(0, sendersLimit);

    const payload: {
      accounts_searched: string[];
      accounts_available: string[];
      per_account_errors?: Record<string, string>;
      coverage: Record<string, ScanCoverage>;
      senders_total: number;
      senders: typeof senders;
    } = {
      accounts_searched: fanResult.accounts_searched,
      accounts_available: allIds,
      coverage,
      senders_total: allSenders.length,
      senders,
    };
    if (Object.keys(fanResult.errors).length > 0) {
      payload.per_account_errors = fanResult.errors;
    }
    return payload;
  }

  private async listMailboxesMulti(intent: Intent) {
    const requested = (intent.params.account_ids as string[] | undefined) ?? null;
    const allIds = this.accounts.map((a) => a.id);
    const targetIds = requested ?? allIds;
    const unknown = targetIds.filter((id) => !allIds.includes(id));
    if (unknown.length > 0) throw new Error(`Unknown account_ids: ${unknown.join(', ')}`);

    const fanResult = await fanOut({
      pool: this.pool,
      accountIds: targetIds,
      fn: async (_accountId, imap) => ({ mailboxes: await imap.listMailboxes() }),
    });

    const payload: {
      accounts_searched: string[];
      accounts_available: string[];
      per_account_errors?: Record<string, string>;
      per_account: typeof fanResult.per_account;
    } = {
      accounts_searched: fanResult.accounts_searched,
      accounts_available: allIds,
      per_account: fanResult.per_account,
    };
    if (Object.keys(fanResult.errors).length > 0) {
      payload.per_account_errors = fanResult.errors;
    }
    return payload;
  }

  private async performAction(
    intent: Intent
  ): Promise<Array<{ type: 'text'; text: string }>> {
    const account = getAccount(this.accounts, intent.account_id);

    // SMTP path doesn't use the pool — it creates its own transport.
    // Handled before the pool borrow so the SMTP send doesn't hold the
    // per-account IMAP serialization lock.
    if (intent.tool === 'queue_send') {
      const resolved = resolveCredentials(account);
      const message = await this.resolveQueuedSend(intent, account);
      const transport = createSmtpTransport(resolved);
      const result = await sendMail(transport, message);
      const payload: Record<string, unknown> = { sent: true, messageId: result.messageId };
      const sendHint = buildUndoHint({ intent_id: intent.id, tool: intent.tool, created_at: intent.created_at });
      if (sendHint) Object.assign(payload, sendHint);
      return [{ type: 'text', text: JSON.stringify(payload) }];
    }

    // Multi-account read tools: fan out before borrowing a single connection
    if (intent.tool === 'search_threads') {
      const payload = await this.searchThreadsMulti(intent);
      return [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
    }

    if (intent.tool === 'list_senders') {
      const payload = await this.listSendersMulti(intent);
      return [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
    }

    if (intent.tool === 'list_mailboxes') {
      const payload = await this.listMailboxesMulti(intent);
      return [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
    }

    if (intent.tool === 'get_attachment') {
      return this.fetchAttachment(intent);
    }

    if (intent.tool === 'get_diagnostics') {
      return [{ type: 'text', text: JSON.stringify(this.collectDiagnostics(), null, 2) }];
    }

    // Multi-account label: group targets by account, fan out per-account
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
        label: 'label_thread',
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
            // IMAP has already accepted the change; echo it locally so a
            // follow-up search doesn't show the old flags (design D2).
            this.echoToCache({
              accountId,
              mailbox,
              uids,
              effect: 'flags_changed',
              detail:
                action === 'add' ? { flagsAdded: [label] } : { flagsRemoved: [label] },
            });
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
        reversible?: true;
        undo_hint?: { intent_id: string; method: string; window_expires_at: string };
        to_undo?: string;
      } = {
        accounts_searched: fanResult.accounts_searched,
        accounts_available: allIds,
        action,
        label,
      };
      if (Object.keys(fanResult.errors).length > 0) {
        payload.per_account_errors = fanResult.errors;
      }
      const labelHint = buildUndoHint({ intent_id: intent.id, tool: intent.tool, created_at: intent.created_at });
      if (labelHint) Object.assign(payload, labelHint);
      return [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
    }

    // Multi-account hold: group targets by account+mailbox, fan out, support dry_run
    if (intent.tool === 'hold_messages') {
      const targets = intent.params.targets as Target[];
      const dryRun = (intent.params.dry_run as boolean | undefined) ?? false;
      const includeSummary = (intent.params.include_summary as boolean | undefined) ?? true;
      return this.holdTargets(intent, targets, { dryRun, includeSummary });
    }

    // Expand (from, before) → targets in INBOX, then delegate to the same hold path.
    if (intent.tool === 'hold_by_sender') {
      return this.holdBySender(intent);
    }

    // Multi-account restore: move messages back to their original mailbox using ledger snapshots
    if (intent.tool === 'restore_messages') {
      const targets = intent.params.targets as Target[];
      const dryRun = (intent.params.dry_run as boolean | undefined) ?? false;
      const accountIds = [...new Set(targets.map((t) => t.account_id))];
      const allIds = this.accounts.map((a) => a.id);
      const unknown = accountIds.filter((id) => !allIds.includes(id));
      if (unknown.length > 0) throw new Error(`Unknown account_ids in targets: ${unknown.join(', ')}`);

      // What the ledger knows about each held UID, by account and UID, then by
      // the mailbox it came from: UIDs are unique only within a mailbox. Oldest
      // first, so the latest hold of a message wins.
      //
      // Any finished hold counts, and one whose process died: a failed hold's
      // move can still have landed, and undoing a restore can put mail back in
      // holding under a hold that was itself undone. Only a hold still running
      // is off limits.
      const rows = this.db
        .prepare(
          `SELECT it.intent_id, it.account_id, it.uid, it.envelope_snapshot, it.destination_uid,
                  it.destination_uidvalidity
           FROM intent_targets it
           JOIN intents i ON i.id = it.intent_id
           WHERE i.tool IN ('hold_messages', 'hold_by_sender')
             AND i.status IN ('executed', 'failed', 'undone', 'executing')
           ORDER BY i.created_at, i.rowid`
        )
        .all() as Array<{ intent_id: string; account_id: string; uid: number; envelope_snapshot: string | null; destination_uid: number | null; destination_uidvalidity: number | null }>;
      interface HeldEntry {
        intent_id: string;
        original_mailbox: string;
        message_id?: string;
        destination_uid: number | null;
        destination_uidvalidity: number | null;
      }
      const running = new Set(
        checkStuckExecuting(this.db)
          .filter((i) => intentLiveness(this.db, i).alive)
          .map((i) => i.id)
      );
      const held = new Map<string, Map<string, HeldEntry>>();
      for (const r of rows) {
        if (running.has(r.intent_id)) continue;
        const snap = r.envelope_snapshot ? JSON.parse(r.envelope_snapshot) : null;
        if (!snap?.original_mailbox) continue;
        const key = `${r.account_id}:${r.uid}`;
        const byMailbox = held.get(key) ?? new Map<string, HeldEntry>();
        byMailbox.set(snap.original_mailbox, {
          intent_id: r.intent_id,
          original_mailbox: snap.original_mailbox,
          message_id: snap.message_id,
          destination_uid: r.destination_uid ?? null,
          destination_uidvalidity: r.destination_uidvalidity ?? null,
        });
        held.set(key, byMailbox);
      }

      /** The hold this target means, or why it can't be told. */
      const resolveHeld = (t: Target, holding: string): HeldEntry | string => {
        const candidates = held.get(`${t.account_id}:${t.uid}`);
        if (!candidates) return 'original_mailbox unknown (not in ledger)';
        // Naming holding says where the message is now, not which one it is.
        if (t.mailbox && !t.mailbox.endsWith(holding)) {
          return candidates.get(t.mailbox) ?? `no hold recorded for UID ${t.uid} in ${t.mailbox}`;
        }
        if (candidates.size > 1) {
          const mailboxes = [...candidates.keys()].join(', ');
          return `UID ${t.uid} was held from more than one mailbox (${mailboxes}), so pass mailbox`;
        }
        return [...candidates.values()][0];
      };

      const moved: Array<{ uid: number; account_id: string; destination_mailbox: string }> = [];
      const errors: Array<{ uid: number; account_id: string; reason: string }> = [];
      const reverses = new Set<string>();
      // What the rehold_messages undo needs to find each restored message.
      const restored: IntentTargetInsert[] = [];

      for (const accountId of accountIds) {
        const accountTargets = targets.filter((t) => t.account_id === accountId);
        // Everything up to the first move can throw, and the pool may run it
        // again, so refusals are only published once it has got that far.
        let reachedMoves = false;
        try {
          await this.pool.withConnection(accountId, async (imap) => {
            const holding = await imap.getMailboxPath('holding');
            // One snapshot per mailbox for the whole batch, shared by the
            // generation guard and by the destination stamp written below.
            const generations = new Map<string, number>();
            const refused: typeof errors = [];
            const pending: Array<{ uid: number; entry: HeldEntry }> = [];
            for (const t of accountTargets) {
              const entry = resolveHeld(t, holding);
              if (typeof entry === 'string') {
                refused.push({ uid: t.uid, account_id: accountId, reason: entry });
                continue;
              }
              // The UID we are about to move lives in holding, so holding's
              // generation is the one that has to still match. Checked per
              // target, before the move, so a mismatch costs nothing.
              try {
                await assertGenerationMatches(
                  imap,
                  holding,
                  entry.destination_uidvalidity,
                  { logger: this.logger, cache: generations, context: 'restore_messages' }
                );
              } catch (error) {
                if (isConnectionDropError(error)) throw error;
                refused.push({
                  uid: t.uid,
                  account_id: accountId,
                  reason: error instanceof Error ? error.message : String(error),
                });
                continue;
              }
              pending.push({ uid: t.uid, entry });
            }

            const located = await locateMessages(
              imap,
              holding,
              pending.map(({ entry }) => ({ uid: entry.destination_uid, messageId: entry.message_id })),
              this.heldUids(accountId)
            );
            errors.push(...refused);
            reachedMoves = true;

            for (const [index, { uid, entry }] of pending.entries()) {
              const holdingUid = located[index];
              if (holdingUid === null) {
                errors.push({
                  uid,
                  account_id: accountId,
                  reason: 'not in holding, so there is nothing to restore',
                });
                continue;
              }
              if (!dryRun) {
                let uidMap: Map<number, number>;
                try {
                  ({ uidMap } = await imap.moveMessages([holdingUid], holding, entry.original_mailbox));
                } catch (error) {
                  errors.push({
                    uid,
                    account_id: accountId,
                    reason: error instanceof Error ? error.message : String(error),
                  });
                  continue;
                }
                this.echoToCache({
                  accountId,
                  mailbox: holding,
                  uids: [holdingUid],
                  effect: 'moved',
                  detail: { toMailbox: entry.original_mailbox },
                });

                // The restored UID lives in original_mailbox now, so that is the
                // generation the rehold undo will have to match.
                let landed = generations.get(entry.original_mailbox);
                if (landed === undefined) {
                  try {
                    landed = (await imap.mailboxSnapshot(entry.original_mailbox)).uidValidity;
                    generations.set(entry.original_mailbox, landed);
                  } catch {
                    landed = undefined;
                  }
                }
                restored.push({
                  account_id: accountId,
                  uid,
                  mailbox: entry.original_mailbox,
                  envelope_snapshot: {
                    subject: '',
                    from: '',
                    original_mailbox: entry.original_mailbox,
                    message_id: entry.message_id,
                  },
                  destination_uid: uidMap.get(holdingUid),
                  destination_uidvalidity: landed,
                });
              }
              moved.push({ uid, account_id: accountId, destination_mailbox: entry.original_mailbox });
              reverses.add(entry.intent_id);
            }
          });
        } catch (error) {
          // Nothing moved on this account, but others may have, and their
          // results still have to be recorded.
          if (reachedMoves) throw error;
          const reason = error instanceof Error ? error.message : String(error);
          for (const t of accountTargets) {
            errors.push({ uid: t.uid, account_id: accountId, reason });
          }
        }
      }

      if (!dryRun && reverses.size > 0) {
        linkReversal(this.db, { restoreIntentId: intent.id, reverses: [...reverses] });
      }

      // Persist targets so the rehold_messages undo knows where messages landed.
      if (restored.length > 0) insertIntentTargets(this.db, intent.id, restored);

      const payload: {
        dry_run: boolean;
        moved: typeof moved;
        errors: typeof errors;
        reversible?: true;
        undo_hint?: { intent_id: string; method: string; window_expires_at: string };
        to_undo?: string;
      } = {
        dry_run: dryRun,
        moved,
        errors,
      };
      if (!dryRun) {
        const restoreHint = buildUndoHint({ intent_id: intent.id, tool: intent.tool, created_at: intent.created_at });
        if (restoreHint) Object.assign(payload, restoreHint);
      }
      return [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
    }

    // Read-only DB lookup: return full intent record with targets and reversal links
    if (intent.tool === 'cancel_intent') {
      const results = (intent.params.intent_ids as string[]).map((id) =>
        this.cancelQueued(id, intent.agent_id ?? 'agent')
      );
      const payload = { cancelled: results.filter((r) => r.cancelled).length, results };
      return [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
    }

    if (intent.tool === 'get_intent') {
      const id = intent.params.intent_id as string;
      const row = getIntent(this.db, id);
      if (!row) {
        return [{ type: 'text', text: JSON.stringify({ error: 'intent not found', intent_id: id }) }];
      }
      const allTargets = getIntentTargets(this.db, id);
      const targetsLimit =
        (intent.params.targets_limit as number | undefined) ?? GET_INTENT_DEFAULT_TARGETS;
      const targets = allTargets.slice(0, targetsLimit).map((t) => ({
        uid: t.uid,
        account_id: t.account_id,
        mailbox: t.mailbox,
        subject: t.envelope_snapshot?.subject ?? null,
        from: t.envelope_snapshot?.from ?? null,
      }));
      const links = getReversalLinks(this.db, id);
      const payload: Record<string, unknown> = {
        id: row.id,
        type: row.tool,
        created_at: row.created_at,
        account_id: row.account_id,
        status: row.status,
        // What it is doing right now. Without this, a long-running action
        // reports only status: "executing" with an empty targets array, which
        // is indistinguishable from one that was never picked up.
        progress: getIntentProgress(this.db, id),
        targets,
        targets_total: allTargets.length,
      };
      // A queued action's caller only ever polls here, so this is the one
      // place it can learn why the action failed or was blocked.
      if (row.error_detail) payload.error_detail = row.error_detail;
      if (links.reverses.length > 0) payload.reverses_intent_id = links.reverses;
      if (links.reversed_by) payload.reversed_by_intent_id = links.reversed_by;

      // Only for work still waiting. A poller asking about a queued intent is
      // asking "why has this not happened yet", and a stopped daemon is the
      // answer. Saying it on an intent that already finished would train the
      // reader to skip past it.
      if (row.status === 'queued') {
        const worker = describeWorkerState(this.db);
        payload.daemon_running = worker.alive;
        if (worker.warning) payload.warning = worker.warning;
      }

      // A queued sweep's response payload is discarded — the caller gets an id
      // and polls here. "executed" with empty targets is indistinguishable from
      // a clean sweep on this surface, and a real sweep that matched zero (the
      // server's FROM search misses; confirmed: a domain substring matched 0
      // where the full address matched 18) was being read as the inbox coming
      // up clean. Promote the recorded no-match outcome to the top level.
      const progressRecord = payload.progress as IntentProgress | null;
      if (row.status === 'executed' && progressRecord?.phase === 'no_match') {
        const detail = progressRecord.detail ?? {};
        const crossCheck = detail.cache_cross_check as
          | { checked: boolean; recovered: number; applied: boolean; reason?: string }
          | undefined;
        const listId = detail.list_id as string | undefined;
        // The note carries the verdict in prose because a skimming reader
        // never opens the structured field. Three zeros, three meanings:
        // cache-verified, cache-contradicted (shadow saw messages it was not
        // allowed to hold), and unchecked — only the first may read as clean.
        const cacheNote = !crossCheck
          ? ''
          : crossCheck.recovered > 0
            ? ` The local cache found ${crossCheck.recovered} message(s) ${listId ? 'on this list' : 'from this sender'} ` +
              "that the server's search missed, and they were NOT held (cache.mode was " +
              "not 'on' in the process that ran this sweep). Run 'agent-mail cache on', " +
              'restart the daemon, and re-run the sweep.'
            : crossCheck.checked
              ? ' The local cache was cross-checked and found nothing either, so this is ' +
                'a verified zero.'
              : ` The local cache could NOT be cross-checked (${crossCheck.reason}), so ` +
                'a server-side search miss has not been ruled out.';
        payload.outcome = {
          status: 'no_match',
          matched: 0,
          searched: {
            ...(listId ? { list_id: listId } : { from: detail.from }),
            mailbox: detail.mailbox,
            ...(detail.before ? { before: detail.before } : {}),
          },
          ...(crossCheck ? { cache_cross_check: crossCheck } : {}),
          ...(detail.per_account_errors ? { per_account_errors: detail.per_account_errors } : {}),
          note:
            (listId
              ? 'The sweep matched no messages — this is NOT the same as the list being ' +
                'cleared. Read one message from the list with read_thread and copy its ' +
                'list_id exactly.' +
                describeCacheOnly((detail.cache_only_accounts as string[] | undefined) ?? [])
              : 'The sweep matched no messages — this is NOT the same as the sender being ' +
                'cleared. The server-side FROM match can miss; verify with search_threads, ' +
                'or retry with a different substring (a full address has been observed to ' +
                'match where a domain substring did not, and vice versa).') + cacheNote,
        };
      }

      return [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
    }

    // Account-qualified read: route by target.account_id, not intent.account_id
    if (intent.tool === 'read_thread') {
      const target = intent.params.target as {
        account_id: string;
        uid: number;
        mailbox?: string;
      };
      const allIds = this.accounts.map((a) => a.id);
      if (!allIds.includes(target.account_id)) {
        throw new Error(`Unknown account_id in target: ${target.account_id}`);
      }
      const mailbox = target.mailbox ?? 'INBOX';
      return this.pool.withConnection(target.account_id, async (imap) => {
        const msg = await imap.fetchMessage(mailbox, target.uid);
        // Attach a snippet derived from the already-fetched body — no extra IMAP call.
        const bodyContent = msg.bodyText ?? '';
        const snippet = extractSnippetFromPart({ type: 'text/plain', content: bodyContent });
        const payload: Record<string, unknown> = { ...msg, snippet };
        if (bodyContent.length > READ_THREAD_MAX_BODY_CHARS) {
          payload.bodyText = bodyContent.slice(0, READ_THREAD_MAX_BODY_CHARS);
          payload.body_truncated = true;
          payload.body_chars = bodyContent.length;
        }
        return [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
      });
    }

    // All other tools use IMAP via the pool (single-account principal)
    return this.pool.withConnection(intent.account_id, async (imap) => {
      switch (intent.tool) {
        case 'draft_reply': {
          const raw = buildDraftMessage({
            from: account.email,
            to: intent.params.to as string,
            subject: intent.params.subject as string,
            text: intent.params.body as string,
            inReplyTo: intent.params.in_reply_to as string | undefined,
            references: intent.params.references as string[] | undefined,
          });
          const result = await imap.createDraft(raw);
          // Persist draft_id into intent params so performUndo can read it via intent.params.draft_id
          intent.params = { ...intent.params, draft_id: result.uid };
          this.db.prepare('UPDATE intents SET params = ? WHERE id = ?')
            .run(JSON.stringify(intent.params), intent.id);
          const draftPayload: Record<string, unknown> = { draft_id: result.uid, message: 'Draft created' };
          return [{ type: 'text', text: JSON.stringify(draftPayload) }];
        }

        case 'unsubscribe_sender': {
          const resolved = await this.resolveUnsubscribe(intent, imap);
          const { url, headers } = await assertSafeRemoteUrl(resolved.url);
          // RFC 8058 defines this exact body; senders that support one-click
          // ignore or reject a POST without it.
          const response = await fetch(url, {
            method: 'POST',
            redirect: 'manual',
            signal: createTimedAbortSignal(),
            headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'List-Unsubscribe=One-Click',
          });
          const unsubPayload: Record<string, unknown> = {
            message: `Unsubscribe request sent (HTTP ${response.status})`,
            unsubscribe_url: resolved.url,
          };
          if (resolved.oneClick === false) {
            unsubPayload.warning =
              'This sender does not advertise one-click unsubscribe, so the link may need a person to confirm it in a browser.';
          }
          const unsubHint = buildUndoHint({ intent_id: intent.id, tool: intent.tool, created_at: intent.created_at });
          if (unsubHint) Object.assign(unsubPayload, unsubHint);
          return [{ type: 'text', text: JSON.stringify(unsubPayload) }];
        }

        default:
          return [{ type: 'text', text: `Unknown tool: ${intent.tool}` }];
      }
    });
  }

  /**
   * The URL to POST for `unsubscribe_sender`: the one passed in, or the HTTP
   * List-Unsubscribe link of the target message, read from the server.
   */
  private async resolveUnsubscribe(
    intent: Intent,
    imap: ImapProvider
  ): Promise<{ url: string; oneClick?: boolean }> {
    const target = intent.params.target as Target | undefined;
    const givenUrl = intent.params.unsubscribe_url as string | undefined;
    if (Boolean(target) === Boolean(givenUrl)) {
      throw new Error('unsubscribe_sender needs exactly one of target or unsubscribe_url');
    }
    if (!target) return { url: givenUrl as string };
    // The UID only means something in its own account, and this can't be undone.
    if (target.account_id !== intent.account_id) {
      throw new Error(
        `target belongs to ${target.account_id}, but this call is using ${intent.account_id}. ` +
          'Leave out account_id when passing a target.'
      );
    }

    const message = await imap.fetchMessage(target.mailbox ?? 'INBOX', target.uid);
    const header = message.listUnsubscribe;
    if (!header) {
      throw new Error(`UID ${target.uid} has no List-Unsubscribe header`);
    }
    if (!header.http_url) {
      throw new Error(
        `UID ${target.uid} only offers a mailto unsubscribe (${header.mailto}); use queue_send for it`
      );
    }
    return { url: header.http_url, oneClick: header.one_click };
  }

  /**
   * Shared hold execution: group targets by account+mailbox, fan out, move
   * to the holding folder, and persist ledger rows for restore/undo. Used by
   * both `hold_messages` (direct target list) and `hold_by_sender`
   * (search-expanded target list).
   */
  private async holdTargets(
    intent: Intent,
    targets: Target[],
    opts: { dryRun: boolean; includeSummary: boolean }
  ): Promise<Array<{ type: 'text'; text: string }>> {
    const { dryRun, includeSummary } = opts;
    const grouped = parseTargets(targets);
    const accountIds = Object.keys(grouped);
    const allIds = this.accounts.map((a) => a.id);
    const unknown = accountIds.filter((id) => !allIds.includes(id));
    if (unknown.length > 0) {
      throw new Error(`Unknown account_ids in targets: ${unknown.join(', ')}`);
    }

    // Outside the callback, because the pool runs it again after a dropped
    // connection. A second run picks up at the next mailbox, and what the first
    // run moved stays counted even if the account then fails outright.
    const results = new Map<string, AccountHoldResult>();

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

        const result: AccountHoldResult = results.get(accountId) ?? {
          account_id: accountId,
          per_mailbox: [],
          envelopes: [],
          errors: [],
          failures: [],
          finished: new Set(),
        };
        results.set(accountId, result);
        const { errors, failures, finished } = result;

        const holding = await imap.getMailboxPath('holding');

        // The generation the destination UIDs will belong to. This is the one
        // restore and undo check, because they move mail back *out* of holding
        // by the UID recorded here — a rebuild of holding invalidates those
        // numbers even though the source mailboxes are untouched.
        let holdingGeneration: number | undefined;
        if (!dryRun) {
          try {
            holdingGeneration = (await imap.mailboxSnapshot(holding)).uidValidity;
          } catch {
            // Same degradation as the source-mailbox snapshot: record the hold
            // without a generation rather than refuse to hold at all.
            holdingGeneration = undefined;
          }
        }

        for (const [mailbox, requested] of byMailbox) {
          if (finished.has(mailbox)) continue;
          let moveStarted = false;
          // One mailbox failing must not cost the others their result: what
          // they moved is real, and the caller has to hear about it.
          try {
            // The generation these UIDs belong to. Captured before the move, in
            // the same borrow, so it describes the mailbox the UIDs were read
            // from rather than whatever it may become later.
            let uidvalidity: number | undefined;
            if (!dryRun) {
              try {
                uidvalidity = (await imap.mailboxSnapshot(mailbox)).uidValidity;
              } catch {
                // A snapshot failure must not block the hold. The target is
                // recorded without a generation and is treated as pre-migration
                // at replay time — degraded, not broken.
                uidvalidity = undefined;
              }
            }

            const envs = await imap.fetchEnvelopes(mailbox, requested);
            const snapshots = envs.map((env) => ({
              account_id: accountId,
              uid: env.uid,
              mailbox,
              subject: env.subject,
              from: env.from.address,
              message_id: env.messageId || undefined,
              uidvalidity,
            }));

            // Only what the server returned goes forward. A UID with no envelope
            // is gone, and moving it anyway would leave no restorable record if
            // it did exist. One such target must not cost the others their move.
            const found = new Set(envs.map((env) => env.uid));
            const uids = requested.filter((uid) => found.has(uid));
            for (const uid of requested) {
              if (found.has(uid)) continue;
              errors.push({
                uid,
                account_id: accountId,
                mailbox,
                reason: `Message not found: UID ${uid} in ${mailbox}`,
              });
            }

            if (!dryRun && uids.length > 0) {
              // Write the restorable record BEFORE touching mail.
              //
              // Previously targets were persisted only after every account's
              // moves finished, so a process death mid-sweep left messages in
              // holding with no envelope snapshot and no original_mailbox —
              // restore_messages could not put them back. Writing first costs a
              // row that may turn out to be unused; getting it backwards costs
              // recoverability.
              insertIntentTargets(
                this.db,
                intent.id,
                snapshots.map((e) => ({
                  account_id: e.account_id,
                  uid: e.uid,
                  mailbox: e.mailbox,
                  uidvalidity: e.uidvalidity,
                  envelope_snapshot: {
                    subject: e.subject,
                    from: e.from,
                    original_mailbox: e.mailbox,
                    message_id: e.message_id,
                  },
                }))
              );

              updateIntentProgress(this.db, intent.id, 'moving', {
                account_id: accountId,
                mailbox,
                messages: uids.length,
              });

              moveStarted = true;
              const { uidMap } = await imap.moveMessages(uids, mailbox, holding);

              // Confirm where they landed. A target still lacking a
              // destination_uid after the fact is the fingerprint of an
              // interrupted run, and restore and undo look for it by Message-Id.
              updateIntentTargetDestinations(
                this.db,
                intent.id,
                accountId,
                uidMap,
                mailbox,
                holdingGeneration
              );
              // Drop the source rows immediately so held messages stop showing
              // up in searches of their original mailbox. The destination copy
              // has a server-assigned UID we don't know, so the holding mailbox
              // is only marked dirty — the next sync discovers it.
              this.echoToCache({
                accountId,
                mailbox,
                uids,
                effect: 'moved',
                detail: { toMailbox: holding },
              });
            }
            result.envelopes.push(...snapshots);
            result.per_mailbox.push({ mailbox, message_count: uids.length, uids });
          } catch (error) {
            // A drop before any mail moved is the pool's to handle: it
            // reconnects and runs this again. Once a move has started, a
            // second attempt can't tell what landed, so it stops here.
            if (!moveStarted && isConnectionDropError(error)) throw error;
            const reason = error instanceof Error ? error.message : String(error);
            failures.push(reason);
            for (const uid of requested) {
              errors.push({ uid, account_id: accountId, mailbox, reason });
            }
          }
          finished.add(mailbox);
        }
      },
    });

    const perAccountRaw = accountIds.flatMap((id) => results.get(id) ?? []);

    // Aggregate envelopes from all accounts (internal scaffolding — not exposed)
    const allEnvelopes = perAccountRaw.flatMap((a) => a.envelopes);
    const targetErrors = perAccountRaw.flatMap((a) => a.errors);

    const perAccount = perAccountRaw
      .filter((a) => a.per_mailbox.length > 0)
      .map((a) => ({
        account_id: a.account_id,
        per_mailbox: a.per_mailbox,
        message_count: a.per_mailbox.reduce((n, m) => n + m.message_count, 0),
      }));
    const totalMessages = perAccount.reduce((n, a) => n + a.message_count, 0);

    const accountErrors: Record<string, string> = { ...fanResult.errors };
    for (const a of perAccountRaw) {
      if (a.failures.length === 0) continue;
      accountErrors[a.account_id] = [...a.failures, accountErrors[a.account_id]]
        .filter(Boolean)
        .join('; ');
    }

    if (totalMessages === 0 && Object.keys(accountErrors).length > 0) {
      const reasons = Object.values(accountErrors).join('; ');
      // A target is recorded just before its move, so a row means a move was
      // tried, and a move can land even when the reply to it is lost.
      throw new Error(
        getIntentTargets(this.db, intent.id).length > 0
          ? `No message was confirmed as held: ${reasons}. A move can land despite an error, so check with restore_messages, which finds them in holding.`
          : `Nothing was held: ${reasons}`
      );
    }

    const payload: {
      accounts_searched: string[];
      accounts_available: string[];
      per_account_errors?: Record<string, string>;
      errors?: typeof targetErrors;
      dry_run: boolean;
      total_messages: number;
      per_account: typeof perAccount;
      moved?: Array<{
        uid: number;
        account_id: string;
        subject: string;
        from: string;
        original_mailbox: string;
      }>;
      reversible?: true;
      undo_hint?: { intent_id: string; method: string; window_expires_at: string };
      to_undo?: string;
    } = {
      accounts_searched: fanResult.accounts_searched,
      accounts_available: allIds,
      dry_run: dryRun,
      total_messages: totalMessages,
      per_account: perAccount,
    };
    if (Object.keys(accountErrors).length > 0) {
      payload.per_account_errors = accountErrors;
    }
    if (targetErrors.length > 0) payload.errors = targetErrors;
    // A queued caller never sees this payload, only what get_intent reads back.
    updateIntentProgress(this.db, intent.id, dryRun ? 'previewed' : 'held', {
      total_messages: totalMessages,
      ...(targetErrors.length > 0 ? { errors: targetErrors } : {}),
      ...(payload.per_account_errors ? { per_account_errors: payload.per_account_errors } : {}),
    });
    if (includeSummary) {
      payload.moved = allEnvelopes.map((e: any) => ({
        uid: e.uid,
        account_id: e.account_id,
        subject: e.subject,
        from: e.from,
        original_mailbox: e.mailbox,
      }));
    }
    if (!dryRun) {
      const holdHint = buildUndoHint({
        intent_id: intent.id,
        tool: intent.tool,
        created_at: intent.created_at,
      });
      if (holdHint) Object.assign(payload, holdHint);
    }
    return [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
  }

  private async holdBySender(
    intent: Intent
  ): Promise<Array<{ type: 'text'; text: string }>> {
    const sweep = parseSweep(intent.params);
    if (sweep.listId !== undefined) return this.holdSweep(intent, { listId: sweep.listId });
    if (sweep.batch) return this.holdSenders(intent, sweep.senders);
    return this.holdSweep(intent, { from: sweep.senders[0] });
  }

  /**
   * Sweep several senders under one intent, so a cleanup is one queue entry
   * that can be undone as a whole.
   *
   * Each sender settles on its own: one with replied threads is blocked by the
   * gate exactly as it would be alone, and the others still go ahead. Failing
   * every sender is the exception, because that is the batch failing.
   */
  private async holdSenders(
    intent: Intent,
    senders: string[]
  ): Promise<Array<{ type: 'text'; text: string }>> {
    const outcomes: Array<{
      from: string;
      status: 'held' | 'no_match' | 'blocked' | 'failed';
      messages: number;
      detail?: string;
      errors?: unknown[];
      per_account_errors?: Record<string, string>;
      warning?: string;
      cache_cross_check?: unknown;
      skipped_replied?: number;
    }> = [];

    for (const [done, from] of senders.entries()) {
      try {
        const [{ text }] = await this.holdSweep(intent, { from }, { done, total: senders.length });
        const result = JSON.parse(text);
        outcomes.push({
          from,
          status: result.status === 'no_match' ? 'no_match' : 'held',
          messages: result.total_messages,
          ...(result.status === 'no_match' ? { detail: result.diagnosis } : {}),
          ...(result.errors ? { errors: result.errors } : {}),
          ...(result.per_account_errors ? { per_account_errors: result.per_account_errors } : {}),
          ...(result.warning ? { warning: result.warning } : {}),
          ...(result.cache_cross_check ? { cache_cross_check: result.cache_cross_check } : {}),
          ...(result.skipped_replied ? { skipped_replied: result.skipped_replied.count } : {}),
        });
      } catch (error) {
        if (error instanceof HoldBySenderBlockedError) {
          outcomes.push({ from, status: 'blocked', messages: 0, detail: error.errorDetail.message });
        } else {
          outcomes.push({
            from,
            status: 'failed',
            messages: 0,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const summary = {
      dry_run: intent.params.dry_run === true,
      total_messages: outcomes.reduce((n, o) => n + o.messages, 0),
      senders: outcomes,
    };
    updateIntentProgress(this.db, intent.id, 'batch_complete', summary);

    if (outcomes.every((o) => o.status === 'failed')) {
      throw new Error(`Every sender failed. First error: ${outcomes[0].detail}`);
    }
    return [{ type: 'text', text: JSON.stringify(summary, null, 2) }];
  }

  /**
   * Expand a sender or list search into UIDs, then hold them via holdTargets.
   * Reuses the IMAP search path so we don't duplicate FROM/BEFORE semantics.
   */
  private async holdSweep(
    intent: Intent,
    match: { from: string; listId?: undefined } | { from?: undefined; listId: string },
    batch?: { done: number; total: number }
  ): Promise<Array<{ type: 'text'; text: string }>> {
    const { from, listId } = match;
    const before = intent.params.before as string | undefined;
    const requestedIds = intent.params.account_ids as string[] | undefined;
    const mailbox = (intent.params.mailbox as string | undefined) ?? 'INBOX';
    const dryRun = (intent.params.dry_run as boolean | undefined) ?? false;
    const includeSummary =
      (intent.params.include_summary as boolean | undefined) ?? true;
    const limit = Math.min(
      (intent.params.limit as number | undefined) ?? 500,
      1000
    );

    const allIds = this.accounts.map((a) => a.id);
    const targetIds = requestedIds ?? allIds;
    const unknown = targetIds.filter((id) => !allIds.includes(id));
    if (unknown.length > 0) {
      throw new Error(`Unknown account_ids: ${unknown.join(', ')}`);
    }

    const criteria = {
      from,
      listId,
      before: before ? new Date(before) : undefined,
    };

    const searched: string[] = [];
    const cacheOnlyAccounts: string[] = [];
    const cacheOnlyNote = () => describeCacheOnly(cacheOnlyAccounts);
    const reportSearching = () =>
      updateIntentProgress(this.db, intent.id, 'searching', {
        ...(from ? { from } : { list_id: listId }),
        accounts: targetIds,
        searched: [...searched],
        mailbox,
        ...(batch ? { batch } : {}),
      });
    reportSearching();

    const searchResult = await fanOut({
      pool: this.pool,
      accountIds: targetIds,
      label: 'hold_by_sender:search',
      fn: async (accountId, imap) => {
        // Some servers refuse HEADER List-Id outright, so a List-Id sweep can
        // still be answered from the cache. A sender search has no such excuse.
        let uids: number[] = [];
        let searchError: unknown;
        try {
          uids = (await imap.search(mailbox, criteria, limit)).map((r) => r.uid);
        } catch (error) {
          if (!listId) throw error;
          searchError = error;
        }
        const recovered = await this.recoverMissedBySender({
          accountId,
          mailbox,
          from,
          listId,
          before: criteria.before,
          limit,
          alreadyFound: uids,
          imap,
        });
        if (searchError !== undefined) {
          // Without the cache there is no answer at all, and that has to read
          // as an error rather than as the list having no mail.
          if (!recovered.checked) throw searchError;
          cacheOnlyAccounts.push(accountId);
        }
        searched.push(accountId);
        reportSearching();
        return { uids, recovered };
      },
    });

    const expandedTargets: Target[] = [];
    // `recovered` is what the server's search missed; `applied` is whether
    // anything was done about it. One shape for both modes.
    let crossCheck:
      | { checked: boolean; recovered: number; applied: boolean; reason?: string }
      | undefined;
    const applyRecovered = this.cacheConfig.mode === 'on';

    for (const accountId of searchResult.accounts_searched) {
      const leg = searchResult.per_account[accountId] as
        | { uids: number[]; recovered: { uids: number[]; checked: boolean; reason?: string } }
        | undefined;
      if (!leg) continue;

      for (const uid of leg.uids) {
        expandedTargets.push({ account_id: accountId, uid, mailbox });
      }
      // Recovered UIDs are added, never substituted. The cache can only ever
      // grow a sweep — see recoverMissedBySender for why that direction is the
      // only safe one.
      //
      // ...and only in `on`. Shadow's contract is that the cache changes
      // nothing: reads are served from it only in `on`, and quietly holding
      // extra messages here would be an undocumented exception that the next
      // person to reason about shadow would get wrong. Shadow measures and
      // reports; `on` acts.
      if (applyRecovered) {
        for (const uid of leg.recovered.uids) {
          expandedTargets.push({ account_id: accountId, uid, mailbox });
        }
      }

      if (leg.recovered.reason !== 'no cache') {
        crossCheck = {
          checked: (crossCheck?.checked ?? false) || leg.recovered.checked,
          recovered: (crossCheck?.recovered ?? 0) + leg.recovered.uids.length,
          applied: applyRecovered,
          reason: crossCheck?.reason ?? leg.recovered.reason,
        };
        if (crossCheck.checked) delete crossCheck.reason;
      }
    }

    // Policy's `when_thread_has_replies: approval_required` override can't be
    // evaluated by the middleware for hold_by_sender because the UID list
    // hasn't been expanded yet. Enforce the gate here, after expansion,
    // before any move. This tool cannot route a message to approval, so a
    // replied thread stays where it is and the rest of the sweep goes ahead.
    // It runs on dry_run too, so a preview shows the same split.
    let skippedReplied: Target[] = [];
    if (expandedTargets.length > 0) {
      updateIntentProgress(this.db, intent.id, 'checking_replies', {
        matched: expandedTargets.length,
        ...(batch ? { batch } : {}),
      });
      // Group by (account_id, mailbox). hold_by_sender only searches a single
      // mailbox per call today, but grouping matches repliedUids's expected
      // per-mailbox shape and future-proofs multi-mailbox cases.
      const groups = new Map<string, { accountId: string; mailbox: string; uids: number[] }>();
      for (const t of expandedTargets) {
        const mbx = t.mailbox ?? 'INBOX';
        const key = `${t.account_id}\u0000${mbx}`;
        const g = groups.get(key) ?? { accountId: t.account_id, mailbox: mbx, uids: [] };
        g.uids.push(t.uid);
        groups.set(key, g);
      }
      const replied = new Set<string>();
      for (const g of groups.values()) {
        // eslint-disable-next-line no-await-in-loop
        for (const uid of await this.repliedUids(g.accountId, g.mailbox, g.uids)) {
          replied.add(`${g.accountId}\u0000${g.mailbox}\u0000${uid}`);
        }
      }
      skippedReplied = expandedTargets.filter((t) =>
        replied.has(`${t.account_id}\u0000${t.mailbox ?? 'INBOX'}\u0000${t.uid}`)
      );
      if (skippedReplied.length === expandedTargets.length) {
        const errorPayload = {
          error: true,
          code: 'replies_present',
          message:
            `hold_by_sender matched ${expandedTargets.length} message(s), all in threads ` +
            `with replies. Policy requires approval for those, which this bulk tool cannot ` +
            `route, so nothing was held. Use hold_messages with specific UIDs, which gates ` +
            `replied threads through approval.`,
          matched_count: expandedTargets.length,
          hint: 'Use dry_run: true to preview, then hand-select UIDs via hold_messages.',
        };
        // Throw a sentinel so `executeImmediate` marks the intent `failed` with
        // a useful `error_detail` (instead of recording it as a successful
        // "Held messages from X" in the audit log). The payload still reaches
        // the caller: `executeImmediate`'s catch swallows this error and
        // returns `payload` as the result text.
        const summary =
          `Blocked: all ${expandedTargets.length} matched message(s) are in threads with replies. ` +
          `Hold specific UIDs via hold_messages.`;
        throw new HoldBySenderBlockedError(errorPayload, summary);
      }
    }

    // Every account erroring is not a zero. Nothing was searched, and reporting
    // no_match would tell the caller the mail isn't there.
    const failedAccounts = Object.keys(searchResult.errors);
    if (expandedTargets.length === 0 && failedAccounts.length === targetIds.length) {
      throw new Error(
        `Could not search any account: ${Object.values(searchResult.errors).join('; ')}`
      );
    }

    if (expandedTargets.length === 0) {
      // Matching nothing must not look like sweeping clean.
      //
      // This returned `executed` with an empty target list, which reads as "no
      // messages from that sender" — and in the reported case ten of them were
      // sitting in the inbox. Two very different things produce zero and they
      // have opposite fixes, so the payload has to say which:
      //
      //   - the server's FROM search matched nothing (retry with the full
      //     address; the match happens server-side and iCloud's only covers
      //     the first ~29 characters of the address, so a bare domain misses
      //     precisely when the address is long), or
      //   - it matched, and our own `before` cursor filtered every hit away.
      //
      // The second is only worth a round trip when a cursor was actually given.
      let unfilteredCount: number | null = null;
      if (before && from) {
        try {
          const probe = await fanOut({
            pool: this.pool,
            accountIds: targetIds,
            label: 'hold_by_sender:no-match-probe',
            fn: async (_accountId, imap) => (await imap.searchUids(mailbox, { from })).length,
          });
          unfilteredCount = Object.values(probe.per_account).reduce<number>(
            (sum, n) => sum + (typeof n === 'number' ? n : 0),
            0
          );
        } catch {
          // A diagnostic that can fail the operation it is diagnosing is worse
          // than no diagnostic.
          unfilteredCount = null;
        }
      }

      // If the cache could not be consulted, say so rather than letting the
      // zero read as verified. An unchecked zero and a cross-checked zero are
      // very different claims.
      const cacheNote = !crossCheck
        ? ''
        : crossCheck.recovered > 0
          ? // Nothing was held, so this is a no_match — but the cache says the
            // server is wrong, and that is the one thing the caller must not
            // miss. Reading this as "the inbox is clean" is the exact failure
            // the whole no_match change exists to prevent.
            ` The local cache found ${crossCheck.recovered} message(s) ${from ? 'from this sender' : 'on this list'} ` +
            'that the server\'s search missed, and they were NOT held because cache.mode ' +
            "is shadow. Run 'agent-mail cache on' to have sweeps include them."
          : crossCheck.checked
            ? ' The local cache was cross-checked and found nothing either, so this is a ' +
              'real zero rather than a search that missed.'
            : ` The local cache could NOT be cross-checked (${crossCheck.reason}), so a ` +
              'server-side search miss has not been ruled out. Enabling the cache would ' +
              'settle it.';

      const diagnosis = listId
        ? `No message in ${mailbox} matched List-Id "${listId}". Read one message from the ` +
          `list with read_thread and copy its list_id exactly.${cacheOnlyNote()}`
        : (unfilteredCount && unfilteredCount > 0
          ? `The server matched ${unfilteredCount} message(s) from this sender, but all of ` +
            `them are at or after before=${before}, so none were eligible. Widen or drop ` +
            '`before`.'
          : `No message in ${mailbox} matched from="${from}". The match is performed by the ` +
            'IMAP server, not locally, and not every server implements it as the substring ' +
            'match the spec describes. iCloud matches only within roughly the first 29 ' +
            'characters of the sender address, so a bare domain — or any fragment from the ' +
            'tail of a long address — silently returns nothing while the full address ' +
            'returns everything. If you can see messages from this sender, retry with the ' +
            'COMPLETE address, or a prefix of it (a prefix matches at any length). A bare ' +
            'domain is the least reliable form here, not the most.') +
        cacheNote;
      const notSearched =
        failedAccounts.length > 0 ? ` Not searched: ${failedAccounts.join(', ')}.` : '';

      // Queued sweeps never return this payload to anyone: the caller gets an
      // id and polls get_intent, which shows status and targets. Recording the
      // outcome is the only way a zero match is visible on that path at all.
      // The cross-check verdict must survive here too: a zero the cache
      // verified, a zero the cache contradicted, and a zero the cache never
      // saw (unusable, or a daemon whose startup-time mode predates the flip)
      // are three different findings, and this record is the only place a
      // queued sweep can distinguish them after the fact.
      updateIntentProgress(this.db, intent.id, 'no_match', {
        ...(from ? { from } : { list_id: listId }),
        mailbox,
        before,
        matched: 0,
        server_matched_ignoring_before: unfilteredCount,
        ...(crossCheck ? { cache_cross_check: crossCheck } : {}),
        ...(cacheOnlyAccounts.length > 0 ? { cache_only_accounts: cacheOnlyAccounts } : {}),
        ...(failedAccounts.length > 0 ? { per_account_errors: searchResult.errors } : {}),
      });

      const payload: {
        status: 'no_match';
        matched: 0;
        searched: { from?: string; list_id?: string; mailbox: string; before?: string };
        diagnosis: string;
        cache_cross_check?: {
          checked: boolean;
          recovered: number;
          applied: boolean;
          reason?: string;
        };
        accounts_searched: string[];
        accounts_available: string[];
        per_account_errors?: Record<string, string>;
        dry_run: boolean;
        total_messages: number;
        per_account: unknown[];
        moved?: unknown[];
      } = {
        status: 'no_match',
        matched: 0,
        searched: {
          ...(from ? { from } : { list_id: listId }),
          mailbox,
          ...(before ? { before } : {}),
        },
        diagnosis: `${diagnosis}${notSearched}`,
        ...(crossCheck ? { cache_cross_check: crossCheck } : {}),
        accounts_searched: searchResult.accounts_searched,
        accounts_available: allIds,
        dry_run: dryRun,
        total_messages: 0,
        per_account: [],
      };
      if (Object.keys(searchResult.errors).length > 0) {
        payload.per_account_errors = searchResult.errors;
      }
      if (includeSummary) payload.moved = [];
      return [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
    }

    const skipped = new Set(skippedReplied);
    const result = await this.holdTargets(
      intent,
      expandedTargets.filter((t) => !skipped.has(t)),
      { dryRun, includeSummary }
    );

    const hasSearchErrors = Object.keys(searchResult.errors).length > 0;
    if (!hasSearchErrors && !crossCheck && skippedReplied.length === 0) return result;
    const searchName = from ? 'FROM search' : 'List-Id search';

    const parsed = JSON.parse(result[0].text);
    // Merge search-time per_account_errors so the caller sees both search
    // failures and move failures in one place.
    if (hasSearchErrors) {
      parsed.per_account_errors = {
        ...(parsed.per_account_errors ?? {}),
        ...searchResult.errors,
      };
    }
    if (crossCheck) {
      parsed.cache_cross_check = crossCheck;
      if (crossCheck.recovered > 0) {
        // Named loudly rather than quietly absorbed: if this is silently
        // papered over, every dry_run preview still under-reports and nobody
        // learns the server's FROM search cannot be trusted for this sender.
        parsed.warning = crossCheck.applied
          ? `The IMAP server's ${searchName} missed ${crossCheck.recovered} message(s) that the ` +
            'local cache found; they were included in this hold. Treat server-side ' +
            `counts for this ${from ? 'sender' : 'list'} as a floor, not a total.`
          : `The IMAP server's ${searchName} missed ${crossCheck.recovered} message(s) that the ` +
            'local cache found. They were NOT held: cache.mode is shadow, which measures ' +
            "without changing behaviour. Run 'agent-mail cache on' to have sweeps include " +
            'them.';
      }
    }
    if (cacheOnlyAccounts.length > 0) {
      parsed.warning = `${parsed.warning ?? ''}${cacheOnlyNote()}`.trim();
    }
    if (skippedReplied.length > 0) {
      parsed.skipped_replied = {
        count: skippedReplied.length,
        targets: skippedReplied.slice(0, SKIPPED_REPLIED_MAX_TARGETS),
        note:
          'These are in threads with replies, or threads you wrote into, so they were left ' +
          'where they are. To hold one anyway, use hold_messages, which asks for approval.',
      };
    }
    updateIntentProgress(this.db, intent.id, dryRun ? 'previewed' : 'held', {
      total_messages: parsed.total_messages,
      ...(parsed.errors ? { errors: parsed.errors } : {}),
      ...(parsed.per_account_errors ? { per_account_errors: parsed.per_account_errors } : {}),
      ...(parsed.warning ? { warning: parsed.warning } : {}),
      ...(crossCheck ? { cache_cross_check: crossCheck } : {}),
      ...(parsed.skipped_replied ? { skipped_replied: parsed.skipped_replied } : {}),
    });
    return [{ type: 'text', text: JSON.stringify(parsed, null, 2) }];
  }

  /**
   * Run one undo step per account and return how many targets are back where
   * they belong. Undo is checked per account, so one account can finish while
   * another fails. When that happens the intent stays undoable, and a second
   * run counts what the first one moved because it finds it at the destination.
   */
  private async undoPerAccount(
    targets: IntentTargetRow[],
    step: (
      accountId: string,
      list: IntentTargetRow[],
      imap: ImapProvider,
      done: (rows: IntentTargetRow[]) => void
    ) => Promise<void>
  ): Promise<number> {
    const byAccount = new Map<string, IntentTargetRow[]>();
    for (const t of targets) {
      byAccount.set(t.account_id, [...(byAccount.get(t.account_id) ?? []), t]);
    }

    // A set, not a count: the pool re-runs a step after a dropped connection,
    // and a step that fails part way has still moved what it moved.
    const finished = new Set<IntentTargetRow>();
    const done = (rows: IntentTargetRow[]) => rows.forEach((row) => finished.add(row));
    const failures: string[] = [];
    for (const [accountId, list] of byAccount) {
      try {
        await this.pool.withConnection(accountId, (imap) => step(accountId, list, imap, done));
      } catch (error) {
        failures.push(`${accountId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `Undid ${finished.size} of ${targets.length} message(s). ${failures.join('; ')}. Run undo again to retry the rest.`
      );
    }
    return finished.size;
  }

  /** Which of these targets have a message in this mailbox, by Message-Id. */
  private async foundIn(
    imap: ImapProvider,
    mailbox: string,
    rows: IntentTargetRow[]
  ): Promise<IntentTargetRow[]> {
    const ids = rows.flatMap((r) => r.envelope_snapshot?.message_id ?? []);
    if (ids.length === 0) return [];
    const found = await imap.uidsByMessageId(mailbox, ids);
    return rows.filter((r) => found.has(r.envelope_snapshot?.message_id ?? ''));
  }

  /** UIDs in holding that a hold has on record, so no lookup can take them. */
  private heldUids(accountId: string): Set<number> {
    const rows = this.db
      .prepare(
        `SELECT it.destination_uid AS uid
           FROM intent_targets it
           JOIN intents i ON i.id = it.intent_id
          WHERE it.account_id = ?
            AND it.destination_uid IS NOT NULL
            AND i.tool IN ('hold_messages', 'hold_by_sender')`
      )
      .all(accountId) as Array<{ uid: number }>;
    return new Set(rows.map((r) => Number(r.uid)));
  }

  private async performUndo(
    intent: Intent,
    undoOp: { reverseAction: string; params: Record<string, unknown> }
  ): Promise<{ unconfirmed: number } | void> {
    // Multi-account undo: group targets by account and apply per-account
    if (undoOp.reverseAction === 'reverse_label') {
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
      return;
    }

    // Hold undo: put everything still in holding back in the inbox. Works from
    // the ledger for both hold tools: hold_by_sender's params have no targets,
    // and a target with no ledger row was gone before the move anyway.
    if (undoOp.reverseAction === 'move_back_to_inbox') {
      const targets = getIntentTargets(this.db, intent.id);
      const finished = await this.undoPerAccount(targets, async (accountId, list, imap, done) => {
        const holding = await imap.getMailboxPath('holding');
        const inbox = await imap.getMailboxPath('inbox');
        // Every target is checked before this account moves anything.
        const generations = new Map<string, number>();
        for (const t of list) {
          if (t.destination_uid === null) continue;
          await assertGenerationMatches(imap, holding, t.destination_uidvalidity, {
            logger: this.logger,
            cache: generations,
            context: 'undo:move_back_to_inbox',
          });
        }
        const located = await locateMessages(
          imap,
          holding,
          list.map((t) => ({
            uid: t.destination_uid,
            messageId: t.envelope_snapshot?.message_id,
          })),
          this.heldUids(accountId)
        );
        // Already in the inbox counts: an earlier undo's move may have landed
        // with its reply lost, or the message never left.
        done(await this.foundIn(imap, inbox, list.filter((_, i) => located[i] === null)));

        const uids = located.filter((uid) => uid !== null);
        if (uids.length === 0) return;
        await imap.moveMessages(uids, holding, inbox);
        this.echoToCache({
          accountId,
          mailbox: holding,
          uids,
          effect: 'moved',
          detail: { toMailbox: inbox },
        });
        done(list.filter((_, i) => located[i] !== null));
      });
      if (finished === 0) {
        throw new Error(
          `Nothing to undo: none of the ${targets.length} message(s) are in holding or the inbox.`
        );
      }
      return { unconfirmed: targets.length - finished };
    }

    // restore_messages undo: re-hold each message.
    // Each target row has:
    //   - uid: the agent-facing (source) UID
    //   - mailbox: where the restore put the message, and where it came from
    //   - destination_uid: its UID there after the restore
    if (undoOp.reverseAction === 'rehold_messages') {
      const targets = getIntentTargets(this.db, intent.id);
      const holds = getReversalLinks(this.db, intent.id).reverses;
      const finished = await this.undoPerAccount(targets, async (accountId, list, imap, done) => {
        const holding = await imap.getMailboxPath('holding');
        // Checked up front for the same reason as the hold undo.
        const generations = new Map<string, number>();
        for (const t of list) {
          if (t.destination_uid === null) continue;
          await assertGenerationMatches(imap, t.mailbox, t.destination_uidvalidity, {
            logger: this.logger,
            cache: generations,
            context: 'undo:rehold_messages',
          });
        }

        let holdingGeneration: number | undefined;
        try {
          holdingGeneration = (await imap.mailboxSnapshot(holding)).uidValidity;
        } catch {
          holdingGeneration = undefined;
        }

        for (const mailbox of new Set(list.map((t) => t.mailbox))) {
          const here = list.filter((t) => t.mailbox === mailbox);
          // By UID only. Nothing reserves mail outside holding, so a lookup
          // here could take a copy the user put in this folder.
          const located = await locateMessages(
            imap,
            mailbox,
            here.map((t) => ({ uid: t.destination_uid }))
          );
          // Already in holding counts, for the same reason as the hold undo.
          done(await this.foundIn(imap, holding, here.filter((_, i) => located[i] === null)));

          for (const [index, t] of here.entries()) {
            const uid = located[index];
            if (uid === null) continue;
            const { uidMap } = await imap.moveMessages([uid], mailbox, holding);
            this.echoToCache({
              accountId,
              mailbox,
              uids: [uid],
              effect: 'moved',
              detail: { toMailbox: holding },
            });
            done([t]);
            // Restoring again reads the hold's row, so it has to learn the
            // message's new UID in holding.
            const newUid = uidMap.get(uid);
            if (newUid === undefined) continue;
            for (const hold of holds) {
              updateIntentTargetDestinations(
                this.db,
                hold,
                accountId,
                new Map([[t.uid, newUid]]),
                mailbox,
                holdingGeneration
              );
            }
          }
        }
      });
      if (finished === 0) {
        throw new Error(
          `Nothing to undo: none of the ${targets.length} restored message(s) are where the restore put them, or in holding.`
        );
      }
      return { unconfirmed: targets.length - finished };
    }

    // draft_reply undo: delete the draft from the Drafts folder
    if (undoOp.reverseAction === 'delete_draft') {
      const draftId = intent.params.draft_id as number | undefined;
      if (draftId === undefined) {
        throw new Error('delete_draft: no draft_id in intent params');
      }
      await this.pool.withConnection(intent.account_id, async (imap) => {
        const draftsMailbox = await imap.getMailboxPath('drafts');
        await imap.deleteMessage(draftsMailbox, draftId);
      });
      return;
    }

    throw new Error(`Unknown undo action: ${undoOp.reverseAction}`);
  }
}


/** Turn the raw counters into the sentence a reader actually needs. */
function buildInterpretation(input: {
  busyCount: number;
  queuedCount: number;
  inProgressCount: number;
  stuckCount: number;
  longestElapsedMs: number;
  timeoutMs: number;
  worker: WorkerState;
}): string {
  // Ahead of everything else, but only when it is actually the explanation:
  // work is waiting and nothing is there to do it. A stopped daemon with an
  // empty queue is worth reporting in the `worker` block and is not the cause
  // of anything, and blaming it there would send people chasing it every time.
  if (!input.worker.alive && input.worker.queued_count > 0) {
    const waited = input.worker.oldest_queued_age_seconds ?? 0;
    return (
      `${input.worker.queued_count} action(s) are queued and nothing is running them — ` +
      `the daemon is not running (oldest has waited ${waited}s). ` +
      `Nothing has been lost; it will drain once the daemon starts. ${INSTALL_HINT}`
    );
  }
  if (input.stuckCount > 0) {
    const alive =
      input.inProgressCount > 0
        ? ` ${input.inProgressCount} other action(s) are in progress and healthy — do not re-run those.`
        : '';
    return (
      `${input.stuckCount} mutating action(s) are orphaned: no worker holds a lease on them ` +
      'and their progress has been stale for over ten minutes. A process died while they ' +
      'were in flight — they will never complete on their own. Re-run them; hold_by_sender ' +
      `is idempotent.${alive}`
    );
  }
  if (input.inProgressCount > 0 && input.busyCount === 0) {
    return (
      `${input.inProgressCount} action(s) are executing in the daemon (live lease or fresh ` +
      'progress). This process cannot see the daemon\'s IMAP connections, so its own pool ' +
      'reading idle is expected. Poll get_intent for completion; nothing needs re-running.'
    );
  }
  if (input.busyCount === 0 && input.stuckCount === 0) {
    return 'Idle. No IMAP operation in flight and nothing mid-execution.';
  }
  const seconds = Math.round(input.longestElapsedMs / 1000);
  const timeoutSeconds = Math.round(input.timeoutMs / 1000);
  return (
    `${input.busyCount} IMAP operation(s) in flight, longest running ${seconds}s ` +
    `(abandoned at ${timeoutSeconds}s). ${input.queuedCount} account(s) have queued work. ` +
    'Borrows are serialized per account, so anything queued behind a slow operation ' +
    'waits for it — a small job sitting at "executing" is usually queued, not stuck.'
  );
}


/**
 * Drop rows already emitted at the previous page's boundary timestamp.
 *
 * Mirrors the IMAP path: keep anything strictly older than the boundary, plus
 * boundary-timestamp rows whose (account_id, mailbox, uid) triple was not
 * already returned. UIDs are unique only per account/mailbox, so a scalar
 * comparison would drop cross-account rows that merely share a UID.
 */
export function applyCursorBoundary<
  T extends { account_id: string; mailbox: string; uid: number; envelope: { date: string } },
>(rows: T[], cursor: SearchCursor): T[] {
  const boundaryMs = new Date(cursor.before).getTime();
  const seen = new Set(
    cursor.boundary_seen.map((r) => `${r.account_id}\u0000${r.mailbox}\u0000${r.uid}`)
  );

  return rows.filter((row) => {
    const rowMs = new Date(row.envelope.date).getTime();
    if (rowMs < boundaryMs) return true;
    if (rowMs === boundaryMs) {
      return !seen.has(`${row.account_id}\u0000${row.mailbox}\u0000${row.uid}`);
    }
    return false;
  });
}
