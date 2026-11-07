import { ImapFlow } from 'imapflow';
import type { ResolvedAccount, EmailMessage, SearchCriteria, Participant } from '../types.js';
import { parseListUnsubscribe } from '../lib/list-unsubscribe.js';
import { isSentMailbox } from '../lib/sent-mailboxes.js';
import { parseMessageIds } from '../lib/message-ids.js';
import { pickNewestUids } from './search-ordering.js';
import { extractSnippet, extractSnippetFromPart, getHeader, htmlToText, splitHeadersBody } from './mime.js';
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

/**
 * What a listing needs from each message, asked for by name.
 *
 * Reading a fixed prefix of the source does not work: real mail carries 4-9 KB
 * of Received/ARC/DKIM headers first, so a 2 KB prefix holds none of the
 * threading or list headers and never reaches the body. Everything downstream
 * of a missing header fails quietly rather than loudly: list mail is filed as
 * personal, and replies go undetected by the `when_thread_has_replies` gate.
 */
const PREVIEW_QUERY = {
  headers: [
    'content-type',
    'content-transfer-encoding',
    'in-reply-to',
    'references',
    'list-id',
    'list-unsubscribe',
    'list-unsubscribe-post',
  ],
  bodyParts: [{ key: 'TEXT', start: 0, maxLength: 2048 }],
};

/** Message-Ids per reply SEARCH. Two OR terms each, so 40 terms per command. */
const REPLY_SEARCH_CHUNK = 20;

function readPreview(msg: {
  headers?: Buffer;
  bodyParts?: Map<string, Buffer>;
}): { headers: string; snippet: string } {
  const headers = msg.headers?.toString('utf-8') ?? '';
  const body = msg.bodyParts?.get('text')?.toString('utf-8') ?? '';
  return { headers, snippet: extractSnippet(`${headers.trimEnd()}\r\n\r\n${body}`) };
}

export interface ImapProviderOptions {
  /** Called when the connection dies asynchronously, outside any awaited call. */
  onError?: (error: Error) => void;
}

export class ImapProvider {
  private client: ImapFlow;
  private account: ResolvedAccount;
  private dead = false;
  private lastError: Error | null = null;

