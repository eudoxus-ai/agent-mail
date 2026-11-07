import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

const MAX_SENDERS = 100;

const description =
  'Hold ALL messages from a given sender address (optionally bounded by `before`). Reversible for 30 days via restore_messages or undo_intent. Use for "clean out newsletter X" style triage — prefer hold_messages when you already have specific UIDs. Supports dry_run and include_summary. IMPORTANT: matching nothing is not the same as sweeping clean. A sweep that matched no messages returns status "no_match" with matched: 0 and a diagnosis (queued sweeps report phase "no_match" via get_intent). Do NOT report a sender as cleared on a no_match — the FROM match is done by the IMAP server, whose matching rules vary by provider and have been measured missing mail that is plainly there, so verify with search_threads before concluding the mailbox is clean.';

const senderAddress = z.string().min(
  3,
  'A `from` shorter than 3 characters is silently unmatchable: servers have been measured returning an empty set for every 1- and 2-character term regardless of mailbox contents, so the sweep would report no_match rather than fail. Use at least 3 characters, and prefer the complete sender address.'
);

const inputSchema = z.object({
  from: z
    .union([senderAddress, z.array(senderAddress).min(1).max(MAX_SENDERS)])
    .optional()
    .describe(
      'Sender email address — prefer the complete address, or a prefix of it. Matching is performed by the IMAP server via SEARCH FROM, not locally, and servers disagree about what that means. Dovecot substring-matches the whole From header, so any fragment works. iCloud matches only within roughly the first 29 characters of the address, so a bare domain can return NOTHING on a sender whose local part is long while the full address returns everything: from="mattressfirm@email.mattressfirm.com" matched 23 messages, from="email.mattressfirm.com" matched 0, same sender and mailbox. A prefix of the address matches at any length. If a sweep returns no_match but you can see messages from the sender, retry with the FULL address — retrying with a shorter fragment, or with the domain alone, is the least likely thing to work.' +
        ` Pass a list to sweep up to ${MAX_SENDERS} senders as one intent, which reports an outcome per sender and needs \`account_ids\`. A message in a thread with replies, or in a thread you wrote into, is left where it is and listed under \`skipped_replied\` while the rest are held. A sender with nothing else to hold is reported as blocked and does not stop the others.`
    ),
  list_id: z
    .string()
    .min(5)
    .optional()
    .describe(
      'Hold by List-Id header instead of sender, for mailing lists whose posts come from per-member addresses (groups.io, Google Groups). Matched by the IMAP server as a substring, so prefer the full id, e.g. "my-list.groups.io". Needs `account_ids`. Use instead of `from`, not with it.'
    ),
  before: z
    .string()
    .optional()
    .describe('ISO8601 — only messages strictly before this instant.'),
  account_ids: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Accounts to sweep. Pass the accounts list_senders reported for this sender: every extra account adds a search. Omitting it sweeps all accounts, and is only allowed for a single sender.'
    ),
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

export interface Sweep {
  senders: string[];
  /** True when `from` was a list, which changes the response shape. */
  batch: boolean;
  listId?: string;
}

/**
 * The rules a schema can't express. Run before queuing, so a bad call is
 * refused to the caller's face rather than failing later in the daemon.
 */
export function parseSweep(params: Record<string, unknown>): Sweep {
  const from = params.from as string | string[] | undefined;
  const listId = params.list_id as string | undefined;
  const accountIds = params.account_ids as string[] | undefined;

  if ((from === undefined) === (listId === undefined)) {
    throw new Error('hold_by_sender needs exactly one of `from` or `list_id`.');
  }
  if ((Array.isArray(from) || listId !== undefined) && !accountIds?.length) {
    throw new Error(
      'hold_by_sender needs `account_ids` with a list of senders or a `list_id`, because ' +
        'each extra account adds a search per sender.'
    );
  }
  if (listId !== undefined) return { senders: [], batch: false, listId };
  return { senders: Array.isArray(from) ? from : [from as string], batch: Array.isArray(from) };
}
