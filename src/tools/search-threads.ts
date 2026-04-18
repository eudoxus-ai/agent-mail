import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

export const searchThreadsTool: ToolDefinition = {
  name: 'search_threads',
  description:
    'Search email threads across all accounts (or a scoped subset). Returns snippets (account_id, uid, subject, sender, date, snippet) newest-first with an is_automated flag on each result. The response envelope includes accounts_searched, accounts_available, and per_account_errors so partial scoping is always visible. Use `since` (ISO8601) to scope to a time window. Use `account_ids` to scope to specific accounts. For full attention signals (direct_to_me, thread state, network), use get_overview instead.',
  inputSchema: z.object({
    query: z.string().min(1).optional().describe('Search query text'),
    from: z.string().min(1).optional().describe('Filter by sender email/name'),
    to: z.string().min(1).optional().describe('Filter by recipient'),
    subject: z.string().min(1).optional().describe('Filter by subject'),
    since: z
      .string()
      .optional()
      .describe('ISO8601 datetime — only messages on or after this instant'),
    account_ids: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe('Accounts to search. Omit for all configured accounts.'),
    mailbox: z.string().min(1).optional().describe('Mailbox to search (default: INBOX)'),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe('Max results per account (default: 20)'),
  }),
  annotations: { readOnlyHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
