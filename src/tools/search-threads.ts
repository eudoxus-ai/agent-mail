import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

export const searchThreadsTool: ToolDefinition = {
  name: 'search_threads',
  description:
    'Search email threads across all accounts (or a scoped subset). Returns snippets (account_id, uid, mailbox, subject, sender, date, snippet, list_id, list_unsubscribe, is_automated, is_list_mail, target) newest-first. Envelope includes accounts_searched, accounts_available, and per_account_errors. Paginate older results with `before` (ISO8601, exclusive); each result already carries a preassembled `target` object suitable for quarantine_messages. For full attention signals, use get_overview.',
  inputSchema: z.object({
    query: z.string().min(1).optional().describe('Search query text'),
    from: z.string().min(1).optional().describe('Filter by sender email/name'),
    to: z.string().min(1).optional().describe('Filter by recipient'),
    subject: z.string().min(1).optional().describe('Filter by subject'),
    since: z
      .string()
      .optional()
      .describe('ISO8601 datetime — only messages on or after this instant'),
    before: z
      .string()
      .optional()
      .describe('ISO8601 datetime — only messages strictly before this instant. Use the oldest `envelope.date` from a prior page to paginate.'),
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
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
