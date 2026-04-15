import type { Database } from '../ledger/sqlite.js';
import type { AccountConfig, Intent, RiskLevel } from '../types.js';
import { isAutomatedSender } from '../attention/signals.js';
import type { Logger } from '../logger.js';
import type { ImapConnectionPool } from '../provider/imap-pool.js';
import type { ImapProvider } from '../provider/imap.js';
import {
  createIntent,
  getIntent,
  updateIntentStatus,
  updateIntentStatusIfCurrent,
  withImmediateTransaction,
} from '../ledger/intents.js';
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

      const undoToken = generateUndoToken(params.tool, params.toolParams);
      const undoExpiry = getUndoExpiry(params.tool);

      updateIntentStatus(this.db, intent.id, 'executed', {
        resolved_by: 'policy',
        undo_token: undoToken,
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

  async approveAndExecute(intentId: string): Promise<Intent> {
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

      const undoToken = generateUndoToken(intent.tool, intent.params);
      const undoExpiry = getUndoExpiry(intent.tool);

      updateIntentStatus(this.db, intentId, 'executed', {
        resolved_by: 'user',
        undo_token: undoToken,
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

  private async searchThreads(
    intent: Intent,
    imap: ImapProvider
  ): Promise<Array<{
    uid: number;
    envelope: {
      message_id: string;
      subject: string;
      from: { address: string; name: string | null };
      date: string;
    };
    snippet: string;
    flags: string[];
    is_automated: boolean;
  }>> {
    const mailbox = (intent.params.mailbox as string) ?? 'INBOX';
    const baseCriteria = {
      from: intent.params.from as string | undefined,
      to: intent.params.to as string | undefined,
      subject: intent.params.subject as string | undefined,
      since: intent.params.since
        ? new Date(intent.params.since as string)
        : undefined,
    };
    const limit = (intent.params.limit as number) ?? 20;
    const query = intent.params.query as string | undefined;
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

    return Array.from(merged.values())
      .sort(
        (a, b) =>
          new Date(b.envelope.date).getTime() - new Date(a.envelope.date).getTime()
      )
      .slice(0, limit)
      .map((result) => ({
        ...result,
        is_automated: isAutomatedSender(result.envelope.from.address),
      }));
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

    // All other tools use IMAP via the pool
    return this.pool.withConnection(intent.account_id, async (imap) => {
      switch (intent.tool) {
        case 'search_threads': {
          const results = await this.searchThreads(intent, imap);
          return [{ type: 'text', text: JSON.stringify(results, null, 2) }];
        }

        case 'read_thread': {
          const uid = intent.params.uid as number;
          const mailbox = (intent.params.mailbox as string) ?? 'INBOX';
          const msg = await imap.fetchMessage(mailbox, uid);
          return [{ type: 'text', text: JSON.stringify(msg, null, 2) }];
        }

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
}
