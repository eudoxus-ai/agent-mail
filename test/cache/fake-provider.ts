import type {
  SyncProvider,
  MailboxDescriptor,
  MailboxSnapshot,
  SyncEnvelope,
  FetchedBody,
  DeltaChanges,
} from '../../src/cache/ports.js';
import type { EmailMessage } from '../../src/types.js';

/**
 * In-memory IMAP stand-in for sync tests.
 *
 * Exists so the paths that actually break mail caches — UIDVALIDITY flips,
 * VANISHED responses, servers with no CONDSTORE — can be provoked on demand.
 * None of them are reproducible against a real mailbox when you need them.
 */

export interface FakeMessage {
  uid: number;
  modseq: number;
  messageId: string;
  subject: string;
  from: string;
  date: string;
  flags: string[];
  body?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  internalDate?: Date;
}

export interface FakeMailbox {
  path: string;
  specialUse?: string | null;
  uidValidity: number;
  uidNext: number;
  highestModseq: number | null;
  messages: FakeMessage[];
  /** UIDs expunged since a given modseq, for QRESYNC replay. */
  vanished: Array<{ uid: number; modseq: number }>;
}

export class FakeSyncProvider implements SyncProvider {
  mailboxes: FakeMailbox[];
  /** Set true to simulate a server with no CONDSTORE/QRESYNC. */
  supportsCondstore = true;
  /** Call counters, so tests can assert sync isn't refetching the world. */
  calls = { listUids: 0, fetchEnvelopes: 0, fetchBodies: 0, delta: 0 };
  failOn: { fetchBodies?: boolean } = {};

  constructor(mailboxes: FakeMailbox[]) {
    this.mailboxes = mailboxes;
  }

  private box(path: string): FakeMailbox {
    const mb = this.mailboxes.find((m) => m.path === path);
    if (!mb) throw new Error(`no such mailbox: ${path}`);
    return mb;
  }

  async listMailboxes(): Promise<MailboxDescriptor[]> {
    return this.mailboxes.map((m) => ({
      path: m.path,
      specialUse: m.specialUse ?? null,
    }));
  }

  async snapshot(mailbox: string): Promise<MailboxSnapshot> {
    const mb = this.box(mailbox);
    return {
      uidValidity: mb.uidValidity,
      uidNext: mb.uidNext,
      highestModseq: this.supportsCondstore ? mb.highestModseq : null,
      exists: mb.messages.length,
    };
  }

  async listUids(mailbox: string, options?: { since?: Date }): Promise<number[]> {
    this.calls.listUids += 1;
    const mb = this.box(mailbox);
    return mb.messages
      .filter((m) => !options?.since || new Date(m.date) >= options.since)
      .map((m) => m.uid)
      .sort((a, b) => a - b);
  }

  async fetchEnvelopes(mailbox: string, uids: number[]): Promise<SyncEnvelope[]> {
    this.calls.fetchEnvelopes += 1;
    const mb = this.box(mailbox);
    return mb.messages
      .filter((m) => uids.includes(m.uid))
      .map((m) => toEnvelope(m, mailbox));
  }

  async fetchBodies(mailbox: string, uids: number[]): Promise<FetchedBody[]> {
    this.calls.fetchBodies += 1;
    if (this.failOn.fetchBodies) throw new Error('body fetch failed');
    const mb = this.box(mailbox);
    return mb.messages
      .filter((m) => uids.includes(m.uid))
      .filter((m) => m.body !== undefined || m.html !== undefined)
      .map((m) => ({
        uid: m.uid,
        text: m.body ?? null,
        html: m.html ?? null,
        charset: 'utf-8',
      }));
  }

  async delta(
    mailbox: string,
    known: { uidValidity: number; highestModseq: number }
  ): Promise<DeltaChanges | null> {
    this.calls.delta += 1;
    if (!this.supportsCondstore) return null;

    const mb = this.box(mailbox);
    if (mb.uidValidity !== known.uidValidity) {
      return {
        uidValidity: mb.uidValidity,
        highestModseq: mb.highestModseq,
        vanished: [],
        changed: [],
      };
    }

    return {
      uidValidity: mb.uidValidity,
      highestModseq: mb.highestModseq,
      vanished: mb.vanished
        .filter((v) => v.modseq > known.highestModseq)
        .map((v) => v.uid),
      changed: mb.messages
        .filter((m) => m.modseq > known.highestModseq)
        .map((m) => toEnvelope(m, mailbox)),
    };
  }

  // --- test helpers -------------------------------------------------------

  arrive(mailbox: string, message: Omit<FakeMessage, 'modseq'>): void {
    const mb = this.box(mailbox);
    mb.highestModseq = (mb.highestModseq ?? 0) + 1;
    mb.messages.push({ ...message, modseq: mb.highestModseq });
    mb.uidNext = Math.max(mb.uidNext, message.uid + 1);
  }

  setFlags(mailbox: string, uid: number, flags: string[]): void {
    const mb = this.box(mailbox);
    const msg = mb.messages.find((m) => m.uid === uid);
    if (!msg) throw new Error(`no such uid: ${uid}`);
    mb.highestModseq = (mb.highestModseq ?? 0) + 1;
    msg.flags = flags;
    msg.modseq = mb.highestModseq;
  }

  expunge(mailbox: string, uid: number): void {
    const mb = this.box(mailbox);
    mb.highestModseq = (mb.highestModseq ?? 0) + 1;
    mb.messages = mb.messages.filter((m) => m.uid !== uid);
    mb.vanished.push({ uid, modseq: mb.highestModseq });
  }

  /** Simulate the server reassigning UIDs. */
  bumpUidValidity(mailbox: string, next: number): void {
    const mb = this.box(mailbox);
    mb.uidValidity = next;
    mb.vanished = [];
  }
}

function toEnvelope(m: FakeMessage, mailbox: string): SyncEnvelope {
  const message: EmailMessage = {
    uid: m.uid,
    messageId: m.messageId,
    from: { address: m.from, name: null },
    to: [{ address: 'you@example.com', name: null }],
    cc: [],
    date: m.date,
    subject: m.subject,
    bodyText: '',
    inReplyTo: m.inReplyTo,
    references: m.references ?? [],
    flags: m.flags,
    mailbox,
  };

  return {
    uid: m.uid,
    modseq: m.modseq,
    internalDate: m.internalDate ?? new Date(m.date),
    size: 1024,
    listId: null,
    snippet: '',
    attachments: [],
    message,
  };
}

export function mailbox(
  path: string,
  messages: FakeMessage[],
  overrides: Partial<FakeMailbox> = {}
): FakeMailbox {
  return {
    path,
    specialUse: null,
    uidValidity: 1,
    uidNext: Math.max(0, ...messages.map((m) => m.uid)) + 1,
    highestModseq: Math.max(0, ...messages.map((m) => m.modseq)),
    messages,
    vanished: [],
    ...overrides,
  };
}

export function message(
  uid: number,
  overrides: Partial<FakeMessage> = {}
): FakeMessage {
  return {
    uid,
    modseq: uid,
    messageId: `<msg-${uid}@example.com>`,
    subject: `Subject ${uid}`,
    from: 'alice@example.com',
    date: new Date(Date.UTC(2026, 5, 1, 0, 0, uid)).toISOString(),
    flags: [],
    body: `Body of message ${uid}`,
    ...overrides,
  };
}
