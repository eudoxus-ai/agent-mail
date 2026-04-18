import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { TargetsSchema } from './target.js';

const description =
  'Move messages to quarantine (reversible "delete"). Operates at the message/UID level — only the UIDs you pass are moved; thread siblings are NOT auto-expanded (call search_threads or read_thread first if you need the full thread). Targets are account-qualified, so a single call can quarantine across accounts. Pass dry_run: true to preview the per-account/per-mailbox UID list without moving anything. Messages move to agent-mail-quarantine and can be undone within 30 days.';

const inputSchema = z.object({
  targets: TargetsSchema,
  dry_run: z
    .boolean()
    .optional()
    .describe('If true, return the blast-radius report without moving messages.'),
});

export const quarantineMessagesTool: ToolDefinition = {
  name: 'quarantine_messages',
  description,
  inputSchema,
  annotations: { destructiveHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};

export const quarantineThreadTool: ToolDefinition = {
  name: 'quarantine_thread',
  description: `[DEPRECATED: use quarantine_messages] ${description}`,
  inputSchema,
  annotations: { destructiveHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
