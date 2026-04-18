import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

export const unsubscribeSenderTool: ToolDefinition = {
  name: 'unsubscribe_sender',
  description: 'Submit a list-unsubscribe request for a sender. Best-effort and cannot be automatically undone — the remote provider may honor or ignore the request. This server cannot send additional email on your behalf beyond the unsubscribe POST. Only supports HTTP unsubscribe URLs (RFC 2369); mailto-based unsubscribes are routed through queue_send.',
  inputSchema: z.object({
    unsubscribe_url: z.string().url().describe('The List-Unsubscribe HTTP URL'),
    account_id: z.string().min(1).optional().describe('Account ID'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
