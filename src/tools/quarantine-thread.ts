import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

export const quarantineThreadTool: ToolDefinition = {
  name: 'quarantine_thread',
  description: 'Move messages to quarantine (reversible "delete"). Messages are moved to an agent-mail-quarantine folder and can be undone within 30 days.',
  inputSchema: z.object({
    uids: z.array(z.number()).describe('Message UIDs to quarantine'),
    account_id: z.string().optional().describe('Account ID'),
    mailbox: z.string().optional().describe('Source mailbox (default: INBOX)'),
  }),
  annotations: { destructiveHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
