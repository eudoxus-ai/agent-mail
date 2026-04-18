import { ImapFlow } from 'imapflow';
import type { ResolvedAccount, EmailMessage, SearchCriteria, Participant } from '../types.js';
import { parseListUnsubscribe } from '../lib/list-unsubscribe.js';
import { pickNewestUids } from './search-ordering.js';
import { extractSnippet, extractSnippetFromPart } from './mime.js';
import type { SnippetSource } from './mime.js';

function toParticipant(addr: { name?: string | null; address?: string | null } | undefined): Participant {
  return {
    address: (addr?.address ?? '').trim().toLowerCase(),
    name: addr?.name?.trim() || null,
  };
}

function toParticipants(addrs: Array<{ name?: string | null; address?: string | null }> | undefined): Participant[] {
  return (addrs ?? []).map(toParticipant);
}

export class ImapProvider {
  private client: ImapFlow;
  private account: ResolvedAccount;

  constructor(account: ResolvedAccount) {
    this.account = account;
    this.client = new ImapFlow({
      host: account.imap.host,
      port: account.imap.port,
      secure: account.imap.tls,
      auth: {
        user: account.auth.user,
        pass: account.auth.pass,
      },
      logger: false,
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    await this.client.logout();
  }

  async noop(): Promise<void> {
    await this.client.noop();
  }

  async search(
    mailbox: string,
    criteria: SearchCriteria,
    limit: number = 20
  ): Promise<Array<{
    uid: number;
    envelope: { message_id: string; subject: string; from: Participant; date: string };
    snippet: string;
    flags: string[];
    list_id: string | null;
    list_unsubscribe: string | null;
  }>> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const searchQuery: Record<string, unknown> = {};
      if (criteria.from) searchQuery.from = criteria.from;
      if (criteria.to) searchQuery.to = criteria.to;
      if (criteria.subject) searchQuery.subject = criteria.subject;
      if (criteria.body) searchQuery.body = criteria.body;
      if (criteria.since) searchQuery.since = criteria.since;
      // IMAP BEFORE operates at calendar-date granularity; pad by one day so
      // the server returns everything on the cursor day, then post-filter by
      // the exact timestamp after we have envelope dates.
      if (criteria.before) {
        searchQuery.before = new Date(criteria.before.getTime() + 24 * 60 * 60 * 1000);
      }
      if (criteria.flagged !== undefined) searchQuery.flagged = criteria.flagged;
      if (criteria.seen !== undefined) searchQuery.seen = criteria.seen;

      const query = Object.keys(searchQuery).length > 0 ? searchQuery : { all: true };

      // Phase 1: cheap UID-only search. imapflow returns ascending UIDs (or false on failure).
      const searchResult = await this.client.search(query as any, { uid: true });
      const allUids: number[] = Array.isArray(searchResult) ? searchResult : [];
      if (allUids.length === 0) return [];

      const uidsToFetch = pickNewestUids(allUids, limit);
      if (uidsToFetch.length === 0) return [];

      // Phase 2: hydrate envelopes + partial source for the selected UIDs.
      const results: Array<{
        uid: number;
        envelope: { message_id: string; subject: string; from: Participant; date: string };
        snippet: string;
        flags: string[];
        list_id: string | null;
        list_unsubscribe: string | null;
      }> = [];

      for await (const msg of this.client.fetch(
        uidsToFetch.join(','),
        {
          uid: true,
          envelope: true,
          flags: true,
          source: { start: 0, maxLength: 2048 },
          headers: ['list-id', 'list-unsubscribe'],
        },
        { uid: true }
      )) {
        const headersStr = msg.headers?.toString('utf-8') ?? '';
        const { listId, listUnsubscribe } = extractListHeadersFromSource(headersStr);
        results.push({
          uid: msg.uid,
          envelope: {
            message_id: msg.envelope?.messageId ?? `${msg.uid}@unknown`,
            subject: msg.envelope?.subject ?? '(no subject)',
            from: toParticipant(msg.envelope?.from?.[0]),
            date: msg.envelope?.date?.toISOString() ?? new Date().toISOString(),
          },
          snippet: extractSnippet(msg.source ?? Buffer.alloc(0)),
          flags: Array.from(msg.flags ?? []),
          list_id: listId,
          list_unsubscribe: listUnsubscribe,
        });
      }

      // Post-filter by exact `before` timestamp. IMAP BEFORE operates at
      // day granularity so we widened the query by one day above; trim
      // same-day results here to honor the advertised exclusive cursor.
      const beforeMs = criteria.before?.getTime();
      const filtered = beforeMs !== undefined
        ? results.filter((r) => new Date(r.envelope.date).getTime() < beforeMs)
        : results;

      // Sort descending by date (newest first). IMAP UIDs are usually chronological
      // but not guaranteed, so sort on the envelope date we already have.
      filtered.sort(
        (a, b) => new Date(b.envelope.date).getTime() - new Date(a.envelope.date).getTime()
      );

      return filtered;
    } finally {
      lock.release();
    }
  }

