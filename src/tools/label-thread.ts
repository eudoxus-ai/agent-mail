import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

export const labelThreadTool: ToolDefinition = {
  name: 'label_thread',
  description: 'Add or remove a flag/label on messages. Use "add" to apply or "remove" to clear.',
  inputSchema: z.object({
    uids: z.array(z.number()).describe('Message UIDs to modify'),
    action: z.enum(['add', 'remove']).describe('Whether to add or remove the label'),
    label: z.string().describe('Label/flag name (e.g. \\\\Flagged, \\\\Seen, or custom)'),
    account_id: z.string().optional().describe('Account ID'),
    mailbox: z.string().optional().describe('Mailbox (default: INBOX)'),
  }),
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
