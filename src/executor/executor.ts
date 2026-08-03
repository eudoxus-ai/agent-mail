import type { Database } from '../ledger/sqlite.js';
import type { AccountConfig, Intent, RiskLevel } from '../types.js';
import { isListMail } from '../attention/signals.js';
import { classifyCategory, type Category } from '../attention/category.js';
import type { Logger } from '../logger.js';
import type { ImapConnectionPool } from '../provider/imap-pool.js';
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
import { fanOut } from './fan-out.js';
import { parseTargets, type Target } from '../tools/target.js';
import {
  insertIntentTargets,
  getIntentTargets,
  updateIntentTargetDestinations,
} from '../ledger/intent-targets.js';
import { decodeCursor, encodeCursor } from '../lib/search-cursor.js';
import { projectResult } from '../lib/envelope-projection.js';
import { searchCache, countByAccount } from '../cache/query.js';
import { getCoverage, isServable } from '../cache/coverage.js';
import { diffResults, logDivergence } from '../cache/shadow.js';
import { invalidate } from '../cache/invalidate.js';
import { stageAttachment, AttachmentTooLargeError } from '../cache/attachment-store.js';
import { INLINE_MAX_BYTES } from '../tools/get-attachment.js';
import { DEFAULT_CACHE_CONFIG, type CacheConfig } from '../cache/config.js';

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
   * Create the intent, hand back its id, then run the action in the background.
   *
   * Bulk mailbox sweeps over a slow provider can outlast any client's patience,
   * and a client-side timeout is not a signal about what happened on the
   * server — the same timeout can mean "finished, response lost" or "never
   * ran". Either way the caller was left with no intent id, so the batch could
   * not be undone and the only recovery was to re-run and compare.
   *
   * Returning the id first makes the outcome knowable regardless: poll
   * `get_intent` for the terminal status. It also survives a process death,
   * because the intent is already on disk in `executing` — which is exactly
   * what distinguishes a crash from a slow provider after the fact.
   */
  async executeInBackground(params: {
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

    updateIntentStatus(this.db, intent.id, 'executing');
    logAudit(this.db, {
      intent_id: intent.id,
      account_id: params.accountId,
      action: 'executing',
      actor: 'policy',
      detail: buildAuditSummary(params.tool, 'executing', params.toolParams),
    });

    const running = getIntent(this.db, intent.id)!;

    // Deliberately not awaited. Every path inside settles the intent status,
    // and the catch-all guarantees no unhandled rejection can reach the top
    // level — an unhandled rejection here would kill the server, which is the
    // failure this whole change exists to make survivable.
    void (async () => {
      try {
        await this.performAction(running);
        const isDryRun = params.toolParams.dry_run === true;
        updateIntentStatus(this.db, running.id, 'executed', {
          resolved_by: 'policy',
          undo_token: isDryRun
            ? undefined
            : (generateUndoToken(params.tool, params.toolParams) ?? undefined),
          undo_expires_at: isDryRun ? undefined : (getUndoExpiry(params.tool) ?? undefined),
        });
        logAudit(this.db, {
          intent_id: running.id,
          account_id: params.accountId,
          action: 'executed',
          actor: 'policy',
          detail: buildAuditSummary(params.tool, 'executed', params.toolParams),
        });
      } catch (error) {
        const errorDetail =
          error instanceof HoldBySenderBlockedError
            ? error.errorDetail
            : { message: error instanceof Error ? error.message : String(error) };
        updateIntentStatus(this.db, running.id, 'failed', { error_detail: errorDetail });
        logAudit(this.db, {
          intent_id: running.id,
          account_id: params.accountId,
          action: 'failed',
          actor: 'policy',
          detail: buildAuditSummary(params.tool, 'failed', params.toolParams, errorDetail),
        });
        this.logger.warn('Background execution failed', {
          intent_id: running.id,
          tool: params.tool,
          error: errorDetail.message,
        });
      }
    })();

    return running;
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

      await this.performUndo(intent, undoOp);

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

      return { success: true, message: `Undone: ${intent.tool}` };
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
    return this.pool.withConnection(accountId, async (imap) => {
      const selected = await imap.fetchMessages(mailbox, uids);
      const selectedIds = new Set(
        selected.map((message) => message.messageId).filter(Boolean)
      );

      if (selectedIds.size === 0) {
        return false;
      }

      const context = await imap.fetchThreadContext(
        mailbox,
        Array.from(selectedIds),
        100
      );

      return context.some((message) => {
        if (uids.includes(message.uid)) {
          return false;
        }

        if (message.inReplyTo && selectedIds.has(message.inReplyTo)) {
          return true;
        }

        return message.references.some((reference) => selectedIds.has(reference));
      });
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
      return this.buildCachePayload(cacheAttempt, allIds, limit, intent);
    }

    const fanResult = await fanOut({
      pool: this.pool,
      accountIds: targetIds,
      fn: async (accountId, imap) => {
        const resultSets = query
          ? await Promise.all([
              imap.search(mailbox, { ...baseCriteria, subject: query }, imapFetchLimit),
              imap.search(mailbox, { ...baseCriteria, body: query }, imapFetchLimit),
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
    intent: Intent
  ): SearchThreadsMultiPayload {
    const fields = intent.params.fields as string[] | undefined;
    const rows = attempt.rows;

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
    const criteria = {
      since: intent.params.since ? new Date(intent.params.since as string) : undefined,
      before: intent.params.before ? new Date(intent.params.before as string) : undefined,
    };

    const fanResult = await fanOut({
      pool: this.pool,
      accountIds: targetIds,
      fn: async (accountId, imap) => {
        const raw = await imap.search(mailbox, criteria, scanLimit);
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
          if (r.list_unsubscribe) g.listMail += 1;
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

    const senders = Object.values(fanResult.per_account)
      .flat()
      .sort((a, b) => b.count - a.count);

    const payload: {
      accounts_searched: string[];
      accounts_available: string[];
      per_account_errors?: Record<string, string>;
      senders: typeof senders;
    } = {
      accounts_searched: fanResult.accounts_searched,
      accounts_available: allIds,
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
      const grouped = parseTargets(targets);
      const accountIds = Object.keys(grouped);
      const allIds = this.accounts.map((a) => a.id);
      const unknown = accountIds.filter((id) => !allIds.includes(id));
      if (unknown.length > 0) throw new Error(`Unknown account_ids in targets: ${unknown.join(', ')}`);

      // Index ledger snapshots by (account_id, uid) → original_mailbox + destination_uid + source intent.
      const rows = this.db
        .prepare(
          `SELECT it.intent_id, it.account_id, it.uid, it.envelope_snapshot, it.destination_uid
           FROM intent_targets it
           JOIN intents i ON i.id = it.intent_id
           WHERE i.tool IN ('hold_messages', 'hold_by_sender') AND i.status = 'executed'`
        )
        .all() as Array<{ intent_id: string; account_id: string; uid: number; envelope_snapshot: string | null; destination_uid: number | null }>;
      const byKey = new Map<string, { intent_id: string; original_mailbox: string; destination_uid: number | null }>();
      for (const r of rows) {
        const snap = r.envelope_snapshot ? JSON.parse(r.envelope_snapshot) : null;
        if (snap?.original_mailbox) {
          byKey.set(`${r.account_id}:${r.uid}`, {
            intent_id: r.intent_id,
            original_mailbox: snap.original_mailbox,
            destination_uid: r.destination_uid ?? null,
          });
        }
      }

      const moved: Array<{ uid: number; account_id: string; destination_mailbox: string }> = [];
      const errors: Array<{ uid: number; account_id: string; reason: string }> = [];
      const reverses = new Set<string>();
      // Track uidMaps per account for restore intent target persistence
      const restoreUidMaps = new Map<string, Map<number, number>>();

      for (const [accountId, list] of Object.entries(grouped)) {
        await this.pool.withConnection(accountId, async (imap) => {
          const holding = await imap.getMailboxPath('holding');
          const acctUidMap = new Map<number, number>();
          for (const t of list) {
            const entry = byKey.get(`${accountId}:${t.uid}`);
            if (!entry) {
              errors.push({ uid: t.uid, account_id: accountId, reason: 'original_mailbox unknown (not in ledger)' });
              continue;
            }
            // Use destination_uid (actual UID in holding) if available; fall back to uid for back-compat
            const holdingUid = entry.destination_uid ?? t.uid;
            if (!dryRun) {
              const { uidMap } = await imap.moveMessages([holdingUid], holding, entry.original_mailbox);
              this.echoToCache({
                accountId,
                mailbox: holding,
                uids: [holdingUid],
                effect: 'moved',
                detail: { toMailbox: entry.original_mailbox },
              });
              // Map the restored-to UID back under the source uid key for persistence
              const restoredUid = uidMap.get(holdingUid) ?? holdingUid;
              acctUidMap.set(t.uid, restoredUid);
            }
            moved.push({ uid: t.uid, account_id: accountId, destination_mailbox: entry.original_mailbox });
            reverses.add(entry.intent_id);
          }
          if (!dryRun) restoreUidMaps.set(accountId, acctUidMap);
        });
      }

      if (!dryRun && reverses.size > 0) {
        linkReversal(this.db, { restoreIntentId: intent.id, reverses: [...reverses] });
      }

      // Persist targets so the rehold_messages undo knows where messages landed.
      // destination_uid records the UID of the message after moving back to original_mailbox,
      // so a subsequent re-hold can find the message even if the IMAP server remapped UIDs.
      if (!dryRun && moved.length > 0) {
        insertIntentTargets(this.db, intent.id, moved.map((m) => {
          const acctUidMap = restoreUidMaps.get(m.account_id);
          const destinationUid = acctUidMap?.get(m.uid) ?? null;
          return {
            account_id: m.account_id,
            uid: m.uid,
            mailbox: m.destination_mailbox,
            envelope_snapshot: { subject: '', from: '', original_mailbox: m.destination_mailbox },
            destination_uid: destinationUid ?? undefined,
          };
        }));
      }

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
      const payload: Record<string, unknown> = {
        id: row.id,
        type: row.tool,
        created_at: row.created_at,
        account_id: row.account_id,
        status: row.status,
        targets,
      };
      if (links.reverses.length > 0) payload.reverses_intent_id = links.reverses;
      if (links.reversed_by) payload.reversed_by_intent_id = links.reversed_by;
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
        const payload = { ...msg, snippet };
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
          const { url, headers } = await assertSafeRemoteUrl(
            intent.params.unsubscribe_url as string
          );
          const response = await fetch(url, {
            method: 'POST',
            redirect: 'manual',
            signal: createTimedAbortSignal(),
            headers,
          });
          const unsubPayload: Record<string, unknown> = { message: `Unsubscribe request sent (HTTP ${response.status})` };
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

        const envelopeSnapshots: Array<{
          account_id: string;
          uid: number;
          mailbox: string;
          subject: string;
          from: string;
        }> = [];

        const holding = await imap.getMailboxPath('holding');

        // uidMap accumulates source→destination UID mappings for all mailboxes
        const combinedUidMap = new Map<number, number>();

        for (const [mailbox, uids] of byMailbox) {
          if (includeSummary || !dryRun) {
            const envs = await imap.fetchEnvelopes(mailbox, uids);
            for (const env of envs) {
              envelopeSnapshots.push({
                account_id: accountId,
                uid: env.uid,
                mailbox,
                subject: env.subject,
                from: env.from.address,
              });
            }
          }
          if (!dryRun) {
            // Write the restorable record BEFORE touching mail.
            //
            // Previously targets were persisted only after every account's
            // moves finished, so a process death mid-sweep left messages in
            // holding with no envelope snapshot and no original_mailbox —
            // restore_messages could not put them back. Writing first costs a
            // row that may turn out to be unused (see the dangling-target
            // cleanup below); getting it backwards costs recoverability.
            insertIntentTargets(
              this.db,
              intent.id,
              envelopeSnapshots
                .filter((e) => e.mailbox === mailbox)
                .map((e) => ({
                  account_id: e.account_id,
                  uid: e.uid,
                  mailbox: e.mailbox,
                  envelope_snapshot: {
                    subject: e.subject,
                    from: e.from,
                    original_mailbox: e.mailbox,
                  },
                }))
            );

            const { uidMap } = await imap.moveMessages(uids, mailbox, holding);
            for (const [src, dst] of uidMap) {
              combinedUidMap.set(src, dst);
            }

            // Confirm where they landed. A target still lacking a
            // destination_uid after the fact is the fingerprint of an
            // interrupted run.
            updateIntentTargetDestinations(this.db, intent.id, accountId, uidMap);
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
          perMailbox.push({ mailbox, message_count: uids.length, uids });
        }

        return {
          account_id: accountId,
          per_mailbox: perMailbox,
          envelopes: envelopeSnapshots,
          uidMap: combinedUidMap,
          message_count: perMailbox.reduce((n, m) => n + m.message_count, 0),
        };
      },
    });

    const perAccountRaw = Object.values(fanResult.per_account);

    // Aggregate envelopes from all accounts (internal scaffolding — not exposed)
    const allEnvelopes = perAccountRaw.flatMap((a: any) => a.envelopes ?? []);

    // Aggregate uidMaps from all per-account results
    const allUidMaps: Map<string, Map<number, number>> = new Map();
    for (const a of perAccountRaw as any[]) {
      if (a.account_id && a.uidMap instanceof Map) {
        allUidMaps.set(a.account_id, a.uidMap);
      }
    }

    // Targets were already written inside the fan-out, before each move, and
    // their destination UIDs confirmed immediately after. This pass only
    // reconciles anything the per-mailbox path missed — a server that reports
    // no UID mapping, or an account whose fan-out leg failed after the ledger
    // write. Upsert semantics make it safe to repeat.
    if (!dryRun && allEnvelopes.length > 0) {
      for (const [accountId, uidMap] of allUidMaps) {
        updateIntentTargetDestinations(this.db, intent.id, accountId, uidMap);
      }
    }

    // Strip internal `envelopes` and `uidMap` fields before building the public payload
    const perAccount = perAccountRaw.map(
      ({ envelopes: _envs, uidMap: _um, ...rest }: any) => rest
    );
    const totalMessages = perAccount.reduce(
      (n: number, a: any) => n + a.message_count,
      0
    );

    const payload: {
      accounts_searched: string[];
      accounts_available: string[];
      per_account_errors?: Record<string, string>;
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
    if (Object.keys(fanResult.errors).length > 0) {
      payload.per_account_errors = fanResult.errors;
    }
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

  /**
   * Expand a sender+before search into UIDs, then hold them via holdTargets.
   * Reuses the IMAP search path so we don't duplicate FROM/BEFORE semantics.
   */
  private async holdBySender(
    intent: Intent
  ): Promise<Array<{ type: 'text'; text: string }>> {
    const from = intent.params.from as string;
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
      before: before ? new Date(before) : undefined,
    };

    const searchResult = await fanOut({
      pool: this.pool,
      accountIds: targetIds,
      fn: async (_accountId, imap) => {
        const rows = await imap.search(mailbox, criteria, limit);
        return rows.map((r) => r.uid);
      },
    });

    const expandedTargets: Target[] = [];
    for (const accountId of searchResult.accounts_searched) {
      const uids = searchResult.per_account[accountId] ?? [];
      for (const uid of uids) {
        expandedTargets.push({ account_id: accountId, uid, mailbox });
      }
    }

    // Policy's `when_thread_has_replies: approval_required` override can't be
    // evaluated by the middleware for hold_by_sender because the UID list
    // hasn't been expanded yet. Enforce the gate here, after expansion,
    // before any move. Fail-closed with a structured error so Claude Chat
    // (or any caller) can relay a specific next-step hint. We also run this
    // check on dry_run to surface the warning in previews.
    if (expandedTargets.length > 0) {
      // Group by (account_id, mailbox). hold_by_sender only searches a single
      // mailbox per call today, but grouping matches threadHasReplies's
      // expected per-mailbox shape and future-proofs multi-mailbox cases.
      const groups = new Map<string, { accountId: string; mailbox: string; uids: number[] }>();
      for (const t of expandedTargets) {
        const mbx = t.mailbox ?? 'INBOX';
        const key = `${t.account_id}\u0000${mbx}`;
        const g = groups.get(key) ?? { accountId: t.account_id, mailbox: mbx, uids: [] };
        g.uids.push(t.uid);
        groups.set(key, g);
      }
      let repliedGroupCount = 0;
      for (const g of groups.values()) {
        // eslint-disable-next-line no-await-in-loop
        const has = await this.threadHasReplies(g.accountId, g.mailbox, g.uids);
        if (has) repliedGroupCount += 1;
      }
      if (repliedGroupCount > 0) {
        const errorPayload = {
          error: true,
          code: 'replies_present',
          message:
            `hold_by_sender matched ${expandedTargets.length} message(s) ` +
            `in ${repliedGroupCount} replied thread group(s). Policy requires ` +
            `approval for threads with replies, which this bulk tool cannot route. ` +
            `Re-run with specific UIDs via hold_messages (which gates replied ` +
            `threads through approval), or inspect the expanded UID list via ` +
            `dry_run: true first.`,
          matched_count: expandedTargets.length,
          replied_thread_count: repliedGroupCount,
          hint: 'Use dry_run: true to preview, then hand-select UIDs via hold_messages.',
        };
        // Throw a sentinel so `executeImmediate` marks the intent `failed` with
        // a useful `error_detail` (instead of recording it as a successful
        // "Held messages from X" in the audit log). The payload still reaches
        // the caller: `executeImmediate`'s catch swallows this error and
        // returns `payload` as the result text.
        const summary =
          `Blocked: ${repliedGroupCount} matched thread group(s) have replies. ` +
          `Re-run with specific UIDs via hold_messages, or preview with dry_run: true.`;
        throw new HoldBySenderBlockedError(errorPayload, summary);
      }
    }

    if (expandedTargets.length === 0) {
      const payload: {
        accounts_searched: string[];
        accounts_available: string[];
        per_account_errors?: Record<string, string>;
        dry_run: boolean;
        total_messages: number;
        per_account: unknown[];
        moved?: unknown[];
      } = {
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

    const result = await this.holdTargets(intent, expandedTargets, {
      dryRun,
      includeSummary,
    });

    // Merge search-time per_account_errors so the caller sees both search
    // failures and move failures in one place.
    if (Object.keys(searchResult.errors).length > 0) {
      const parsed = JSON.parse(result[0].text);
      parsed.per_account_errors = {
        ...(parsed.per_account_errors ?? {}),
        ...searchResult.errors,
      };
      return [{ type: 'text', text: JSON.stringify(parsed, null, 2) }];
    }
    return result;
  }

  private async performUndo(
    intent: Intent,
    undoOp: { reverseAction: string; params: Record<string, unknown> }
  ): Promise<void> {
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

    // Multi-account hold undo: group targets by account, restore to inbox
    // Use destination_uid from ledger so we find the correct UID in holding.
    //
    // Targets come from intent.params for hold_messages (the caller passed a
    // Target[] in). For hold_by_sender, intent.params has no targets because
    // the UID list was expanded at execution time from a FROM/BEFORE search —
    // so we fall back to the `intent_targets` ledger table, which holdTargets
    // always persists on non-dry runs. Both paths then look up destination_uid
    // from the same ledger rows.
    if (undoOp.reverseAction === 'move_back_to_inbox') {
      const ledgerTargets = getIntentTargets(this.db, intent.id);
      const ledgerByKey = new Map<string, number | null>();
      for (const lt of ledgerTargets) {
        ledgerByKey.set(`${lt.account_id}:${lt.uid}`, lt.destination_uid);
      }

      const paramsTargets = intent.params.targets as Target[] | undefined;
      const effectiveTargets: Target[] = Array.isArray(paramsTargets)
        ? paramsTargets
        : ledgerTargets.map((lt) => ({
            account_id: lt.account_id,
            uid: lt.uid,
            mailbox: lt.envelope_snapshot?.original_mailbox ?? lt.mailbox,
          }));
      const grouped = parseTargets(effectiveTargets);

      for (const [accountId, list] of Object.entries(grouped)) {
        await this.pool.withConnection(accountId, async (imap) => {
          const holding = await imap.getMailboxPath('holding');
          const inbox = await imap.getMailboxPath('inbox');
          // Build list of actual UIDs in holding (using destination_uid if available)
          const holdingUids = list.map((t) => {
            const destUid = ledgerByKey.get(`${accountId}:${t.uid}`);
            return destUid ?? t.uid;
          });
          await imap.moveMessages(holdingUids, holding, inbox);
          this.echoToCache({
            accountId,
            mailbox: holding,
            uids: holdingUids,
            effect: 'moved',
            detail: { toMailbox: inbox },
          });
        });
      }
      return;
    }

    // restore_messages undo: re-hold each UID back to the holding folder.
    // Each target row has:
    //   - uid: the agent-facing (source) UID
    //   - destination_uid: the actual UID after restore moved the message to original_mailbox
    //     (may differ from uid if IMAP server remapped on move)
    //   - envelope_snapshot.original_mailbox / mailbox: the mailbox where the message now lives
    if (undoOp.reverseAction === 'rehold_messages') {
      const targets = getIntentTargets(this.db, intent.id);
      const byAccount = new Map<string, Array<{ uid: number; currentMailbox: string }>>();
      for (const t of targets) {
        const list = byAccount.get(t.account_id) ?? [];
        // Use destination_uid (actual UID in original_mailbox) if available; fall back to uid
        const actualUid = t.destination_uid ?? t.uid;
        list.push({ uid: actualUid, currentMailbox: t.envelope_snapshot?.original_mailbox ?? t.mailbox });
        byAccount.set(t.account_id, list);
      }
      for (const [accountId, list] of byAccount) {
        await this.pool.withConnection(accountId, async (imap) => {
          const holding = await imap.getMailboxPath('holding');
          for (const { uid, currentMailbox } of list) {
            await imap.moveMessages([uid], currentMailbox, holding);
            this.echoToCache({
              accountId,
              mailbox: currentMailbox,
              uids: [uid],
              effect: 'moved',
              detail: { toMailbox: holding },
            });
          }
        });
      }
      return;
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
