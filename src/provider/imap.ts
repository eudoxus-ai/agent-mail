import { ImapFlow } from 'imapflow';
import type { ResolvedAccount, EmailMessage, SearchCriteria, Participant } from '../types.js';
import { pickNewestUids } from './search-ordering.js';
import { extractSnippet } from './mime.js';

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

  async search(
    mailbox: string,
    criteria: SearchCriteria,
    limit: number = 20
  ): Promise<Array<{ uid: number; envelope: { subject: string; from: Participant; date: string }; snippet: string; flags: string[] }>> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const searchQuery: Record<string, unknown> = {};
      if (criteria.from) searchQuery.from = criteria.from;
      if (criteria.to) searchQuery.to = criteria.to;
      if (criteria.subject) searchQuery.subject = criteria.subject;
      if (criteria.body) searchQuery.body = criteria.body;
      if (criteria.since) searchQuery.since = criteria.since;
      if (criteria.before) searchQuery.before = criteria.before;
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
        envelope: { subject: string; from: Participant; date: string };
        snippet: string;
        flags: string[];
      }> = [];

      for await (const msg of this.client.fetch(
        uidsToFetch.join(','),
        {
          uid: true,
          envelope: true,
          flags: true,
          source: { start: 0, maxLength: 2048 },
        },
        { uid: true }
      )) {
        results.push({
          uid: msg.uid,
          envelope: {
            subject: msg.envelope?.subject ?? '(no subject)',
            from: toParticipant(msg.envelope?.from?.[0]),
            date: msg.envelope?.date?.toISOString() ?? new Date().toISOString(),
          },
          snippet: extractSnippet(msg.source ?? Buffer.alloc(0)),
          flags: Array.from(msg.flags ?? []),
        });
      }

      // Sort descending by date (newest first). IMAP UIDs are usually chronological
      // but not guaranteed, so sort on the envelope date we already have.
      results.sort(
        (a, b) => new Date(b.envelope.date).getTime() - new Date(a.envelope.date).getTime()
      );

      return results;
    } finally {
      lock.release();
    }
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
      const listUnsubscribe = extractHeader(source, 'List-Unsubscribe');

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
        listUnsubscribe: listUnsubscribe ?? undefined,
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

  async ensureMailbox(name: string): Promise<void> {
    try {
      await this.client.mailboxCreate(name);
    } catch {
      // Mailbox may already exist
    }
  }

  async getMailboxPath(
    name: 'inbox' | 'drafts' | 'sent' | 'trash' | 'quarantine'
  ): Promise<string> {
    if (name === 'quarantine') {
      await this.ensureMailbox('agent-mail-quarantine');
      return 'agent-mail-quarantine';
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

function extractBodyText(source: string): string {
  // Simple extraction: everything after the first blank line
  const parts = source.split(/\r?\n\r?\n/);
  if (parts.length > 1) {
    return parts.slice(1).join('\n\n').substring(0, 5000);
  }
  return '';
}
