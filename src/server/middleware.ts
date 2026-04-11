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
      // Resolve account
      const accountId = params.account_id as string | undefined;
      let resolvedAccountId: string;

      if (accountId) {
        getAccount(deps.accounts, accountId); // validates existence
        resolvedAccountId = accountId;
      } else {
        resolvedAccountId = getDefaultAccount(deps.accounts).id;
      }

      // Evaluate policy
      const policyContext: { threadHasReplies?: boolean } = {};

      // For quarantine_thread, we need to check if thread has replies (eager evaluation)
      if (toolDef.name === 'quarantine_thread' && params.uids) {
        // Simplified: if multiple UIDs, thread has replies
        const uids = params.uids as number[];
        policyContext.threadHasReplies = uids.length > 1;
      }

      const policyResult = evaluatePolicy(deps.policy, toolDef.name, policyContext);

      if (policyResult.decision === 'gate') {
        // Create gated intent
        const intent = await deps.executor.createGatedIntent({
          tool: toolDef.name,
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
        tool: toolDef.name,
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
