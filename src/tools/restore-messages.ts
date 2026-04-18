import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { TargetsSchema } from './target.js';

const description =
  'Move messages out of the holding folder back to their original mailbox. Fully reversible by re-holding with `hold_messages`. This server cannot permanently delete messages. Uses the ledger envelope snapshot recorded at hold time to find each message\'s original mailbox; targets not present in the ledger are reported as per-target errors and skipped. Pass `dry_run: true` to preview.';

const inputSchema = z.object({
  targets: TargetsSchema,
  dry_run: z.boolean().optional(),
});

export const restoreMessagesTool: ToolDefinition = {
  name: 'restore_messages',
  description,
  inputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
