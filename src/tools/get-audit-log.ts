import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { getAuditLog } from '../ledger/audit.js';

export const getAuditLogTool: ToolDefinition = {
  name: 'get_audit_log',
  description:
    'View the history of all actions taken by agents and users. Spans every configured account by default; pass `account_ids` to scope. Returns the standard multi-account envelope: `accounts_searched`, `accounts_available`, and `results`.',
  inputSchema: z.object({
    account_ids: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe('Filter by account ids. Omit for all configured accounts.'),
    limit: z.number().int().nonnegative().max(200).optional().describe('Max entries (default: 50)'),
    offset: z.number().int().nonnegative().optional().describe('Pagination offset'),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  async execute(params, context) {
    const allIds = context.accounts.map((a) => a.id);
    const requestedIds = params.account_ids as string[] | undefined;
    const targetIds = requestedIds ?? allIds;

    if (requestedIds) {
      const unknown = requestedIds.filter((id) => !allIds.includes(id));
      if (unknown.length > 0) {
        throw new Error(`Unknown account_ids: ${unknown.join(', ')}`);
      }
    }

    const entries = getAuditLog(context.db, {
      account_ids: requestedIds,
      limit: (params.limit as number) ?? 50,
      offset: (params.offset as number) ?? 0,
    });

    const envelope = {
      accounts_searched: targetIds,
      accounts_available: allIds,
      results: entries,
    };

    return {
      type: 'immediate',
      content: [
        {
          type: 'text',
          text: JSON.stringify(envelope, null, 2),
        },
      ],
    };
  },
};
