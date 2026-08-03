import type { EmailMessage } from '../types.js';
import type { AttachmentMeta } from './ingest.js';

/**
 * The seam between the sync engine and IMAP.
 *
 * sync.ts depends on this interface and nothing else, which is what makes the
 * paths that matter testable: a UIDVALIDITY flip, a VANISHED response, a server
 * with no CONDSTORE. None of those can be provoked on demand against a real
 * mailbox, and all of them are exactly where a mail cache goes silently wrong.
 */

export interface MailboxDescriptor {
  path: string;
  /** IMAP special-use flag, e.g. '\\Sent', '\\Archive', '\\All'. */
  specialUse: string | null;
}

export interface MailboxSnapshot {
  uidValidity: number;
  uidNext: number;
  /** null when the server does not advertise CONDSTORE. */
  highestModseq: number | null;
  exists: number;
}

/** An envelope-level message plus the extras ingest needs. */
export interface SyncEnvelope {
  uid: number;
  modseq: number | null;
  internalDate: Date | null;
  size: number | null;
  listId: string | null;
  snippet: string;
  attachments: AttachmentMeta[];
  message: EmailMessage;
}

export interface FetchedBody {
  uid: number;
  text: string | null;
  html: string | null;
  charset: string | null;
}

export interface DeltaChanges {
  uidValidity: number;
  highestModseq: number | null;
  /** UIDs the server reported gone since the known modseq. */
  vanished: number[];
  /** Messages whose MODSEQ advanced — new arrivals and flag changes alike. */
  changed: SyncEnvelope[];
  /**
   * Whether `vanished` can be trusted to list every deletion.
   *
   * False on servers that support CONDSTORE but not QRESYNC: they report
   * expunges as sequence numbers, which are useless for identifying a cached
   * row. The engine reconciles deletions with a UID diff instead. Defaults to
   * true when omitted.
   */
  vanishedReliable?: boolean;
}

export interface SyncProvider {
  listMailboxes(): Promise<MailboxDescriptor[]>;

  snapshot(mailbox: string): Promise<MailboxSnapshot>;

  /** All UIDs in the mailbox, ascending. `since` bounds the backfill window. */
  listUids(mailbox: string, options?: { since?: Date }): Promise<number[]>;

  fetchEnvelopes(mailbox: string, uids: number[]): Promise<SyncEnvelope[]>;

  fetchBodies(mailbox: string, uids: number[]): Promise<FetchedBody[]>;

  /**
   * QRESYNC/CONDSTORE delta since a known point.
   *
   * Returns null when the server can't serve one — no CONDSTORE, or a
   * UIDVALIDITY change that invalidates the client's whole cached view. The
   * caller distinguishes the two by comparing snapshot().uidValidity, and
   * falls back to a UIDNEXT scan plus a flags-only resync.
   */
  delta(
    mailbox: string,
    known: { uidValidity: number; highestModseq: number }
  ): Promise<DeltaChanges | null>;
}