  /** Return the full list of UIDs matching a search criterion, ascending. */
  async searchUids(
    mailbox: string,
    criteria: {
      from?: string;
      subject?: string;
      body?: string;
      since?: Date;
      before?: Date;
      flagged?: boolean;
      seen?: boolean;
      unseen?: boolean;
      answered?: boolean;
      unanswered?: boolean;
    }
  ): Promise<number[]> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const query: Record<string, unknown> = {};
      if (criteria.from) query.from = criteria.from;
      if (criteria.subject) query.subject = criteria.subject;
      if (criteria.body) query.body = criteria.body;
      if (criteria.since) query.since = criteria.since;
      if (criteria.before) query.before = criteria.before;
      if (criteria.flagged !== undefined) query.flagged = criteria.flagged;
      if (criteria.seen !== undefined) query.seen = criteria.seen;
      if (criteria.unseen !== undefined) query.unseen = criteria.unseen;
      if (criteria.answered !== undefined) query.answered = criteria.answered;
      if (criteria.unanswered !== undefined) query.unanswered = criteria.unanswered;
      const searchResult = await this.client.search(query as any, { uid: true });
      return Array.isArray(searchResult) ? searchResult : [];
    } finally {
      lock.release();
    }
  }

  /** Fetch envelopes + partial source for a specific list of UIDs. Returns EmailMessage objects with a `snippet` field. */
  async fetchEnvelopes(
    mailbox: string,
    uids: number[]
  ): Promise<Array<EmailMessage & { snippet: string }>> {
    if (uids.length === 0) return [];
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const results: Array<EmailMessage & { snippet: string }> = [];
      for await (const msg of this.client.fetch(
        uids.join(','),
        {
          uid: true,
          envelope: true,
          flags: true,
          source: { start: 0, maxLength: 2048 },
        },
        { uid: true }
      )) {
        const source = msg.source?.toString('utf-8') ?? '';
        const inReplyTo = extractHeader(source, 'In-Reply-To');
        const references =
          extractHeader(source, 'References')?.split(/\s+/).filter(Boolean) ?? [];
        const rawListUnsubscribe = extractHeader(source, 'List-Unsubscribe');
        const listUnsubscribePost = extractHeader(source, 'List-Unsubscribe-Post');

        results.push({
          uid: msg.uid,
          messageId: msg.envelope?.messageId ?? `${msg.uid}@unknown`,
          from: toParticipant(msg.envelope?.from?.[0]),
          to: toParticipants(msg.envelope?.to),
          cc: toParticipants(msg.envelope?.cc),
          date: msg.envelope?.date?.toISOString() ?? new Date().toISOString(),
          subject: msg.envelope?.subject ?? '(no subject)',
          bodyText: '',
          inReplyTo: inReplyTo ?? undefined,
          references,
          flags: Array.from(msg.flags ?? []),
          listUnsubscribe: rawListUnsubscribe != null
            ? parseListUnsubscribe(rawListUnsubscribe, listUnsubscribePost ?? undefined)
            : undefined,
          mailbox,
          snippet: extractSnippet(msg.source ?? Buffer.alloc(0)),
        });
      }
      return results;
    } finally {
      lock.release();
    }
  }

  /**
   * Fetch additional messages from a mailbox whose References/In-Reply-To
   * mention any of the given root Message-Ids. Used to reconstruct thread
   * context for a candidate message.
   *
   * Caps the result at `maxMessages` (default 50) to defend against cycles
   * or huge threads.
   */
  async fetchThreadContext(
    mailbox: string,
    rootMessageIds: string[],
    maxMessages = 50
  ): Promise<Array<EmailMessage & { snippet: string }>> {
    if (rootMessageIds.length === 0) return [];
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const results: Array<EmailMessage & { snippet: string }> = [];
      const seenUids = new Set<number>();

      for (const root of rootMessageIds) {
        const orQuery = {
          or: [
            { header: { References: root } },
            { header: { 'In-Reply-To': root } },
            { header: { 'Message-Id': root } },
          ],
        };
        const searchResult = await this.client.search(orQuery as any, { uid: true });
        const uids = Array.isArray(searchResult) ? searchResult : [];
        const newUids = uids.filter((u) => !seenUids.has(u));
        for (const u of newUids) seenUids.add(u);
        if (newUids.length === 0) continue;

        // Limit per-root to protect against cycles
        const clipped = newUids.slice(0, maxMessages - results.length);
        if (clipped.length === 0) break;

        for await (const msg of this.client.fetch(
          clipped.join(','),
          {
            uid: true,
            envelope: true,
            flags: true,
            source: { start: 0, maxLength: 2048 },
          },
          { uid: true }
        )) {
          const source = msg.source?.toString('utf-8') ?? '';
          const inReplyTo = extractHeader(source, 'In-Reply-To');
          const references =
            extractHeader(source, 'References')?.split(/\s+/).filter(Boolean) ?? [];

          results.push({
            uid: msg.uid,
            messageId: msg.envelope?.messageId ?? `${msg.uid}@unknown`,
            from: toParticipant(msg.envelope?.from?.[0]),
            to: toParticipants(msg.envelope?.to),
            cc: toParticipants(msg.envelope?.cc),
            date: msg.envelope?.date?.toISOString() ?? new Date().toISOString(),
            subject: msg.envelope?.subject ?? '(no subject)',
            bodyText: '',
            inReplyTo: inReplyTo ?? undefined,
            references,
            flags: Array.from(msg.flags ?? []),
            mailbox,
            snippet: extractSnippet(msg.source ?? Buffer.alloc(0)),
          });
          if (results.length >= maxMessages) break;
        }
        if (results.length >= maxMessages) break;
      }

      // Sort chronologically
      results.sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
      );
      return results;
    } finally {
      lock.release();
    }
  }

  async listMailboxes(): Promise<Array<{
    path: string;
    name: string;
    specialUse: string | null;
    delimiter: string;
    flags: string[];
  }>> {
    const raw = await this.client.list();
    return raw.map((mb: any) => ({
      path: mb.path,
      name: mb.name,
      specialUse: mb.specialUse ?? null,
      delimiter: mb.delimiter ?? '/',
      flags: Array.from(mb.flags ?? []),
    }));
  }

  async fetchMessage(mailbox: string, uid: number): Promise<EmailMessage> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const result = await this.client.fetchOne(
        String(uid),
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          source: true,
        },
        { uid: true }
      );

      if (!result) {
        throw new Error(`Message not found: UID ${uid} in ${mailbox}`);
      }

      const msg = result;

      const fromAddr = toParticipant(msg.envelope?.from?.[0]);
      const toAddrs = toParticipants(msg.envelope?.to);
      const ccAddrs = toParticipants(msg.envelope?.cc);

      // Parse headers from source for threading
      const source = msg.source?.toString('utf-8') ?? '';
      const inReplyTo = extractHeader(source, 'In-Reply-To');
      const references = extractHeader(source, 'References')
        ?.split(/\s+/)
        .filter(Boolean) ?? [];
      const rawListUnsubscribe = extractHeader(source, 'List-Unsubscribe');
      const listUnsubscribePost = extractHeader(source, 'List-Unsubscribe-Post');

      // Extract body text (simplified - real implementation would parse MIME)
      const bodyText = extractBodyText(source);

      return {
        uid: msg.uid,
        messageId: msg.envelope?.messageId ?? `${uid}@unknown`,
        from: fromAddr,
        to: toAddrs,
        cc: ccAddrs,
        date: msg.envelope?.date?.toISOString() ?? new Date().toISOString(),
        subject: msg.envelope?.subject ?? '(no subject)',
        bodyText,
        inReplyTo: inReplyTo ?? undefined,
        references,
        flags: Array.from(msg.flags ?? []),
        listUnsubscribe: rawListUnsubscribe != null
          ? parseListUnsubscribe(rawListUnsubscribe, listUnsubscribePost ?? undefined)
          : undefined,
        mailbox,
      };
    } finally {
      lock.release();
    }
  }

  async fetchMessages(
    mailbox: string,
    uids: number[]
  ): Promise<EmailMessage[]> {
    const messages: EmailMessage[] = [];
    for (const uid of uids) {
      messages.push(await this.fetchMessage(mailbox, uid));
    }
    return messages;
  }

  async moveMessages(
    uids: number[],
    fromMailbox: string,
    toMailbox: string
  ): Promise<void> {
    const lock = await this.client.getMailboxLock(fromMailbox);
    try {
      await this.client.messageMove(uids.join(','), toMailbox, { uid: true });
    } finally {
      lock.release();
    }
  }

  async setFlags(
    uids: number[],
    flags: string[],
    mailbox: string
  ): Promise<void> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      await this.client.messageFlagsAdd(uids.join(','), flags, { uid: true });
    } finally {
      lock.release();
    }
  }

  async removeFlags(
    uids: number[],
    flags: string[],
    mailbox: string
  ): Promise<void> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      await this.client.messageFlagsRemove(uids.join(','), flags, {
        uid: true,
      });
    } finally {
      lock.release();
    }
  }

  async createDraft(
    raw: Buffer
  ): Promise<{ uid: number }> {
    const draftsPath = await this.getMailboxPath('drafts');
    const result = await this.client.append(draftsPath, raw, ['\\Draft']);
    return { uid: (result as any)?.uid ?? 0 };
  }

  async mailboxExists(name: string): Promise<boolean> {
    const mailboxes = await this.client.list();
    return mailboxes.some((mb: any) => mb.path === name);
  }

  async renameMailbox(from: string, to: string): Promise<void> {
    await this.client.mailboxRename(from, to);
  }

  async listMessageUids(mailbox: string): Promise<number[]> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const result = await this.client.search({ all: true }, { uid: true });
      return Array.isArray(result) ? result : [];
    } finally {
      lock.release();
    }
  }

  async deleteMailbox(name: string): Promise<void> {
    await this.client.mailboxDelete(name);
  }

  async ensureMailbox(name: string): Promise<void> {
    try {
      await this.client.mailboxCreate(name);
    } catch {
      // Mailbox may already exist
    }
  }

  /**
   * Fetch a short text preview of a message body.
   *
   * Walks the bodyStructure to find the first text/plain part (falling back to
   * text/html), downloads up to 4 KiB of it, and passes the result through
   * extractSnippetFromPart to produce a ≤500-char string. Returns '' on any error.
   */
  async fetchSnippet(mailbox: string, uid: number): Promise<string> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const msg = await this.client.fetchOne(
        String(uid),
        { bodyStructure: true },
        { uid: true }
      );
      if (!msg || !msg.bodyStructure) return '';

      const part = findTextPart(msg.bodyStructure);
      if (!part) return '';

      const downloaded = await this.client.download(
        String(uid),
        part.partId || '1',
        { uid: true, maxBytes: 4096 }
      );
      if (!downloaded || !downloaded.content) return '';

      const content = await streamToString(downloaded.content);
      return extractSnippetFromPart({ type: part.type as SnippetSource['type'], content });
    } catch {
      return '';
    } finally {
      lock.release();
    }
  }

  async getMailboxPath(
    name: 'inbox' | 'drafts' | 'sent' | 'trash' | 'holding'
  ): Promise<string> {
    if (name === 'holding') {
      await this.ensureMailbox('agent-mail-holding');
      return 'agent-mail-holding';
    }

    const mailboxes = await this.client.list();
    for (const mb of mailboxes) {
      const specialUse = (mb as any).specialUse;
      if (name === 'inbox' && specialUse === '\\Inbox') return mb.path;
      if (name === 'drafts' && specialUse === '\\Drafts') return mb.path;
      if (name === 'sent' && specialUse === '\\Sent') return mb.path;
      if (name === 'trash' && specialUse === '\\Trash') return mb.path;
    }

    // Fallback to common names
    const fallbacks: Record<string, string> = {
      inbox: 'INBOX',
      drafts: 'Drafts',
      sent: 'Sent',
      trash: 'Trash',
    };
    return fallbacks[name] ?? name;
  }
}

