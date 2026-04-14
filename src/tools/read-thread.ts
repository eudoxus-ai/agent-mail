import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

export const readThreadTool: ToolDefinition = {
  name: 'read_thread',
  description: 'Read a specific email message by UID. Returns the full message including headers, body text, and threading information.',
  inputSchema: z.object({
    uid: z.number().int().positive().describe('Message UID to read'),
    account_id: z.string().min(1).optional().describe('Account ID'),
    mailbox: z.string().min(1).optional().describe('Mailbox (default: INBOX)'),
  }),
  annotations: { readOnlyHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
