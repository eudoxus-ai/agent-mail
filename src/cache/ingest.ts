import type { EmailMessage, Participant } from '../types.js';
import { classifyCategory, type Category } from '../attention/category.js';

/**
 * EmailMessage -> cache rows. Pure: no IMAP, no SQL, no clock except the
 * bounded sanity check on Date headers. Same posture as attention/signals.ts,
 * and for the same reason — this is where the fiddly per-message decisions
 * live, so it should be testable without a database or a mail server.
 */

export type BodyState = 'pending' | 'fetched' | 'failed' | 'skipped';

export interface AttachmentMeta {
  part_id: string;
  filename: string | null;
  mime_type: string | null;
  size: number | null;
}

export interface IngestInput {
  accountId: string;
  message: EmailMessage;
  uidvalidity: number;
  modseq?: number | null;
  /** IMAP INTERNALDATE — the fallback when the Date: header is missing or absurd. */
  internalDate?: Date | string | null;
  size?: number | null;
  /** List-Id header, extracted at the IMAP boundary (not part of EmailMessage). */
  listId?: string | null;
  attachments?: AttachmentMeta[];
  /** Precomputed snippet. Falls back to deriving one from the body. */
  snippet?: string;
}

export interface MessageRow {
  account_id: string;
  mailbox: string;
  uid: number;
  uidvalidity: number;
  modseq: number | null;
  message_id: string | null;
  in_reply_to: string | null;
  refs: string;
  from_address: string | null;
  from_name: string | null;
  to_json: string;
  cc_json: string;
  date: number;
  subject: string;
  snippet: string;
  flags: string;
  seen: 0 | 1;
  flagged: 0 | 1;
  answered: 0 | 1;
  list_id: string | null;
  list_unsub: string | null;
  is_list_mail: 0 | 1;
  category: Category;
  size: number | null;
  has_attach: 0 | 1;
  body_state: BodyState;
}

export interface FtsRow {
  subject: string;
  body: string;
  participants: string;
  attachment_names: string;
}

/** Dates outside this window are treated as broken and fall back to INTERNALDATE. */
const MIN_PLAUSIBLE_MS = Date.UTC(1990, 0, 1);
const FUTURE_SLACK_MS = 2 * 24 * 60 * 60 * 1000;

const SNIPPET_MAX = 200;

/**
 * Resolve a message's sort date.
 *
 * The Date: header is sender-controlled and routinely wrong: absent, malformed,
 * or deliberately far-future so the message pins to the top of a date-sorted
 * inbox. INTERNALDATE is assigned by the receiving server and can't be spoofed
 * by the sender, so it's the fallback whenever the header is implausible.
 */
export function normalizeDate(
  dateHeader: string | null | undefined,
  internalDate?: Date | string | null,
  now: number = Date.now()
): number {
  const ceiling = now + FUTURE_SLACK_MS;

  const fromHeader = dateHeader ? Date.parse(dateHeader) : NaN;
  if (
    Number.isFinite(fromHeader) &&
    fromHeader >= MIN_PLAUSIBLE_MS &&
    fromHeader <= ceiling
  ) {
    return fromHeader;
  }

  if (internalDate) {
    const internal =
      internalDate instanceof Date
        ? internalDate.getTime()
        : Date.parse(internalDate);
    if (Number.isFinite(internal) && internal >= MIN_PLAUSIBLE_MS) {
      // INTERNALDATE is server-assigned; clamp rather than reject if it's
      // ahead of our clock, which happens with modest clock skew.
      return Math.min(internal, ceiling);
    }
  }

  return 0;
}

function hasFlag(flags: string[] | undefined, name: string): 0 | 1 {
  if (!flags) return 0;
  const target = name.toLowerCase();
  return flags.some((f) => f.toLowerCase() === target) ? 1 : 0;
}

function participantText(p: Participant | null | undefined): string {
  if (!p) return '';
  return p.name ? `${p.name} <${p.address}>` : p.address;
}

/** Collapse a body down to a short preview. Never throws. */
export function deriveSnippet(bodyText: string, max = SNIPPET_MAX): string {
  const collapsed = (bodyText ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max).trimEnd();
}

/**
 * Strip HTML to indexable text. Not a renderer — the goal is that words in the
 * markup become searchable words and nothing else does. Script and style
 * contents are dropped entirely so JS identifiers don't pollute the index.
 */
export function htmlToText(html: string): string {
  if (!html) return '';
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, code) => {
      const n = Number(code);
      return Number.isFinite(n) && n > 0 && n < 0x110000
        ? String.fromCodePoint(n)
        : ' ';
    })
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function toMessageRow(input: IngestInput): MessageRow {
  const { message: m, accountId } = input;

  const listUnsub = m.listUnsubscribe ?? null;
  const listId = input.listId ?? null;

  const bodyText =
    m.bodyText && m.bodyText.trim()
      ? m.bodyText
      : m.bodyHtml
        ? htmlToText(m.bodyHtml)
        : '';

  const attachments = input.attachments ?? [];

  return {
    account_id: accountId,
    mailbox: m.mailbox,
    uid: m.uid,
    uidvalidity: input.uidvalidity,
    modseq: input.modseq ?? null,
    // A missing or empty Message-Id stays null rather than becoming ''. Empty
    // string would collide across every header-less message and merge unrelated
    // threads in thread_links.
    message_id: m.messageId && m.messageId.trim() ? m.messageId.trim() : null,
    in_reply_to: m.inReplyTo && m.inReplyTo.trim() ? m.inReplyTo.trim() : null,
    refs: JSON.stringify(m.references ?? []),
    from_address: m.from?.address ?? null,
    from_name: m.from?.name ?? null,
    to_json: JSON.stringify(m.to ?? []),
    cc_json: JSON.stringify(m.cc ?? []),
    date: normalizeDate(m.date, input.internalDate),
    subject: m.subject ?? '',
    snippet: input.snippet ?? deriveSnippet(bodyText),
    flags: JSON.stringify(m.flags ?? []),
    seen: hasFlag(m.flags, '\\Seen'),
    flagged: hasFlag(m.flags, '\\Flagged'),
    answered: hasFlag(m.flags, '\\Answered'),
    list_id: listId,
    list_unsub: listUnsub ? JSON.stringify(listUnsub) : null,
    is_list_mail: listId || listUnsub ? 1 : 0,
    category: classifyCategory({
      list_id: listId,
      list_unsubscribe: listUnsub?.raw ?? null,
      subject: m.subject ?? '',
    }),
    size: input.size ?? null,
    has_attach: attachments.length > 0 ? 1 : 0,
    // Envelopes land first and bodies stream in behind them, so a freshly
    // ingested row is 'pending' unless a body came with it.
    body_state: bodyText ? 'fetched' : 'pending',
  };
}

export function toFtsRow(input: IngestInput, bodyText?: string): FtsRow {
  const { message: m } = input;

  const resolvedBody =
    bodyText ??
    (m.bodyText && m.bodyText.trim()
      ? m.bodyText
      : m.bodyHtml
        ? htmlToText(m.bodyHtml)
        : '');

  const participants = [
    participantText(m.from),
    ...(m.to ?? []).map(participantText),
    ...(m.cc ?? []).map(participantText),
  ]
    .filter(Boolean)
    .join(' ');

  const attachmentNames = (input.attachments ?? [])
    .map((a) => a.filename)
    .filter((n): n is string => Boolean(n))
    .join(' ');

  return {
    subject: m.subject ?? '',
    body: resolvedBody,
    participants,
    attachment_names: attachmentNames,
  };
}