function extractHeader(source: string, name: string): string | null {
  const regex = new RegExp(`^${name}:\\s*(.+?)(?:\\r?\\n(?!\\s)|$)`, 'im');
  const match = source.match(regex);
  return match ? match[1].trim() : null;
}

export function extractListHeadersFromSource(source: string): {
  listId: string | null;
  listUnsubscribe: string | null;
} {
  return {
    listId: extractHeader(source, 'List-Id'),
    listUnsubscribe: extractHeader(source, 'List-Unsubscribe'),
  };
}

/**
 * Walk an ImapFlow bodyStructure tree to find the first text/plain part.
 * Falls back to text/html if no plain part is found.
 * Returns null if no text part is found at all.
 */
function findTextPart(
  node: { type?: string; part?: string; childNodes?: unknown[] } | null | undefined
): { type: 'text/plain' | 'text/html'; partId: string } | null {
  if (!node) return null;
  const t = (node.type ?? '').toLowerCase();

  if (t === 'text/plain' && node.part) {
    return { type: 'text/plain', partId: node.part };
  }
  if (t === 'text/html' && node.part) {
    // keep searching for plain, but save this as fallback
    // handled below via two-pass approach
  }

  if (node.childNodes && Array.isArray(node.childNodes)) {
    // First pass: look for plain
    for (const child of node.childNodes) {
      const found = findTextPart(child as any);
      if (found?.type === 'text/plain') return found;
    }
    // Second pass: accept html
    for (const child of node.childNodes) {
      const found = findTextPart(child as any);
      if (found) return found;
    }
  }

  // This node is html (no plain found in children)
  if (t === 'text/html' && node.part) {
    return { type: 'text/html', partId: node.part };
  }

  return null;
}

/** Consume a ReadableStream to a UTF-8 string. */
async function streamToString(stream: NodeJS.ReadableStream | ReadableStream): Promise<string> {
  // Node.js Readable stream
  if (typeof (stream as any).read === 'function' || typeof (stream as any).on === 'function') {
    const nodeStream = stream as NodeJS.ReadableStream;
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      nodeStream.on('data', (chunk: Buffer | string) => {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      });
      nodeStream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      nodeStream.on('error', reject);
    });
  }
  // WHATWG ReadableStream
  const reader = (stream as ReadableStream).getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }
  return new TextDecoder().decode(merged);
}

function extractBodyText(source: string): string {
  // Simple extraction: everything after the first blank line
  const parts = source.split(/\r?\n\r?\n/);
  if (parts.length > 1) {
    return parts.slice(1).join('\n\n').substring(0, 5000);
  }
  return '';
}
