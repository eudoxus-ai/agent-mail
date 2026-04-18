import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { TargetsSchema } from './target.js';

export const quarantineThreadTool: ToolDefinition = {
  name: 'quarantine_thread',
  description:
    'Move messages to quarantine (reversible "delete"). Targets are account-qualified, so a single call can quarantine across accounts. Operates at the UID level — only the UIDs you pass are moved; sibling messages in the same thread are NOT auto-expanded (call search_threads or read_thread first if you need the full thread). Pass dry_run: true to preview the per-account/per-mailbox uid list without actually moving anything. Messages move to an agent-mail-quarantine folder and can be undone within 30 days.',
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
