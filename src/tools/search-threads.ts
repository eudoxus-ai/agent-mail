import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

export const searchThreadsTool: ToolDefinition = {
  name: 'search_threads',
  description:
    'Search email threads. Returns snippets (subject, sender, date) so you can decide which to read in full. Provide search terms to match against subject, sender, or body.',
  inputSchema: z.object({
    query: z.string().optional().describe('Search query text'),
    from: z.string().optional().describe('Filter by sender email/name'),
    to: z.string().optional().describe('Filter by recipient'),
    subject: z.string().optional().describe('Filter by subject'),
    account_id: z.string().optional().describe('Account to search. Omit for default account.'),
    mailbox: z.string().optional().describe('Mailbox to search (default: INBOX)'),
    limit: z.number().optional().describe('Max results (default: 20)'),
  }),
  annotations: { readOnlyHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
