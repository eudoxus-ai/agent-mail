/**
 * Given an ascending-UID list from IMAP SEARCH, return the newest N UIDs.
 * IMAP UIDs within a mailbox are monotonically assigned, so "newest" == tail.
 */
export function pickNewestUids(uids: readonly number[], limit: number): number[] {
  if (limit <= 0 || uids.length === 0) return [];
  return uids.slice(-limit);
}
