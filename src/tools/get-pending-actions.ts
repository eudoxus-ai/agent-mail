import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { getPendingIntents } from '../ledger/intents.js';

export const getPendingActionsTool: ToolDefinition = {
  name: 'get_pending_actions',
  description: 'List all actions awaiting human approval. Use this to check the status of queued sends or other gated operations.',
  inputSchema: z.object({
    account_id: z.string().optional().describe('Filter by account (omit for all)'),
  }),
  annotations: { readOnlyHint: true },
  async execute(params, context) {
    const pending = getPendingIntents(
      context.db,
      params.account_id as string | undefined
    );
    return {
      type: 'immediate',
      content: [
        {
          type: 'text',
          text: pending.length === 0
            ? 'No pending actions.'
            : JSON.stringify(
                pending.map((i) => ({
                  intent_id: i.id,
                  tool: i.tool,
                  account: i.account_id,
                  risk: i.risk,
                  params: i.params,
                  created_at: i.created_at,
                })),
                null,
                2
              ),
        },
      ],
    };
  },
};
