import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

export const undoIntentTool: ToolDefinition = {
  name: 'undo_intent',
  description: 'Reverse a previously executed action by its intent ID. Only works for reversible actions (quarantine, label) within the undo window (30 days). Sent emails cannot be undone.',
  inputSchema: z.object({
    intent_id: z.string().describe('The intent ID to undo'),
  }),
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
