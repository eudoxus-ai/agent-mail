import { z } from 'zod';
import type { ToolDefinition, AccountConfig, Participant, EmailMessage } from '../types.js';
import type { ImapConnectionPool } from '../provider/imap-pool.js';
import { computeSignals, type MessageSignals } from '../attention/signals.js';

const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_LIMIT_PER_CATEGORY = 25;
const SUPPORTED_CATEGORIES = ['unread', 'flagged', 'recent_direct', 'awaiting_you'] as const;
type Category = (typeof SUPPORTED_CATEGORIES)[number];

export const getOverviewTool: ToolDefinition = {
  name: 'get_overview',
  description:
    'Returns a rich, attention-tagged snapshot of recent mail across all configured accounts. Use this when the user asks general questions like "what do I need to be aware of this week" — one call replaces many search_threads calls.',
  inputSchema: z.object({
    accounts: z.array(z.string()).optional().describe('Account IDs to include. Omit for all.'),
    since: z
      .string()
      .optional()
      .describe('ISO8601 datetime. Defaults to 7 days ago.'),
    mailboxes: z
      .array(z.string())
      .optional()
      .describe('Mailboxes to scan per account. Defaults to [INBOX].'),
    include: z
      .array(z.enum(SUPPORTED_CATEGORIES))
      .optional()
      .describe('Which candidate sets to include. Defaults to all four.'),
    limit_per_category: z
      .number()
      .optional()
      .describe('Max threads per category per account. Default 25.'),
  }),
  annotations: { readOnlyHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};

// ─── Types ─────────────────────────────────────────────────────────────

export interface OverviewInput {
  accounts?: string[];
  since?: string;
  mailboxes?: string[];
  include?: Category[];
  limit_per_category?: number;
}

export interface OverviewThread {
  thread_id: string;
  account_id: string;
  mailbox: string;
  categories: Category[];
  latest_message: {
    message_id: string;
    uid: number;
    from: Participant;
    to: Participant[];
    cc: Participant[];
    date: string;
    subject: string;
    snippet: string;
    flags: string[];
  };
  thread: {
    message_count: number;
    first_date: string;
    latest_date: string;
    truncated: boolean;
  };
  signals: MessageSignals;
}

export interface OverviewAccountBundle {
  account_id: string;
  email: string;
  error: string | null;
  threads: OverviewThread[];
}

export interface OverviewResult {
  generated_at: string;
  window: { since: string; until: string };
  accounts: OverviewAccountBundle[];
  summary: {
    total_threads: number;
    by_category: Record<string, number>;
    by_account: Record<string, number>;
  };
}

// ─── Orchestration ────────────────────────────────────────────────────

interface RunDeps {
  pool: ImapConnectionPool;
  accounts: AccountConfig[];
  input: OverviewInput;
}

export async function runGetOverview(deps: RunDeps): Promise<OverviewResult> {
  const now = new Date();
  const since = deps.input.since
    ? new Date(deps.input.since)
    : new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const mailboxes = deps.input.mailboxes ?? ['INBOX'];
  const categories: Category[] = deps.input.include ?? [...SUPPORTED_CATEGORIES];
  const limitPerCategory = deps.input.limit_per_category ?? DEFAULT_LIMIT_PER_CATEGORY;

  const requestedIds = deps.input.accounts ?? deps.accounts.map((a) => a.id);
  const requested = deps.accounts.filter((a) => requestedIds.includes(a.id));

  const settled = await Promise.allSettled(
    requested.map((account) =>
      collectAccountBundle({
        pool: deps.pool,
        account,
        mailboxes,
        categories,
        since,
        limitPerCategory,
      })
    )
  );

  const bundles: OverviewAccountBundle[] = settled.map((r, idx) => {
    const account = requested[idx];
    if (r.status === 'fulfilled') return r.value;
    const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
    return {
      account_id: account.id,
      email: account.email,
      error: msg,
      threads: [],
    };
  });

  // Summary
  const by_category: Record<string, number> = {};
  const by_account: Record<string, number> = {};
  let total = 0;
  for (const b of bundles) {
    by_account[b.account_id] = b.threads.length;
    total += b.threads.length;
    for (const t of b.threads) {
      for (const c of t.categories) {
        by_category[c] = (by_category[c] ?? 0) + 1;
      }
    }
  }

  return {
    generated_at: now.toISOString(),
    window: { since: since.toISOString(), until: now.toISOString() },
    accounts: bundles,
    summary: { total_threads: total, by_category, by_account },
  };
}

interface CollectDeps {
  pool: ImapConnectionPool;
  account: AccountConfig;
  mailboxes: string[];
  categories: Category[];
  since: Date;
  limitPerCategory: number;
}

async function collectAccountBundle(deps: CollectDeps): Promise<OverviewAccountBundle> {
  const threads = await deps.pool.withConnection(deps.account.id, async (imap) => {
    const found: OverviewThread[] = [];

    for (const mailbox of deps.mailboxes) {
      if (deps.categories.includes('unread')) {
        const uids = await imap.searchUids(mailbox, {
          unseen: true,
          since: deps.since,
        });
        const newest = uids.slice(-deps.limitPerCategory);
        const messages = await imap.fetchEnvelopes(mailbox, newest);
        for (const msg of messages) {
          found.push(toOverviewThread(deps.account, mailbox, msg, ['unread']));
        }
      }
    }

    return found;
  });

  return {
    account_id: deps.account.id,
    email: deps.account.email,
    error: null,
    threads,
  };
}

function toOverviewThread(
  account: AccountConfig,
  mailbox: string,
  msg: EmailMessage & { snippet: string },
  categories: Category[]
): OverviewThread {
  const signals = computeSignals(msg, {
    accountEmail: account.email,
    threadMessages: [msg],
  });
  return {
    thread_id: hashMessageId(msg.messageId),
    account_id: account.id,
    mailbox,
    categories,
    latest_message: {
      message_id: msg.messageId,
      uid: msg.uid,
      from: msg.from,
      to: msg.to,
      cc: msg.cc,
      date: msg.date,
      subject: msg.subject,
      snippet: msg.snippet,
      flags: msg.flags,
    },
    thread: {
      message_count: 1,
      first_date: msg.date,
      latest_date: msg.date,
      truncated: false,
    },
    signals,
  };
}

function hashMessageId(id: string): string {
  // Simple deterministic hash — not cryptographic. Stable across runs for a given id.
  let h = 5381;
  for (let i = 0; i < id.length; i++) {
    h = (h * 33) ^ id.charCodeAt(i);
  }
  return `t_${(h >>> 0).toString(16)}`;
}
