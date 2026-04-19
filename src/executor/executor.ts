import type { Database } from '../ledger/sqlite.js';
import type { AccountConfig, Intent, RiskLevel } from '../types.js';
import { isListMail } from '../attention/signals.js';
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
import { insertIntentTargets, getIntentTargets } from '../ledger/intent-targets.js';
import { decodeCursor, encodeCursor } from '../lib/search-cursor.js';
import { projectResult } from '../lib/envelope-projection.js';

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
  target: { account_id: string; uid: number; mailbox: string };
}

interface SearchThreadsMultiPayload {
  accounts_searched: string[];
  accounts_available: string[];
  per_account_errors?: Record<string, string>;
  per_account_counts?: Record<string, number>;
  results: SearchThreadResult[];
  next_cursor?: string;
}

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
  /**
   * Intent IDs for which an undo is currently in flight. Used as an in-process
   * mutex to prevent two concurrent undo requests from both executing the
   * reversible IMAP side effect before the DB CAS has a chance to settle.
   */
  private readonly pendingUndos = new Set<string>();

  constructor(deps: ExecutorDeps) {
    this.db = deps.db;
    this.accounts = deps.accounts;
    this.pool = deps.pool;
    this.logger = deps.logger;
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
      const errorDetail = {
        message: error instanceof Error ? error.message : String(error),
      };
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
      throw error;
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
    const effectiveBefore = decodedCursor
      ? decodedCursor.before
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
        const baseResults = Array.from(merged.values()).map((r) => ({
          account_id: accountId,
          mailbox,
          ...r,
          from_address: r.envelope?.from?.address ?? '',
          from_name: r.envelope?.from?.name ?? null,
          list_id: r.list_id ?? null,
          list_unsubscribe: r.list_unsubscribe ?? null,
          is_list_mail: isListMail(r.list_unsubscribe, r.list_id),
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

    const allResults = Object.values(fanResult.per_account)
      .flat()
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
      payload.next_cursor = encodeCursor({
        before: oldest.envelope.date,
        lastUid: oldest.uid,
      });
    }
    return payload;
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
      const includeSummary = (intent.params.include_summary as boolean | undefined) ?? false;
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
              const { uidMap } = await imap.moveMessages(uids, mailbox, holding);
              for (const [src, dst] of uidMap) {
                combinedUidMap.set(src, dst);
              }
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

      // Persist targets to ledger on real (non-dry) runs
      if (!dryRun && allEnvelopes.length > 0) {
        insertIntentTargets(this.db, intent.id, allEnvelopes.map((e: any) => {
          const acctUidMap = allUidMaps.get(e.account_id);
          const destinationUid = acctUidMap?.get(e.uid) ?? null;
          return {
            account_id: e.account_id,
            uid: e.uid,
            mailbox: e.mailbox,
            envelope_snapshot: { subject: e.subject, from: e.from, original_mailbox: e.mailbox },
            destination_uid: destinationUid ?? undefined,
          };
        }));
      }

      // Strip internal `envelopes` and `uidMap` fields before building the public payload
      const perAccount = perAccountRaw.map(({ envelopes: _envs, uidMap: _um, ...rest }: any) => rest);
      const totalMessages = perAccount.reduce((n: number, a: any) => n + a.message_count, 0);

      const payload: {
        accounts_searched: string[];
        accounts_available: string[];
        per_account_errors?: Record<string, string>;
        dry_run: boolean;
        total_messages: number;
        per_account: typeof perAccount;
        moved?: Array<{ uid: number; account_id: string; subject: string; from: string; original_mailbox: string }>;
        reversible?: true;
        undo_hint?: { intent_id: string; method: string; window_expires_at: string };
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
        const holdHint = buildUndoHint({ intent_id: intent.id, tool: intent.tool, created_at: intent.created_at });
        if (holdHint) Object.assign(payload, holdHint);
      }
      return [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
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
           WHERE i.tool = 'hold_messages' AND i.status = 'executed'`
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
          const draftHint = buildUndoHint({ intent_id: intent.id, tool: intent.tool, created_at: intent.created_at });
          if (draftHint) Object.assign(draftPayload, draftHint);
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
    if (undoOp.reverseAction === 'move_back_to_inbox') {
      const targets = intent.params.targets as Target[];
      const grouped = parseTargets(targets);
      const ledgerTargets = getIntentTargets(this.db, intent.id);
      const ledgerByKey = new Map<string, number | null>();
      for (const lt of ledgerTargets) {
        ledgerByKey.set(`${lt.account_id}:${lt.uid}`, lt.destination_uid);
      }

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
