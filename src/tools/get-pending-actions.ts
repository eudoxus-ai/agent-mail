import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { getPendingIntents } from '../ledger/intents.js';

export const getPendingActionsTool: ToolDefinition = {
  name: 'get_pending_actions',
  description:
    'List all actions awaiting human approval. Use this to check the status of queued sends or other gated operations. Spans every configured account by default; pass `account_ids` to scope. Returns the standard multi-account envelope: `accounts_searched`, `accounts_available`, and `results`.',
  inputSchema: z.object({
    account_ids: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe('Filter by account ids. Omit for all configured accounts.'),
  }),
  annotations: { readOnlyHint: true },
  async execute(params, context) {
    const allIds = context.accounts.map((a) => a.id);
    const requestedIds = params.account_ids as string[] | undefined;
    const targetIds = requestedIds ?? allIds;

    if (requestedIds) {
      const unknown = requestedIds.filter((id) => !allIds.includes(id));
      if (unknown.length > 0) {
        throw new Error(`Unknown account_ids: ${unknown.join(', ')}`);
      }
    }

    const pending = getPendingIntents(context.db, requestedIds);

    const envelope = {
      accounts_searched: targetIds,
      accounts_available: allIds,
      results: pending.map((i) => ({
        intent_id: i.id,
        tool: i.tool,
        account: i.account_id,
        risk: i.risk,
        params: i.params,
        created_at: i.created_at,
      })),
    };

    return {
      type: 'immediate',
      content: [
        {
          type: 'text',
          text: JSON.stringify(envelope, null, 2),
        },
      ],
    };
  },
};
