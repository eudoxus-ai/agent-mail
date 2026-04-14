import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

export const draftReplyTool: ToolDefinition = {
  name: 'draft_reply',
  description: 'Create a draft reply. The draft is saved in the Drafts folder but NOT sent. Use queue_send to send it.',
  inputSchema: z.object({
    to: z.string().email().describe('Recipient email address'),
    subject: z.string().min(1).describe('Email subject'),
    body: z.string().min(1).describe('Email body text'),
    in_reply_to: z.string().min(1).optional().describe('Message-ID of the message being replied to'),
    references: z.array(z.string().min(1)).min(1).optional().describe('Message-IDs in the thread chain'),
    account_id: z.string().min(1).optional().describe('Account to draft from'),
  }),
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
