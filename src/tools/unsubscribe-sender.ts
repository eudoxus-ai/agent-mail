import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

export const unsubscribeSenderTool: ToolDefinition = {
  name: 'unsubscribe_sender',
  description: 'Unsubscribe from a mailing list using the List-Unsubscribe header (RFC 2369). Only supports HTTP unsubscribe URLs. Mailto-based unsubscribes are routed through queue_send.',
  inputSchema: z.object({
    unsubscribe_url: z.string().url().describe('The List-Unsubscribe HTTP URL'),
    account_id: z.string().min(1).optional().describe('Account ID'),
  }),
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
