import type { ImapProvider } from './imap.js';
import type {
  SyncProvider,
  MailboxDescriptor,
  MailboxSnapshot,
  SyncEnvelope,
  FetchedBody,
  DeltaChanges,
} from '../cache/ports.js';

/**
 * Adapts ImapProvider to the cache's SyncProvider port.
 *
 * Thin by design: all the IMAP work lives in ImapProvider (which owns the
 * ImapFlow client), and all the sync logic lives in cache/sync.ts. This class
 * exists only so neither has to know about the other.
 */
export class ImapSyncProvider implements SyncProvider {
  constructor(private readonly imap: ImapProvider) {}

  async listMailboxes(): Promise<MailboxDescriptor[]> {
    const boxes = await this.imap.listMailboxes();
    return boxes.map((b) => ({ path: b.path, specialUse: b.specialUse }));
  }

  async snapshot(mailbox: string): Promise<MailboxSnapshot> {
    return this.imap.mailboxSnapshot(mailbox);
  }

  async listUids(mailbox: string, options?: { since?: Date }): Promise<number[]> {
    return this.imap.listAllUids(mailbox, options?.since);
  }

  async fetchEnvelopes(mailbox: string, uids: number[]): Promise<SyncEnvelope[]> {
    return this.imap.fetchSyncEnvelopes(mailbox, uids);
  }

  async fetchBodies(mailbox: string, uids: number[]): Promise<FetchedBody[]> {
    return this.imap.fetchTextParts(mailbox, uids);
  }

  async delta(
    mailbox: string,
    known: { uidValidity: number; highestModseq: number }
  ): Promise<DeltaChanges | null> {
    const raw = await this.imap.qresyncDelta(mailbox, known);
    if (raw === null) return null;

    // UIDVALIDITY moved — hand back the empty delta so the engine purges
    // instead of merging two UID generations.
    if (raw.uidValidity !== known.uidValidity) {
      return {
        uidValidity: raw.uidValidity,
        highestModseq: raw.highestModseq,
        vanished: [],
        changed: [],
      };
    }

    // qresyncDelta returns changed UIDs; hydrate them into full envelopes.
    // Vanished UIDs are excluded — the server can report a UID as both changed
    // and expunged in the same response, and refetching a dead UID errors on
    // some servers.
    const vanishedSet = new Set(raw.vanished);
    const toFetch = raw.changed.filter((uid) => !vanishedSet.has(uid));

    return {
      uidValidity: raw.uidValidity,
      highestModseq: raw.highestModseq,
      vanished: raw.vanished,
      changed: await this.imap.fetchSyncEnvelopes(mailbox, toFetch),
    };
  }
}
