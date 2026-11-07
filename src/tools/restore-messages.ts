import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { TargetsSchema } from './target.js';

const description =
  'Move messages out of the holding folder back to their original mailbox. Fully reversible by re-holding with `hold_messages`. This server cannot permanently delete messages. Uses the ledger envelope snapshot recorded at hold time to find each message\'s original mailbox; targets not present in the ledger are reported as per-target errors and skipped. Pass `dry_run: true` to preview. Pass the `uid` from the hold. `mailbox` is the mailbox it was held from, and is required only if that UID was held from two mailboxes. A failed hold can be restored too, because its move may have landed. A message no longer in holding is reported in `errors`, not `moved`.';

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
