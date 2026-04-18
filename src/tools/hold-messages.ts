import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { TargetsSchema } from './target.js';

const description =
  'Move messages to the holding folder. Fully reversible: messages move to `agent-mail-holding` and can be restored via `restore_messages` or `undo_intent` within 30 days. This server cannot permanently delete messages. Operates at the message/UID level — only the UIDs you pass are moved; thread siblings are NOT auto-expanded. Targets are account-qualified, so a single call can hold across accounts. Pass `dry_run: true` to preview the per-account/per-mailbox UID list without moving anything. Pass `include_summary: true` to receive per-message subject/from/original_mailbox in the response.';

const inputSchema = z.object({
  targets: TargetsSchema,
  dry_run: z.boolean().optional().describe('If true, preview without moving.'),
  include_summary: z
    .boolean()
    .optional()
    .describe('If true, response includes moved[{uid, account_id, subject, from, original_mailbox}].'),
});

export const holdMessagesTool: ToolDefinition = {
  name: 'hold_messages',
  description,
  inputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
