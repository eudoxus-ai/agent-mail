import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

export const undoIntentTool: ToolDefinition = {
  name: 'undo_intent',
  description: 'Reverses a previously executed mutation within the 30-day undo window. Looks up the intent by id and applies the inverse operation (e.g. restoring messages moved to holding, removing a label that was added). Sent emails cannot be undone.',
  inputSchema: z.object({
    intent_id: z.string().uuid().describe('The intent ID to undo'),
  }),
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
