import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

const description =
  'Hold ALL messages from a given sender address (optionally bounded by `before`). Reversible for 30 days via restore_messages or undo_intent. Use for "clean out newsletter X" style triage — prefer hold_messages when you already have specific UIDs. Supports dry_run and include_summary. IMPORTANT: matching nothing is not the same as sweeping clean. A sweep that matched no messages returns status "no_match" with matched: 0 and a diagnosis (queued sweeps report phase "no_match" via get_intent). Do NOT report a sender as cleared on a no_match — the FROM match is done by the IMAP server as a substring match and can miss, so verify with search_threads before concluding the mailbox is clean.';

const inputSchema = z.object({
  from: z
    .string()
    .min(1)
    .describe(
      'Sender email address, or a substring of it. Matching is performed by the IMAP server via SEARCH FROM, not locally — a substring like the domain matches every subdomain that contains it, and very long full addresses have been observed to match nothing at all. If a sweep returns no_match but you can see messages from the sender, retry with a shorter distinctive substring.'
    ),
  before: z
    .string()
    .optional()
    .describe('ISO8601 — only messages strictly before this instant.'),
  account_ids: z
    .array(z.string().min(1))
    .optional()
    .describe('Restrict to specific accounts; omit for all configured accounts.'),
  mailbox: z.string().optional().describe('Default: INBOX.'),
  dry_run: z
    .boolean()
    .optional()
    .describe('Preview the UID list without moving.'),
  include_summary: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'Default true: response includes moved[{uid, account_id, subject, from, original_mailbox}].'
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe('Safety cap per account. Default 500.'),
  background: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'Default TRUE for this tool. Queues the sweep and returns an intent_id immediately with status "queued"; the agent-mail daemon performs it. Poll get_intent(intent_id) until status is "executed" or "failed". "queued" is normal and means the work is recorded and durable — do NOT re-run it, that duplicates the move. If it stays queued, call get_diagnostics: the daemon may not be running. This is the default because a sender sweep has no upper bound on size — a synchronous call can outrun the client timeout, and that timeout tells you nothing about whether the move happened while leaving you no intent_id to undo with. Pass false only for senders you know are small and you want the moved-message list inline.'
    ),
});

export const holdBySenderTool: ToolDefinition = {
  name: 'hold_by_sender',
  description,
  inputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
