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
    });

    // Set executing status for crash consistency
    updateIntentStatus(this.db, intent.id, 'executing');
    logAudit(this.db, {
      intent_id: intent.id,
      account_id: params.accountId,
      action: 'executing',
      actor: 'policy',
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
        detail: errorDetail,
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
    });

    this.logger.info(
      `Gated intent created: ${intent.id} (${params.tool}) — awaiting approval`
    );

    return intent;
  }

  async approveAndExecute(intentId: string): Promise<Intent> {
    const intent = getIntent(this.db, intentId);
    if (!intent) throw new Error(`Intent not found: ${intentId}`);
    if (intent.status !== 'pending') {
      throw new Error(`Intent ${intentId} is ${intent.status}, not pending`);
    }

    updateIntentStatus(this.db, intentId, 'approved', {
      resolved_by: 'user',
    });
    logAudit(this.db, {
      intent_id: intentId,
      account_id: intent.account_id,
      action: 'approved',
      actor: 'user',
    });

    // Set executing for crash consistency
    updateIntentStatus(this.db, intentId, 'executing');
    logAudit(this.db, {
      intent_id: intentId,
      account_id: intent.account_id,
      action: 'executing',
      actor: 'user',
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
        detail: errorDetail,
      });
      throw error;
    }
  }

  async rejectIntent(intentId: string, reason?: string): Promise<Intent> {
    const intent = getIntent(this.db, intentId);
    if (!intent) throw new Error(`Intent not found: ${intentId}`);
    if (intent.status !== 'pending') {
      throw new Error(`Intent ${intentId} is ${intent.status}, not pending`);
    }

    updateIntentStatus(this.db, intentId, 'rejected', {
      resolved_by: 'user',
    });
    logAudit(this.db, {
      intent_id: intentId,
      account_id: intent.account_id,
      action: 'rejected',
      actor: 'user',
      detail: reason ? { reason } : undefined,
    });

    return getIntent(this.db, intentId)!;
  }

  async undoIntent(
    intentId: string
  ): Promise<{ success: boolean; message: string }> {
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

    try {
      await this.performUndo(intent, undoOp);

      updateIntentStatus(this.db, intentId, 'undone', {
        resolved_by: 'user',
      });
      logAudit(this.db, {
        intent_id: intentId,
        account_id: intent.account_id,
        action: 'undone',
        actor: 'user',
      });

      return { success: true, message: `Undone: ${intent.tool}` };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
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

    // All other tools use IMAP via the pool
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
