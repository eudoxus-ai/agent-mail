import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

export const queueSendTool: ToolDefinition = {
  name: 'queue_send',
  description: 'Queue an email for sending. This ALWAYS requires human approval before the email is actually sent. You can provide a draft_id (from draft_reply) or a raw to/subject/body.',
  inputSchema: z.object({
    to: z.string().optional().describe('Recipient email address'),
    subject: z.string().optional().describe('Email subject'),
    body: z.string().optional().describe('Email body text'),
    draft_id: z.number().optional().describe('Draft UID from draft_reply (alternative to to/subject/body)'),
    in_reply_to: z.string().optional().describe('Message-ID being replied to'),
    references: z.array(z.string()).optional().describe('Thread reference chain'),
    account_id: z.string().optional().describe('Account to send from'),
  }),
  annotations: { destructiveHint: true },
  async execute() {
    return { type: 'gated' };
  },
};
