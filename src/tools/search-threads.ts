import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

export const searchThreadsTool: ToolDefinition = {
  name: 'search_threads',
  description:
    'Search email threads. Returns snippets (subject, sender, date, snippet) newest-first with an is_automated flag on each result. Use `since` (ISO8601) to scope to a time window. For full attention signals (direct_to_me, thread state, network), use get_overview instead.',
  inputSchema: z.object({
    query: z.string().optional().describe('Search query text'),
    from: z.string().optional().describe('Filter by sender email/name'),
    to: z.string().optional().describe('Filter by recipient'),
    subject: z.string().optional().describe('Filter by subject'),
    since: z
      .string()
      .optional()
      .describe('ISO8601 datetime — only messages on or after this instant'),
    account_id: z
      .string()
      .optional()
      .describe('Account to search. Omit for default account.'),
    mailbox: z.string().optional().describe('Mailbox to search (default: INBOX)'),
    limit: z.number().optional().describe('Max results (default: 20)'),
  }),
  annotations: { readOnlyHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
