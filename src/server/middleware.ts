import type { Database } from '../ledger/sqlite.js';
import type { AccountConfig, PolicyConfig, ToolDefinition, RiskLevel } from '../types.js';
import type { Logger } from '../logger.js';
import type { Executor } from '../executor/executor.js';
import { evaluatePolicy } from '../policy/engine.js';
import { getAccount, getDefaultAccount } from '../provider/accounts.js';

export interface MiddlewareDeps {
  db: Database;
  executor: Executor;
  policy: PolicyConfig;
  accounts: AccountConfig[];
  logger: Logger;
  agentId: string;
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
        // Create gated intent
        const intent = await deps.executor.createGatedIntent({
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
                status: 'pending',
                intent_id: intent.id,
                message: `Action queued for approval: ${toolDef.name}`,
                reason: policyResult.reason,
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
