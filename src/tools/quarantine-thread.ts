import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { TargetsSchema } from './target.js';

export const quarantineThreadTool: ToolDefinition = {
  name: 'quarantine_thread',
  description:
    'Move messages to quarantine (reversible "delete"). Targets are account-qualified, so a single call can quarantine across accounts. Pass dry_run: true to preview the blast radius (per-account/per-mailbox message counts and full uid list) without actually moving anything. Messages move to an agent-mail-quarantine folder and can be undone within 30 days.',
  inputSchema: z.object({
    targets: TargetsSchema,
    dry_run: z
      .boolean()
      .optional()
      .describe('If true, return the blast-radius report without moving messages.'),
  }),
  annotations: { destructiveHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
