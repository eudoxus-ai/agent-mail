import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { getAuditLog } from '../ledger/audit.js';

export const getAuditLogTool: ToolDefinition = {
  name: 'get_audit_log',
  description: 'View the history of all actions taken by agents and users. Filterable by account.',
  inputSchema: z.object({
    account_id: z.string().min(1).optional().describe('Filter by account'),
    limit: z.number().int().nonnegative().max(200).optional().describe('Max entries (default: 50)'),
    offset: z.number().int().nonnegative().optional().describe('Pagination offset'),
  }),
  annotations: { readOnlyHint: true },
  async execute(params, context) {
    const entries = getAuditLog(context.db, {
      account_id: params.account_id as string | undefined,
      limit: (params.limit as number) ?? 50,
      offset: (params.offset as number) ?? 0,
    });
    return {
      type: 'immediate',
      content: [
        {
          type: 'text',
          text: entries.length === 0
            ? 'No audit log entries.'
            : JSON.stringify(entries, null, 2),
        },
      ],
    };
  },
};
