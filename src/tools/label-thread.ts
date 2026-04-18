import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { TargetsSchema } from './target.js';

export const labelThreadTool: ToolDefinition = {
  name: 'label_thread',
  description:
    'Add or remove a label on messages, addressed by account-qualified targets. Applies per-account in parallel; partial failures are reported in per_account_errors.',
  inputSchema: z.object({
    targets: TargetsSchema,
    action: z.enum(['add', 'remove']).describe('Whether to add or remove the label'),
    label: z.string().min(1).describe('Label/flag name (e.g. \\\\Flagged, \\\\Seen, or custom)'),
  }),
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
