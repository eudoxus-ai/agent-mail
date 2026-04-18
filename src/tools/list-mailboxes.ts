import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

export const listMailboxesTool: ToolDefinition = {
  name: 'list_mailboxes',
  description:
    'List mailboxes/folders for one or more accounts. Returns per_account mailbox trees with path, name, specialUse (\\\\Inbox, \\\\Sent, \\\\Drafts, \\\\Trash, \\\\Junk, \\\\Archive, \\\\Flagged), delimiter, and flags. Use this to discover user-created folders (rules, labels) before treating INBOX as a flat bucket.',
  inputSchema: z.object({
    account_ids: z.array(z.string().min(1)).min(1).optional(),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
