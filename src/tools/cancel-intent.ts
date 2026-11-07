import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

export const cancelIntentTool: ToolDefinition = {
  name: 'cancel_intent',
  description:
    'Cancel queued work that has not started, such as sweeps filed with the wrong scope. Reports per id whether it was cancelled. Only `queued` intents can be cancelled: one already executing keeps running, and finished work is reversed with undo_intent. Cancelled intents show status "rejected". Nothing is moved, so there is nothing to undo.',
  inputSchema: z.object({
    intent_ids: z.array(z.string().min(1)).min(1).max(1000).describe('Intents to cancel.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
