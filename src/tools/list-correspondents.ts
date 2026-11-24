import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

export const listCorrespondentsTool: ToolDefinition = {
  name: 'list_correspondents',
  description:
    'The people you exchange mail with, from the local cache. One row per address across the requested accounts: `address`, `name` (the most recent display name), `received` (messages from them in any cached mailbox except sent ones), `sent` (messages in your sent mailboxes with them in To or Cc), `first_contact_at`, `last_received_at`, `last_sent_at`, `last_direction` (`received` or `sent`), `threads` (distinct conversations either way) and `is_list_sender` (some of their mail was list mail). Your own addresses are left out. Ordered by `sent + received`, busiest first; `correspondents_total` is the count before `limit`. Set `min_sent: 1` to keep only people you have written to. Answered only from the local cache: an error says so when the cache cannot answer.',
  inputSchema: z.object({
    account_ids: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe('Accounts to read. Omit for all configured accounts.'),
    since: z.string().optional().describe('ISO8601 — only count messages on or after'),
    before: z.string().optional().describe('ISO8601 — only count messages strictly before'),
    min_sent: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Only addresses you have sent at least this many messages to (default 0).'),
    limit: z.number().int().positive().max(500).optional().describe('Max rows (default 100).'),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
