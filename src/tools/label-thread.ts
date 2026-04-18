import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { TargetsSchema } from './target.js';

export const labelThreadTool: ToolDefinition = {
  name: 'label_thread',
  description:
    'Add or remove a label. Fully reversible via `undo_intent` within 30 days. Applies per-account across the provided targets; partial failures are reported in per_account_errors.',
  inputSchema: z.object({
    targets: TargetsSchema,
    action: z.enum(['add', 'remove']).describe('Whether to add or remove the label'),
    label: z.string().min(1).describe('Label/flag name (e.g. \\\\Flagged, \\\\Seen, or custom)'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
