import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

export const listAccountsTool: ToolDefinition = {
  name: 'list_accounts',
  description:
    'Who you are: the configured mail accounts, read from the local cache without contacting a mail server. Returns `accounts`, one per account, with `id`, `email`, `addresses` and `mailboxes`. `addresses` lists every From address seen in that account\'s sent mailboxes with the number of messages sent from it, most used first, so aliases show up; the configured email is always included. `mailboxes` lists each cached mailbox with `role` (`inbox`, `sent` or `other`), `messages`, `oldest` (the oldest cached message, ISO8601) and `backfill_complete`. Use the mailbox names with search_threads. When the cache is off or missing, each account has only `id` and `email`, and `note` says why.',
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
