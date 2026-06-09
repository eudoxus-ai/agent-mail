import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { ALLOWED_FIELDS } from '../lib/envelope-projection.js';

export const searchThreadsTool: ToolDefinition = {
  name: 'search_threads',
  description:
    'Search email threads across all accounts (or a scoped subset). Returns snippets (account_id, uid, mailbox, from_address, from_name, envelope, snippet, flags, list_id, list_unsubscribe, is_list_mail, category, target) newest-first. Each result includes a `category` triage hint set to one of `newsletter`, `promotional`, `transactional`, `notification`, or `personal` — a fast heuristic classification so you do not need to reimplement one. The full-shape result includes flat top-level `from_address` and `from_name` for one-hop sender access, alongside the back-compat nested `envelope.from.{address,name}`. Envelope includes accounts_searched, accounts_available, per_account_errors, and `next_cursor` when more results are available. To paginate, pass `next_cursor` back verbatim as `cursor` on the next call (preferred). `before` (ISO8601, exclusive) is still supported for manual pagination. Each result carries a preassembled `target` object suitable for hold_messages. Set `include_snippets: true` to populate the `snippet` field (adds one IMAP fetch per result; off by default). Use `fields` to project only the keys you need per result (recommended for bulk triage to shrink payloads; `from_address` and `from_name` are available as flat projections). For full attention signals, use get_overview.',
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
      .describe('ISO8601 datetime — only messages strictly before this instant. Prefer `cursor` for pagination; use `before` only for manual time-range queries.'),
    cursor: z
      .string()
      .optional()
      .describe('Opaque cursor from a prior response `next_cursor`. When provided, `before` is ignored.'),
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
      .describe('Max results per account (default: 20). When multiple accounts are queried, results are interleaved; use a single account_id for a true top-N.'),
    include_snippets: z
      .boolean()
      .optional()
      .describe('If true, populate the `snippet` field on each result (adds one IMAP fetch per result). Default false because snippet fetches are expensive; only set true when you need body previews to disambiguate.'),
    fields: z
      .array(z.enum(ALLOWED_FIELDS as unknown as [string, ...string[]]))
      .optional()
      .describe('Project only these fields per result. Omit for full shape. Recommended for bulk triage to reduce payload size.'),
    async: z
      .boolean()
      .optional()
      .describe('If true, run the search in the background and return immediately with `{ job_id, status: "running" }`; poll `get_scan_result` with the job_id. Use for large scans across many accounts/mailboxes that risk timing out synchronously. Default false.'),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
