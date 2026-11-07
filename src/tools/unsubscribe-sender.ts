import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { TargetSchema } from './target.js';

export const unsubscribeSenderTool: ToolDefinition = {
  name: 'unsubscribe_sender',
  description: 'Submit a list-unsubscribe request for a sender. Best-effort and cannot be automatically undone — the remote provider may honor or ignore the request. This server cannot send additional email on your behalf beyond the unsubscribe POST. Only supports HTTP unsubscribe URLs (RFC 2369); mailto-based unsubscribes are routed through queue_send.',
  inputSchema: z.object({
    target: TargetSchema.optional().describe(
      'A message from this sender. Its List-Unsubscribe header is read from the server, so no read_thread is needed first. Pass this or unsubscribe_url, not both.'
    ),
    unsubscribe_url: z.string().url().optional().describe('The List-Unsubscribe HTTP URL, if you already have it'),
    account_id: z.string().min(1).optional().describe('Account ID (with unsubscribe_url)'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
