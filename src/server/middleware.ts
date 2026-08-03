import type { Database } from '../ledger/sqlite.js';
import type { AccountConfig, PolicyConfig, ToolDefinition, RiskLevel } from '../types.js';
import type { Logger } from '../logger.js';
import type { Executor } from '../executor/executor.js';
import { evaluatePolicy } from '../policy/engine.js';
import { getAccount, getDefaultAccount } from '../provider/accounts.js';
import { describeIntent } from '../ledger/audit-summary.js';
import { DEFAULT_REVIEWER_PORT } from '../config.js';
import { buildApprovalUrl } from '../reviewer/urls.js';

/**
 * Tools that accept `background: true`.
 *
 * Only the bulk mutations. Read tools are bounded and cheap enough to await,
 * and queue_send is always gated — it already returns an intent id up front.
 */
const BACKGROUNDABLE_TOOLS = new Set(['hold_messages', 'hold_by_sender']);

export interface MiddlewareDeps {
  db: Database;
  executor: Executor;
  policy: PolicyConfig;
  accounts: AccountConfig[];
  logger: Logger;
  agentId: string;
  reviewerPort?: number;
}

export function wrapToolHandler(
  toolDef: ToolDefinition,
  deps: MiddlewareDeps
): (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
}> {
  return async (params: Record<string, unknown>) => {
    try {
      const canonicalToolName = toolDef.name;

      // Resolve principal account for the intent record. Migrated tools no
      // longer take `account_id` directly — derive a principal from targets[0]
      // or account_ids[0] when present, otherwise fall back to the default.
      const targets = params.targets as
        | Array<{ account_id: string }>
        | undefined;
      const accountIds = params.account_ids as string[] | undefined;
      const explicitAccountId = params.account_id as string | undefined;
      let resolvedAccountId: string;

      if (explicitAccountId) {
        getAccount(deps.accounts, explicitAccountId);
        resolvedAccountId = explicitAccountId;
      } else if (targets && targets.length > 0) {
        getAccount(deps.accounts, targets[0].account_id);
        resolvedAccountId = targets[0].account_id;
      } else if (accountIds && accountIds.length > 0) {
        getAccount(deps.accounts, accountIds[0]);
        resolvedAccountId = accountIds[0];
      } else {
        resolvedAccountId = getDefaultAccount(deps.accounts).id;
      }

      // Evaluate policy
      const policyContext: { threadHasReplies?: boolean } = {};

      // For hold_messages, inspect actual thread context before applying
      // policy. Targets group by (account_id, mailbox); if any group has a
      // reply, the whole call is treated as having replies.
      if (canonicalToolName === 'hold_messages' && Array.isArray(targets)) {
        const grouped = new Map<string, number[]>();
        for (const t of targets as Array<{
          account_id: string;
          uid: number;
          mailbox?: string;
        }>) {
          const mailbox = t.mailbox ?? 'INBOX';
          const key = `${t.account_id}\u0000${mailbox}`;
          const list = grouped.get(key) ?? [];
          list.push(t.uid);
          grouped.set(key, list);
        }
        for (const [key, uids] of grouped) {
          const [accountId, mailbox] = key.split('\u0000');
          // eslint-disable-next-line no-await-in-loop
          const has = await deps.executor.threadHasReplies(
            accountId,
            mailbox,
            uids
          );
          if (has) {
            policyContext.threadHasReplies = true;
            break;
          }
        }
      }

      const policyResult = evaluatePolicy(deps.policy, canonicalToolName, policyContext);

      if (policyResult.decision === 'gate') {
        // Create gated intent. Unknown-tool fallbacks carry a marker so the
        // reviewer daemon can suppress their noisy notifications.
        const toolParamsToStore = policyResult.unknownTool
          ? { ...params, __unknown_tool_fallback: true }
          : params;

        const intent = await deps.executor.createGatedIntent({
          tool: canonicalToolName,
          toolParams: toolParamsToStore,
          accountId: resolvedAccountId,
          agentId: deps.agentId,
          risk: policyResult.risk,
        });

        const reviewerPort = deps.reviewerPort ?? DEFAULT_REVIEWER_PORT;
        const humanSummary = describeIntent(canonicalToolName, params);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: 'pending',
                intent_id: intent.id,
                approval_url: buildApprovalUrl(reviewerPort, intent.id),
                human_summary: humanSummary,
                message: `Action queued for approval: ${toolDef.name}`,
                reason: policyResult.reason,
              }),
            },
          ],
        };
      }

      // Opt-in background execution for long bulk sweeps. Only honored for
      // tools that declare support: returning an id before the work happens is
      // only useful when the caller can poll for the outcome, and only safe
      // when the action records enough to be undone.
      if (params.background === true && BACKGROUNDABLE_TOOLS.has(canonicalToolName)) {
        const intent = await deps.executor.executeInBackground({
          tool: canonicalToolName,
          toolParams: params,
          accountId: resolvedAccountId,
          agentId: deps.agentId,
          risk: policyResult.risk,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: 'executing',
                intent_id: intent.id,
                message: `${toolDef.name} started in the background.`,
                how_to_check: `Poll get_intent with intent_id "${intent.id}" until status is "executed" or "failed".`,
                how_to_undo: `undo_intent with intent_id "${intent.id}" once it reports "executed".`,
              }),
            },
          ],
        };
      }

      // Execute immediately
      const { result } = await deps.executor.executeImmediate({
        tool: canonicalToolName,
        toolParams: params,
        accountId: resolvedAccountId,
        agentId: deps.agentId,
        risk: policyResult.risk,
      });

      return { content: result };
    } catch (error) {
      deps.logger.error(`Tool ${toolDef.name} failed`, {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: true,
              message: error instanceof Error ? error.message : String(error),
            }),
          },
        ],
      };
    }
  };
}
