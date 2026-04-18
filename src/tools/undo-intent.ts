import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

export const undoIntentTool: ToolDefinition = {
  name: 'undo_intent',
  description: 'Reverses a previously executed mutation within the 30-day undo window. Reversible tools: hold_messages (moves back to inbox), label_thread (flips add/remove), restore_messages (re-holds the messages), draft_reply (deletes the draft). Sent emails and unsubscribes cannot be undone.',
  inputSchema: z.object({
    intent_id: z.string().uuid().describe('The intent ID to undo'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
