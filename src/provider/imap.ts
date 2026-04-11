import { ImapFlow } from 'imapflow';
import type { AccountConfig, EmailMessage, SearchCriteria } from '../types.js';

export class ImapProvider {
  private client: ImapFlow;
  private account: AccountConfig;

  constructor(account: AccountConfig) {
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
  ): Promise<Array<{ uid: number; envelope: { subject: string; from: string; date: string }; snippet: string; flags: string[] }>> {
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

      // Default: search all if no criteria
      const query = Object.keys(searchQuery).length > 0 ? searchQuery : { all: true };

      const results: Array<{
        uid: number;
        envelope: { subject: string; from: string; date: string };
        snippet: string;
        flags: string[];
      }> = [];

      let count = 0;
      for await (const msg of this.client.fetch(query as any, {
        uid: true,
        envelope: true,
        flags: true,
        bodyStructure: true,
        source: { start: 0, maxLength: 256 }, // snippet
      })) {
        if (count >= limit) break;
        const fromAddr =
          msg.envelope?.from?.[0]
            ? `${msg.envelope.from[0].name ?? ''} <${msg.envelope.from[0].address ?? ''}>`
            : 'unknown';

        results.push({
          uid: msg.uid,
          envelope: {
            subject: msg.envelope?.subject ?? '(no subject)',
            from: fromAddr,
            date: msg.envelope?.date?.toISOString() ?? new Date().toISOString(),
          },
          snippet: msg.source?.toString('utf-8', 0, 200) ?? '',
          flags: Array.from(msg.flags ?? []),
        });
        count++;
      }
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

      const fromAddr =
        msg.envelope?.from?.[0]
          ? `${msg.envelope.from[0].name ?? ''} <${msg.envelope.from[0].address ?? ''}>`
          : 'unknown';

      const toAddrs = (msg.envelope?.to ?? []).map(
        (a: any) => `${a.name ?? ''} <${a.address ?? ''}>`
      );

      const ccAddrs = (msg.envelope?.cc ?? []).map(
        (a: any) => `${a.name ?? ''} <${a.address ?? ''}>`
      );

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
