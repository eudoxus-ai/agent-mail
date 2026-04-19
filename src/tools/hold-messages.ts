import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { TargetsSchema } from './target.js';

const description =
  'Move messages to the `agent-mail-holding` folder. REVERSIBLE for 30 days via restore_messages or undo_intent — this server cannot permanently delete, so it is safe to be aggressive. Operates at the message/UID level — only the UIDs you pass are moved; thread siblings are NOT auto-expanded. Targets are account-qualified, so a single call can hold across accounts. Pass `dry_run: true` to preview the per-account/per-mailbox UID list without moving anything. `include_summary` defaults to true and returns per-message subject/from/original_mailbox in the response.';

const inputSchema = z.object({
  targets: TargetsSchema,
  dry_run: z.boolean().optional().describe('If true, preview without moving.'),
  include_summary: z
    .boolean()
    .optional()
    .default(true)
    .describe('Default true: response includes moved[{uid, account_id, subject, from, original_mailbox}]. Set false to skip if you only need UIDs.'),
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
