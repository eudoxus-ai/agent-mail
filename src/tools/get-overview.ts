import { z } from 'zod';
import type { ToolDefinition, AccountConfig, Participant, EmailMessage } from '../types.js';
import type { ImapConnectionPool } from '../provider/imap-pool.js';
import type { ImapProvider } from '../provider/imap.js';
import { computeSignals, type MessageSignals } from '../attention/signals.js';

const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_LIMIT_PER_CATEGORY = 25;
const SUPPORTED_CATEGORIES = ['unread', 'flagged', 'recent_direct', 'awaiting_you'] as const;
type Category = (typeof SUPPORTED_CATEGORIES)[number];

export const getOverviewTool: ToolDefinition = {
  name: 'get_overview',
  description:
    'Returns a rich, attention-tagged snapshot of recent mail across all configured accounts. Use this when the user asks general questions like "what do I need to be aware of this week" — one call replaces many search_threads calls. The result follows the standard multi-account envelope: top-level `accounts_searched`, `accounts_available`, and (if any account failed) `per_account_errors` describe the fan-out, alongside the per-account `accounts` bundles and the aggregate `summary`.',
  inputSchema: z.object({
    account_ids: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe('Account IDs to include. Omit for all.'),
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
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};

// ─── Types ─────────────────────────────────────────────────────────────

export interface OverviewInput {
  account_ids?: string[];
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
  accounts_searched: string[];
  accounts_available: string[];
  per_account_errors?: Record<string, string>;
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

  const allIds = deps.accounts.map((a) => a.id);
  const requestedIds = deps.input.account_ids ?? allIds;

  const unknown = requestedIds.filter((id) => !allIds.includes(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown account_ids: ${unknown.join(', ')}`);
  }

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

  const per_account_errors: Record<string, string> = {};
  for (const b of bundles) {
    if (b.error !== null) per_account_errors[b.account_id] = b.error;
  }

  const result: OverviewResult = {
    accounts_searched: requested.map((a) => a.id),
    accounts_available: allIds,
    generated_at: now.toISOString(),
    window: { since: since.toISOString(), until: now.toISOString() },
    accounts: bundles,
    summary: { total_threads: total, by_category, by_account },
  };
  if (Object.keys(per_account_errors).length > 0) {
    result.per_account_errors = per_account_errors;
  }
  return result;
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
    // (mailbox, uid) → { message, categories, mailbox }
    const seen = new Map<
      string,
      { message: EmailMessage & { snippet: string }; categories: Set<Category>; mailbox: string }
    >();

    for (const mailbox of deps.mailboxes) {
      const catUidLists = await gatherCandidateUids(imap, mailbox, deps);

      // Union UIDs for a single fetch call per mailbox
      const allUids = new Set<number>();
      for (const uids of Object.values(catUidLists)) {
        if (!uids) continue;
        for (const u of uids) allUids.add(u);
      }
      if (allUids.size === 0) continue;

      const envelopes = await imap.fetchEnvelopes(mailbox, Array.from(allUids));
      const envelopesByUid = new Map(envelopes.map((e) => [e.uid, e]));

      for (const [cat, uids] of Object.entries(catUidLists) as Array<[Category, number[]]>) {
        for (const uid of uids) {
          const env = envelopesByUid.get(uid);
          if (!env) continue;

          // recent_direct post-filter: must be direct-to-you
          if (cat === 'recent_direct') {
            const me = deps.account.email.toLowerCase();
            const isDirect = env.to.some((p) => p.address === me);
            if (!isDirect) continue;
          }

          // awaiting_you post-filter: must not be from you, and not
          // automated/list mail (single-message signal override would
          // make thread_state 'new' for automated/list anyway).
          if (cat === 'awaiting_you') {
            const me = deps.account.email.toLowerCase();
            if (env.from.address === me) continue;
            const signals = computeSignals(env, {
              accountEmail: deps.account.email,
              threadMessages: [env],
            });
            if (signals.is_list_mail) continue;
          }

          const key = `${mailbox}:${uid}`;
          const entry = seen.get(key);
          if (entry) {
            entry.categories.add(cat);
          } else {
            seen.set(key, {
              message: env,
              categories: new Set([cat]),
              mailbox,
            });
          }
        }
      }
    }

    const found: OverviewThread[] = [];
    for (const { message, categories, mailbox } of seen.values()) {
      // Thread root: first References entry, or inReplyTo, or the message itself
      const rootId =
        message.references[0] ?? message.inReplyTo ?? message.messageId;

      // Fetch up to 50 thread messages from the same mailbox
      let threadMessages: Array<EmailMessage & { snippet: string }> = [];
      try {
        threadMessages = await imap.fetchThreadContext(mailbox, [rootId]);
      } catch {
        threadMessages = [message]; // best-effort
      }

      if (threadMessages.length === 0) {
        threadMessages = [message];
      }

      // Ensure the candidate itself is in the thread list
      if (!threadMessages.some((m) => m.uid === message.uid)) {
        threadMessages.push(message);
        threadMessages.sort(
          (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
        );
      }

      const fullMessageCount = threadMessages.length;
      const TAIL_WINDOW = 5;
      let truncated = false;
      let contextForSignals = threadMessages;
      if (fullMessageCount > TAIL_WINDOW) {
        contextForSignals = threadMessages.slice(-TAIL_WINDOW);
        truncated = true;
      }

      const signals = computeSignals(message, {
        accountEmail: deps.account.email,
        threadMessages: contextForSignals,
      });

      found.push({
        thread_id: hashMessageId(rootId),
        account_id: deps.account.id,
        mailbox,
        categories: Array.from(categories),
        latest_message: {
          message_id: message.messageId,
          uid: message.uid,
          from: message.from,
          to: message.to,
          cc: message.cc,
          date: message.date,
          subject: message.subject,
          snippet: message.snippet,
          flags: message.flags,
        },
        thread: {
          message_count: fullMessageCount,
          first_date: threadMessages[0].date,
          latest_date: threadMessages[threadMessages.length - 1].date,
          truncated,
        },
        signals,
      });
    }
    // Sort newest-first by latest message date
    found.sort(
      (a, b) =>
        new Date(b.latest_message.date).getTime() -
        new Date(a.latest_message.date).getTime()
    );
    return found;
  });

  return {
    account_id: deps.account.id,
    email: deps.account.email,
    error: null,
    threads,
  };
}

async function gatherCandidateUids(
  imap: ImapProvider,
  mailbox: string,
  deps: CollectDeps
): Promise<Partial<Record<Category, number[]>>> {
  const out: Partial<Record<Category, number[]>> = {};
  const clip = (xs: number[]) => xs.slice(-deps.limitPerCategory);

  if (deps.categories.includes('unread')) {
    const uids = await imap.searchUids(mailbox, {
      unseen: true,
      since: deps.since,
    });
    out.unread = clip(uids);
  }
  if (deps.categories.includes('flagged')) {
    const uids = await imap.searchUids(mailbox, { flagged: true });
    out.flagged = clip(uids);
  }
  if (deps.categories.includes('recent_direct')) {
    const uids = await imap.searchUids(mailbox, { since: deps.since });
    out.recent_direct = clip(uids);
  }
  if (deps.categories.includes('awaiting_you')) {
    const uids = await imap.searchUids(mailbox, {
      since: deps.since,
      unanswered: true,
    });
    out.awaiting_you = clip(uids);
  }
  return out;
}

function hashMessageId(id: string): string {
  // Simple deterministic hash — not cryptographic. Stable across runs for a given id.
  let h = 5381;
  for (let i = 0; i < id.length; i++) {
    h = (h * 33) ^ id.charCodeAt(i);
  }
  return `t_${(h >>> 0).toString(16)}`;
}
