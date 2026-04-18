import { z } from 'zod';

export const TargetSchema = z.object({
  account_id: z.string().min(1).describe('Account that owns this UID'),
  uid: z.number().int().positive().describe('IMAP UID'),
  mailbox: z.string().min(1).optional().describe('Source mailbox (default: INBOX)'),
});

export type Target = z.infer<typeof TargetSchema>;

export const TargetsSchema = z
  .array(TargetSchema)
  .min(1)
  .describe('Account-qualified message references');

export interface ResolvedTarget {
  uid: number;
  mailbox: string;
}

export function parseTargets(targets: Target[]): Record<string, ResolvedTarget[]> {
  const grouped: Record<string, ResolvedTarget[]> = {};
  for (const t of targets) {
    const list = (grouped[t.account_id] ??= []);
    list.push({ uid: t.uid, mailbox: t.mailbox ?? 'INBOX' });
  }
  return grouped;
}
