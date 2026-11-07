/**
 * Whether a mailbox holds mail the user sent.
 *
 * The \Sent flag alone is not enough: an account can have a flagged folder
 * holding a few hundred messages and an unflagged `INBOX.Sent Messages` with
 * thousands, written by a mail client that chose its own name.
 */
const SENT_NAME = /^sent( (messages|mail|items))?$/i;

export function isSentMailbox(mailbox: {
  path: string;
  specialUse?: string | null;
  delimiter?: string;
}): boolean {
  if (mailbox.specialUse?.toLowerCase() === '\\sent') return true;
  const segments = mailbox.path.split(mailbox.delimiter ?? '/');
  return SENT_NAME.test(segments[segments.length - 1] ?? '');
}