  constructor(account: ResolvedAccount, options: ImapProviderOptions = {}) {
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
      // Required for the local cache's delta sync. Without it, EXPUNGE
      // notifications carry sequence numbers instead of UIDs, so
      // qresyncDelta() cannot tell which cached message was deleted and
      // deletions would never propagate — messages removed in another client
      // would linger in the cache indefinitely.
      qresync: true,
      // Bound the wait for a server that stops responding. Without these a
      // half-open connection produces no error and no data — the operation
      // just never settles, and because pool borrows are serialized that
      // wedges the whole account. These make it surface as an error the pool
      // can act on.
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      // Generous: a large SEARCH or MOVE on a slow provider is legitimately
      // quiet for a while, so this is only meant to catch a truly dead socket.
      socketTimeout: 5 * 60_000,
    });

    // ImapFlow is an EventEmitter, and Node throws on an 'error' event with no
    // registered listener — an uncaught exception that kills the process.
    //
    // A pooled connection sitting idle gets its TLS socket reset routinely
    // (iCloud in particular). That arrives asynchronously, outside any awaited
    // call, so withConnection's try/catch never sees it. Without this listener
    // a routine ECONNRESET takes down the whole MCP server mid-request: the
    // client waits forever for a response that no longer has a process to come
    // from, and any IMAP work already committed stays committed.
    this.client.on('error', (error: Error) => {
      this.dead = true;
      this.lastError = error;
      options.onError?.(error);
    });

    // A clean server-side close is equally fatal to reuse, just not an error.
    this.client.on('close', () => {
      this.dead = true;
    });
  }

  /** True once the connection has errored or closed; the pool must not reuse it. */
  isDead(): boolean {
    return this.dead;
  }

  /** The error that killed the connection, for logging. */
  getLastError(): Error | null {
    return this.lastError;
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.dead = false;
    this.lastError = null;
    this.repairEnabledExtensions();
  }

  /** Whether connect() had to patch imapflow's enabled-extension set. */
  private enableHandshakeRepaired = false;

  /**
   * Work around iCloud's broken ENABLE handshake.
   *
   * imapflow sends `ENABLE CONDSTORE UTF8=ACCEPT QRESYNC` on connect and
   * records what got enabled from the untagged `* ENABLED ...` response. iCloud
   * processes the command but replies with a bare tagged OK and no untagged
   * response, so imapflow's `enabled` set stays empty — and imapflow silently
   * drops the CHANGEDSINCE fetch modifier unless that set contains CONDSTORE
   * (lib/commands/fetch.js). The result: no modseq from STATUS, no usable
   * delta fetch, and every mailbox rescanned on the fallback path forever.
   *
   * The session genuinely has the extensions active server-side — the server
   * accepted the ENABLE — so recording that fact where imapflow looks for it
   * is correcting imapflow's model, not lying to it. Guarded three ways: the
   * server must advertise ENABLE (or imapflow never sent the command), must
   * advertise the specific extension (patching in one the server cannot serve
   * would turn clean fallbacks into protocol errors), and a compliant
   * handshake is left untouched.
   */
  private repairEnabledExtensions(): void {
    this.enableHandshakeRepaired = false;
    const caps = this.client.capabilities;
    const enabled = (this.client as unknown as { enabled?: Set<string> }).enabled;
    if (!enabled || !caps.has('ENABLE')) return;

    for (const extension of ['CONDSTORE', 'QRESYNC']) {
      if (caps.has(extension) && !enabled.has(extension)) {
        enabled.add(extension);
        this.enableHandshakeRepaired = true;
      }
    }
  }

  /**
   * What this session can do for sync, and whether it needed the iCloud
   * workaround to do it. Logged by the daemon so a mailbox stuck on the
   * fallback path is explainable from the log alone.
   */
  syncCapabilities(): {
    condstore: boolean;
    qresync: boolean;
    enabled: string[];
    enable_handshake_repaired: boolean;
  } {
    const enabled = (this.client as unknown as { enabled?: Set<string> }).enabled;
    return {
      condstore: this.client.capabilities.has('CONDSTORE'),
      qresync: this.client.capabilities.has('QRESYNC'),
      enabled: enabled ? [...enabled] : [],
      enable_handshake_repaired: this.enableHandshakeRepaired,
    };
  }

  async disconnect(): Promise<void> {
    await this.client.logout();
  }

  /**
   * Drop the connection without a protocol round-trip.
   *
   * `logout()` sends LOGOUT and waits for the server to answer — which a hung
   * connection never will, so tearing one down with logout() hangs the
   * teardown itself. The socket then stays open while a replacement is
   * created, and those orphans accumulate against the provider's per-account
   * connection cap until it refuses or stalls new ones.
   *
   * `close()` destroys the socket locally, so it always completes.
   */
  destroy(): void {
    this.dead = true;
    try {
      this.client.close();
    } catch {
      // Already closed; nothing to do.
    }
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
      if (criteria.listId) searchQuery.header = { 'list-id': criteria.listId };
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
      // imapflow reports a refused search as `false`. iCloud refuses HEADER
      // List-Id, and reading that as an empty result told callers the mailbox
      // had no such mail.
      if (!Array.isArray(searchResult)) {
        throw new Error(`IMAP search failed in ${mailbox}`);
      }
      const allUids: number[] = searchResult;
      if (allUids.length === 0) return [];

      const uidsToFetch = pickNewestUids(allUids, limit);
      if (uidsToFetch.length === 0) return [];

      // Phase 2: hydrate envelopes + preview headers for the selected UIDs.
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
          ...PREVIEW_QUERY,
        },
        { uid: true }
      )) {
        const { headers, snippet } = readPreview(msg);
        const { listId, listUnsubscribe } = extractListHeadersFromSource(headers);
        results.push({
          uid: msg.uid,
          envelope: {
            message_id: msg.envelope?.messageId ?? `${msg.uid}@unknown`,
            subject: msg.envelope?.subject ?? '(no subject)',
            from: toParticipant(msg.envelope?.from?.[0]),
            date: msg.envelope?.date?.toISOString() ?? new Date().toISOString(),
          },
          snippet,
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

  /** Fetch envelopes + preview headers for a specific list of UIDs. Returns EmailMessage objects with a `snippet` field. */
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
          ...PREVIEW_QUERY,
        },
        { uid: true }
      )) {
        const { headers, snippet } = readPreview(msg);
        const inReplyTo = parseMessageIds(extractHeader(headers, 'In-Reply-To'))[0];
        const references = parseMessageIds(extractHeader(headers, 'References'));
        const rawListUnsubscribe = extractHeader(headers, 'List-Unsubscribe');
        const listUnsubscribePost = extractHeader(headers, 'List-Unsubscribe-Post');

        results.push({
          uid: msg.uid,
          messageId: msg.envelope?.messageId ?? `${msg.uid}@unknown`,
          from: toParticipant(msg.envelope?.from?.[0]),
          to: toParticipants(msg.envelope?.to),
          cc: toParticipants(msg.envelope?.cc),
          date: msg.envelope?.date?.toISOString() ?? new Date().toISOString(),
          subject: msg.envelope?.subject ?? '(no subject)',
          bodyText: '',
          inReplyTo,
          references,
          flags: Array.from(msg.flags ?? []),
          listUnsubscribe: rawListUnsubscribe != null
            ? parseListUnsubscribe(rawListUnsubscribe, listUnsubscribePost ?? undefined)
            : undefined,
          mailbox,
          snippet,
        });
      }
      return results;
    } finally {
      lock.release();
    }
  }

  /**
   * True if a message outside `excludeUids` replies to any of `messageIds`.
   *
   * Backs the `when_thread_has_replies` gate, which runs on every sweep. One
   * SEARCH per chunk rather than per message: this was ~95% of a large sender's
   * sweep time. A server hit is confirmed against the parsed headers because
   * HEADER search matches substrings.
   */
  /**
   * The Message-Ids of every thread where another message in this mailbox
   * replies to one of the given messages, including that reply's own ancestry.
   * A message in the result is part of a conversation someone answered.
   */
  async replyThreadIds(
    mailbox: string,
    messageIds: string[],
    excludeUids: number[]
  ): Promise<Set<string>> {
    const wanted = new Set(messageIds);
    const excluded = new Set(excludeUids);
    const thread = new Set<string>();

    for (let start = 0; start < messageIds.length; start += REPLY_SEARCH_CHUNK) {
      const chunk = messageIds.slice(start, start + REPLY_SEARCH_CHUNK);
      const hits = await this.searchReferencing(mailbox, chunk);
      const candidates = hits.filter((uid) => !excluded.has(uid));
      if (candidates.length === 0) continue;

      for (const message of await this.readAncestry(mailbox, candidates)) {
        // The server matches substrings, so a hit is only a candidate.
        if (!message.ancestry.some((id) => wanted.has(id))) continue;
        thread.add(message.messageId);
        for (const id of message.ancestry) thread.add(id);
      }
    }
    return thread;
  }

  /** Which of these Message-Ids belong to a message in this mailbox. */
  async messageIdsIn(mailbox: string, messageIds: string[]): Promise<Set<string>> {
    const wanted = new Set(messageIds);
    const found = new Set<string>();

    for (let start = 0; start < messageIds.length; start += REPLY_SEARCH_CHUNK) {
      const chunk = messageIds.slice(start, start + REPLY_SEARCH_CHUNK);
      const hits = await this.searchAny(
        mailbox,
        chunk.map((id) => ({ header: { 'Message-ID': id } }))
      );
      if (hits.length === 0) continue;
      for (const message of await this.readAncestry(mailbox, hits)) {
        if (wanted.has(message.messageId)) found.add(message.messageId);
      }
    }
    return found;
  }

  private async searchReferencing(mailbox: string, messageIds: string[]): Promise<number[]> {
    return this.searchAny(
      mailbox,
      messageIds.flatMap((id) => [
        { header: { References: id } },
        { header: { 'In-Reply-To': id } },
      ])
    );
  }

  private async searchAny(mailbox: string, terms: object[]): Promise<number[]> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const result = await this.client.search({ or: terms } as any, { uid: true });
      // imapflow reports a failed search as `false`. Reading that as "no hits"
      // would let a sweep through the replies gate unchecked.
      if (!Array.isArray(result)) {
        throw new Error(`Reply search failed in ${mailbox}`);
      }
      return result;
    } finally {
      lock.release();
    }
  }

  /** Headers only: the replies gate has no use for a preview of the body. */
  private async readAncestry(
    mailbox: string,
    uids: number[]
  ): Promise<Array<{ messageId: string; ancestry: string[] }>> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const messages = [];
      for await (const msg of this.client.fetch(
        uids.join(','),
        { uid: true, envelope: true, headers: ['in-reply-to', 'references'] },
        { uid: true }
      )) {
        const headers = msg.headers?.toString('utf-8') ?? '';
        const inReplyTo = parseMessageIds(extractHeader(headers, 'In-Reply-To'))[0];
        const references = parseMessageIds(extractHeader(headers, 'References'));
        messages.push({
          messageId: msg.envelope?.messageId ?? '',
          ancestry: [inReplyTo, ...references].filter((id): id is string => Boolean(id)),
        });
      }
      return messages;
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
            ...PREVIEW_QUERY,
          },
          { uid: true }
        )) {
          const { headers, snippet } = readPreview(msg);
          const inReplyTo = parseMessageIds(extractHeader(headers, 'In-Reply-To'))[0];
          const references = parseMessageIds(extractHeader(headers, 'References'));

          results.push({
            uid: msg.uid,
            messageId: msg.envelope?.messageId ?? `${msg.uid}@unknown`,
            from: toParticipant(msg.envelope?.from?.[0]),
            to: toParticipants(msg.envelope?.to),
            cc: toParticipants(msg.envelope?.cc),
            date: msg.envelope?.date?.toISOString() ?? new Date().toISOString(),
            subject: msg.envelope?.subject ?? '(no subject)',
            bodyText: '',
            inReplyTo,
            references,
            flags: Array.from(msg.flags ?? []),
            mailbox,
            snippet,
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

  async sentMailboxes(): Promise<string[]> {
    const mailboxes = await this.listMailboxes();
    // A \\Noselect folder cannot be opened, so searching one would fail the
    // replies check for every hold on the account.
    return mailboxes
      .filter((m) => isSentMailbox(m) && !m.flags.some((f) => f.toLowerCase() === '\\noselect'))
      .map((m) => m.path);
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
          headers: PREVIEW_QUERY.headers,
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

      const headers = msg.headers?.toString('utf-8') ?? '';
      const inReplyTo = parseMessageIds(extractHeader(headers, 'In-Reply-To'))[0];
      const references = parseMessageIds(extractHeader(headers, 'References'));
      const rawListUnsubscribe = extractHeader(headers, 'List-Unsubscribe');
      const listUnsubscribePost = extractHeader(headers, 'List-Unsubscribe-Post');

      const bodyText = await this.readBodyText(msg.uid, msg.bodyStructure);

      return {
        uid: msg.uid,
        messageId: msg.envelope?.messageId ?? `${uid}@unknown`,
        from: fromAddr,
        to: toAddrs,
        cc: ccAddrs,
        date: msg.envelope?.date?.toISOString() ?? new Date().toISOString(),
        subject: msg.envelope?.subject ?? '(no subject)',
        bodyText,
        inReplyTo,
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

  /**
   * The readable body: the text part, or the HTML part as text when there is no
   * usable text part. Parts are decoded by the download, so this is what a
   * person would read. The caller holds the mailbox lock.
   */
  private async readBodyText(uid: number, structure: unknown): Promise<string> {
    const parts = collectTextParts(structure);
    const text = parts.plain ? await this.downloadPart(uid, parts.plain) : null;
    if (text?.trim()) return text;
    const html = parts.html ? await this.downloadPart(uid, parts.html) : null;
    return html ? htmlToText(html) : '';
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
  ): Promise<{ uidMap: Map<number, number> }> {
    const lock = await this.client.getMailboxLock(fromMailbox);
    try {
      const result = this.client.capabilities.has('MOVE')
        ? await this.client.messageMove(uids.join(','), toMailbox, { uid: true })
        : await this.copyThenDelete(uids, fromMailbox, toMailbox);
      // imapflow reports a failed move as `false`, not by throwing.
      if (!result) {
        throw new Error(`Could not move ${uids.length} message(s) from ${fromMailbox} to ${toMailbox}`);
      }
      // A server may not say where the messages landed. Leave the map empty
      // rather than guess: the source UID means nothing in the destination.
      return { uidMap: result.uidMap instanceof Map ? result.uidMap : new Map() };
    } finally {
      lock.release();
    }
  }

  /**
   * MOVE for a server without it, which includes iCloud. imapflow has its own
   * fallback, but that deletes the source without checking the copy worked,
   * so one refused COPY would lose the mail. Call with the mailbox lock held.
   */
  private async copyThenDelete(uids: number[], fromMailbox: string, toMailbox: string) {
    const copied = await this.client.messageCopy(uids.join(','), toMailbox, { uid: true });
    if (!copied) return false;

    const sources = copied.uidMap instanceof Map ? [...copied.uidMap.keys()] : uids;
    if (sources.length === 0) return copied;

    const deleted = await this.client.messageDelete(sources.join(','), { uid: true });
    if (!deleted) {
      throw new Error(
        `Copied ${sources.length} message(s) but could not remove them, so they are now in both ${fromMailbox} and ${toMailbox}`
      );
    }
    return copied;
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

  async deleteMessage(mailbox: string, uid: number): Promise<void> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      await this.client.messageDelete(String(uid), { uid: true });
    } finally {
      lock.release();
    }
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
      // Callers act on the answer: folder migration deletes a folder it reads
      // as empty, so a failed search must not look like one.
      if (!Array.isArray(result)) {
        throw new Error(`Could not list messages in ${mailbox}`);
      }
      return result;
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

  // === Local cache sync ===================================================
  // These back src/provider/imap-sync.ts, which adapts them to the cache's
  // SyncProvider port. They live here because this class owns the ImapFlow
  // client; the cache layer stays free of any imapflow dependency.

  /** UIDVALIDITY / UIDNEXT / HIGHESTMODSEQ for a mailbox. */
  async mailboxSnapshot(mailbox: string): Promise<{
    uidValidity: number;
    uidNext: number;
    highestModseq: number | null;
    exists: number;
  }> {
    const status = await this.client.status(mailbox, {
      uidNext: true,
      uidValidity: true,
      highestModseq: true,
      messages: true,
    });

    // A server without CONDSTORE simply omits HIGHESTMODSEQ. Reporting null
    // rather than 0 is what routes the sync engine to its fallback path.
    let highestModseq =
      status.highestModseq == null ? null : Number(status.highestModseq);

    // iCloud: CONDSTORE is advertised but the ENABLE handshake is broken — the
    // server replies with a bare tagged OK and omits the untagged `* ENABLED`,
    // so imapflow records the extension as off and STATUS comes back without a
    // modseq. The server did process the ENABLE, though, and SELECT responses
    // carry HIGHESTMODSEQ regardless. Opening the mailbox recovers it, which
    // is the difference between the cheap delta path and rescanning thousands
    // of envelopes every tick forever. Only attempted when the capability is
    // advertised: without it, SELECT cannot answer either and the extra round
    // trip per tick would be pure waste.
    if (highestModseq == null && this.client.capabilities.has('CONDSTORE')) {
      try {
        const lock = await this.client.getMailboxLock(mailbox);
        try {
          const box = this.client.mailbox;
          if (box && typeof box !== 'boolean' && box.highestModseq != null) {
            highestModseq = Number(box.highestModseq);
          }
        } finally {
          lock.release();
        }
      } catch {
        // Degraded, not broken: the fallback sync works without a modseq.
      }
    }

    return {
      uidValidity: Number(status.uidValidity ?? 0),
      uidNext: Number(status.uidNext ?? 0),
      highestModseq,
      exists: Number(status.messages ?? 0),
    };
  }

  /** Every UID in a mailbox, ascending, optionally bounded by date. */
  async listAllUids(mailbox: string, since?: Date): Promise<number[]> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const query = since ? { since } : { all: true };
      const result = await this.client.search(query as any, { uid: true });
      return Array.isArray(result) ? [...result].sort((a, b) => a - b) : [];
    } finally {
      lock.release();
    }
  }

  /**
   * Envelope-level fetch for the cache: everything needed to build a row
   * except the body. Includes BODYSTRUCTURE so attachment metadata is recorded
   * without downloading any payloads (design D1).
   */
  async fetchSyncEnvelopes(
    mailbox: string,
    uids: number[]
  ): Promise<
    Array<{
      uid: number;
      modseq: number | null;
      internalDate: Date | null;
      size: number | null;
      listId: string | null;
      snippet: string;
      attachments: Array<{
        part_id: string;
        filename: string | null;
        mime_type: string | null;
        size: number | null;
      }>;
      message: EmailMessage;
    }>
  > {
    if (uids.length === 0) return [];
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const results = [];
      // Chunked: the UID set becomes the literal FETCH command line, and a
      // delta after the iCloud ENABLE repair has been seen to carry tens of
      // thousands of UIDs — a command hundreds of KB long, which servers may
      // reject outright. 1000 UIDs keeps each command a few KB.
      for (let start = 0; start < uids.length; start += 1000) {
      for await (const msg of this.client.fetch(
        uids.slice(start, start + 1000).join(','),
        {
          uid: true,
          envelope: true,
          flags: true,
          internalDate: true,
          size: true,
          bodyStructure: true,
          ...PREVIEW_QUERY,
        },
        { uid: true }
      )) {
        const { headers, snippet } = readPreview(msg);
        const { listId, listUnsubscribe } = extractListHeadersFromSource(headers);
        const listUnsubscribePost = extractHeader(headers, 'List-Unsubscribe-Post');
        const references = parseMessageIds(extractHeader(headers, 'References'));

        const message: EmailMessage = {
          uid: msg.uid,
          // Unlike the search path, a missing Message-Id is NOT synthesized
          // here. ingest.ts needs to see it as absent so the message gets a
          // synthetic thread instead of joining every other id-less message.
          messageId: msg.envelope?.messageId ?? '',
          from: toParticipant(msg.envelope?.from?.[0]),
          to: toParticipants(msg.envelope?.to),
          cc: toParticipants(msg.envelope?.cc),
          date: msg.envelope?.date?.toISOString() ?? '',
          subject: msg.envelope?.subject ?? '',
          bodyText: '',
          inReplyTo: parseMessageIds(extractHeader(headers, 'In-Reply-To'))[0],
          references,
          flags: Array.from(msg.flags ?? []),
          listUnsubscribe:
            listUnsubscribe != null
              ? parseListUnsubscribe(listUnsubscribe, listUnsubscribePost ?? undefined)
              : undefined,
          mailbox,
        };

        results.push({
          uid: msg.uid,
          modseq: msg.modseq == null ? null : Number(msg.modseq),
          // imapflow types this as string | Date depending on server response.
          internalDate: toDate(msg.internalDate),
          size: msg.size ?? null,
          listId,
          snippet,
          attachments: collectAttachments(msg.bodyStructure),
          message,
        });
      }
      }
      return results;
    } finally {
      lock.release();
    }
  }

  /**
   * Download the text/plain and text/html parts of each message.
   *
   * Deliberately not the full RFC822 source: attachment payloads are what turn
   * a ~300 MB cache into a multi-GB one, and they're rarely the search target.
   */
  async fetchTextParts(
    mailbox: string,
    uids: number[]
  ): Promise<
    Array<{ uid: number; text: string | null; html: string | null; charset: string | null }>
  > {
    if (uids.length === 0) return [];
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const structures = new Map<number, unknown>();
      for await (const msg of this.client.fetch(
        uids.join(','),
        { uid: true, bodyStructure: true },
        { uid: true }
      )) {
        structures.set(msg.uid, msg.bodyStructure);
      }

      const results = [];
      for (const uid of uids) {
        const structure = structures.get(uid);
        if (!structure) continue;

        const parts = collectTextParts(structure);
        if (parts.plain === null && parts.html === null) continue;

        const [text, html] = await Promise.all([
          parts.plain ? this.downloadPart(uid, parts.plain) : Promise.resolve(null),
          parts.html ? this.downloadPart(uid, parts.html) : Promise.resolve(null),
        ]);

        results.push({ uid, text, html, charset: parts.charset });
      }
      return results;
    } finally {
      lock.release();
    }
  }

  private async downloadPart(uid: number, partId: string): Promise<string | null> {
    try {
      const downloaded = await this.client.download(String(uid), partId, { uid: true });
      if (!downloaded?.content) return null;
      return await streamToString(downloaded.content);
    } catch {
      return null;
    }
  }

  /**
   * Download one attachment payload.
   *
   * Attachment bytes are never cached (design D1), so this always hits the
   * server. The size is checked against BODYSTRUCTURE before downloading —
   * refusing a 2 GB part after streaming it to memory would be too late.
   */
  async fetchAttachment(
    mailbox: string,
    uid: number,
    partId: string,
    maxBytes: number
  ): Promise<{
    content: Buffer;
    filename: string | null;
    mimeType: string | null;
  } | null> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const msg = await this.client.fetchOne(
        String(uid),
        { uid: true, bodyStructure: true },
        { uid: true }
      );
      if (!msg || !msg.bodyStructure) return null;

      const meta = collectAttachments(msg.bodyStructure).find(
        (a) => a.part_id === partId
      );
      if (!meta) return null;

      if (meta.size != null && meta.size > maxBytes) {
        throw new Error(
          `Attachment is ${meta.size} bytes, which exceeds the ${maxBytes} byte limit`
        );
      }

      const downloaded = await this.client.download(String(uid), partId, {
        uid: true,
        maxBytes,
      });
      if (!downloaded?.content) return null;

      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of downloaded.content as NodeJS.ReadableStream) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
        total += buf.byteLength;
        // BODYSTRUCTURE size is advisory — enforce again on the real stream so
        // a lying server can't push us past the limit.
        if (total > maxBytes) {
          throw new Error(`Attachment exceeds the ${maxBytes} byte limit`);
        }
        chunks.push(buf);
      }

      return {
        content: Buffer.concat(chunks),
        filename: meta.filename,
        mimeType: meta.mime_type,
      };
    } finally {
      lock.release();
    }
  }

  /**
   * QRESYNC delta: everything that changed since a known MODSEQ, in one round
   * trip. Returns null when the server can't serve one, which routes the sync
   * engine to its UIDNEXT-scan fallback.
   */
  async qresyncDelta(
    mailbox: string,
    known: { uidValidity: number; highestModseq: number }
  ): Promise<{
    uidValidity: number;
    highestModseq: number | null;
    vanished: number[];
    changed: number[];
    vanishedReliable: boolean;
  } | null> {
    if (!this.client.capabilities.has('CONDSTORE') && !this.client.capabilities.has('QRESYNC')) {
      return null;
    }

    // The `qresync: true` constructor option only takes effect if the server
    // actually advertises QRESYNC. On a CONDSTORE-only server, expunges still
    // arrive as sequence numbers — useless for identifying a cached row — so
    // the caller must reconcile deletions a different way.
    const vanishedReliable = this.client.capabilities.has('QRESYNC');

    const vanished: number[] = [];
    const onExpunge = (payload: { uid?: number; vanished?: boolean }) => {
      if (payload?.uid != null) vanished.push(payload.uid);
    };

    this.client.on('expunge', onExpunge);
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const box = this.client.mailbox;
      const uidValidity = Number(
        (box && typeof box !== 'boolean' ? box.uidValidity : undefined) ?? 0
      );

      // A UIDVALIDITY change invalidates the caller's whole view; hand it back
      // so the engine purges rather than merging two UID generations.
      if (uidValidity !== known.uidValidity) {
        return {
          uidValidity,
          highestModseq: null,
          vanished: [],
          changed: [],
          vanishedReliable,
        };
      }

      const changed: number[] = [];
      for await (const msg of this.client.fetch(
        '1:*',
        { uid: true },
        { uid: true, changedSince: BigInt(known.highestModseq) }
      )) {
        changed.push(msg.uid);
      }

      const highestModseq =
        box && typeof box !== 'boolean' && box.highestModseq != null
          ? Number(box.highestModseq)
          : null;

      return { uidValidity, highestModseq, vanished, changed, vanishedReliable };
    } finally {
      lock.release();
      this.client.off('expunge', onExpunge);
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

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

interface BodyNode {
  type?: string;
  part?: string;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  parameters?: Record<string, string>;
  size?: number;
  childNodes?: unknown[];
}

/**
 * Walk a BODYSTRUCTURE collecting attachment metadata — never payloads.
 *
 * A part counts as an attachment when it is explicitly dispositioned as one, or
 * when it carries a filename and isn't one of the text parts we cache inline.
 * Inline images with filenames are included deliberately: a user looking for
 * "the screenshot Bob sent" should find it.
 */
export function collectAttachments(structure: unknown): Array<{
  part_id: string;
  filename: string | null;
  mime_type: string | null;
  size: number | null;
}> {
  const found: Array<{
    part_id: string;
    filename: string | null;
    mime_type: string | null;
    size: number | null;
  }> = [];

  const walk = (node: BodyNode | null | undefined): void => {
    if (!node || typeof node !== 'object') return;

    const type = (node.type ?? '').toLowerCase();
    const disposition = (node.disposition ?? '').toLowerCase();
    const filename =
      node.dispositionParameters?.filename ?? node.parameters?.name ?? null;

    const isMultipart = type.startsWith('multipart/');
    const isCachedText = type === 'text/plain' || type === 'text/html';

    if (
      !isMultipart &&
      node.part &&
      (disposition === 'attachment' || (filename && !isCachedText))
    ) {
      found.push({
        part_id: node.part,
        filename: filename ?? null,
        mime_type: node.type ?? null,
        size: node.size ?? null,
      });
    }

    for (const child of node.childNodes ?? []) {
      walk(child as BodyNode);
    }
  };

  walk(structure as BodyNode);
  return found;
}

/**
 * Locate the text/plain and text/html parts to cache.
 *
 * Both are kept when present: plain text is what gets indexed and searched,
 * HTML is what read_thread renders. A single-part text message has no `part`
 * identifier, so it falls back to '1' — the whole body.
 */
export function collectTextParts(structure: unknown): {
  plain: string | null;
  html: string | null;
  charset: string | null;
} {
  let plain: string | null = null;
  let html: string | null = null;
  let charset: string | null = null;

  const walk = (node: BodyNode | null | undefined): void => {
    if (!node || typeof node !== 'object') return;

    const type = (node.type ?? '').toLowerCase();
    const disposition = (node.disposition ?? '').toLowerCase();

    // An attached message has a body of its own, which is not this message's.
    if (type === 'message/rfc822') return;

    // A text part dispositioned as an attachment (a .txt someone sent) is not
    // the message body and must not be indexed as one.
    if (disposition !== 'attachment') {
      if (type === 'text/plain' && plain === null) {
        plain = node.part ?? '1';
        charset ??= node.parameters?.charset ?? null;
      } else if (type === 'text/html' && html === null) {
        html = node.part ?? '1';
        charset ??= node.parameters?.charset ?? null;
      }
    }

    for (const child of node.childNodes ?? []) {
      walk(child as BodyNode);
    }
  };

  walk(structure as BodyNode);
  return { plain, html, charset };
}

/** Only the header block is searched: a body line can look like a header. */
function extractHeader(source: string, name: string): string | null {
  return getHeader(splitHeadersBody(source).headers, name);
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

