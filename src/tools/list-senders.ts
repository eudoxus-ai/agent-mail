import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

export const listSendersTool: ToolDefinition = {
  name: 'list_senders',
  description:
    'Bulk triage: make N sender decisions instead of 10×N UID decisions. Aggregates inbox messages by sender across one or more accounts. Returns rows of {account_id, from, count, sample_uids, has_unsubscribe, is_list_mail_ratio, latest_date} ordered by count descending. Scopes by `since` / `before` (ISO8601), `account_ids`, and `mailbox` only — does NOT filter on query/from/to/subject.',
  inputSchema: z.object({
    since: z.string().optional().describe('ISO8601 — only count messages on or after'),
    before: z.string().optional().describe('ISO8601 — only count messages strictly before'),
    account_ids: z.array(z.string().min(1)).min(1).optional(),
    mailbox: z.string().min(1).optional().describe('Mailbox (default: INBOX)'),
    min_count: z.number().int().positive().optional().describe('Omit senders with fewer than this many messages (default 1)'),
    sample_size: z.number().int().positive().max(20).optional().describe('UIDs to include per sender (default 5)'),
    scan_limit: z.number().int().positive().max(1000).optional().describe('Max messages per account to scan (default 500)'),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
