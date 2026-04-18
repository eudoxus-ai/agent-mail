import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { TargetSchema } from './target.js';

export const readThreadTool: ToolDefinition = {
  name: 'read_thread',
  description:
    'Fetch the full body of a single message identified by an account-qualified target.',
  inputSchema: z.object({
    target: TargetSchema.describe('Account-qualified message reference'),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
