import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

const queueSendSchema = z.object({
  to: z.string().email().optional().describe('Recipient email address'),
  subject: z.string().min(1).optional().describe('Email subject'),
  body: z.string().min(1).optional().describe('Email body text'),
  draft_id: z.number().int().positive().optional().describe('Draft UID from draft_reply (alternative to to/subject/body)'),
  in_reply_to: z.string().min(1).optional().describe('Message-ID being replied to'),
  references: z.array(z.string().min(1)).min(1).optional().describe('Thread reference chain'),
  account_id: z.string().min(1).optional().describe('Account to send from'),
});

export const queueSendTool: ToolDefinition = {
  name: 'queue_send',
  description: 'Queue an email for human review. ALWAYS requires human approval. This server cannot send mail; queued messages require explicit human approval through a separate flow before transmission. You can provide a draft_id (from draft_reply) or a raw to/subject/body.',
  inputSchema: queueSendSchema,
  validate(params) {
    const parsed = queueSendSchema.parse(params);
    const hasDraft = parsed.draft_id !== undefined;
    const hasInline =
      parsed.to !== undefined ||
      parsed.subject !== undefined ||
      parsed.body !== undefined;

    if (hasDraft === hasInline) {
      throw new Error(
        'queue_send requires exactly one mode: either draft_id or to/subject/body'
      );
    }

    if (hasInline && (!parsed.to || !parsed.subject || !parsed.body)) {
      throw new Error(
        'queue_send inline mode requires to, subject, and body'
      );
    }

    return parsed;
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  async execute() {
    return { type: 'gated' };
  },
};
