import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

export const getIntentTool: ToolDefinition = {
  name: 'get_intent',
  description:
    'Return the full record of a past intent: type, account, targets (with subject/from/original_mailbox captured at intent time), status, and reversal links. Use this to build partial-undo logic: fetch the intent, pick which targets to keep held, and call restore_messages on the rest.',
  inputSchema: z.object({ intent_id: z.string().min(1) }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  async execute() { return { type: 'immediate', content: [] }; },
};
