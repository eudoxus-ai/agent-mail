/**
 * search_threads order and its cursor.
 *
 * The order is total: newest first, then account_id, mailbox and uid, all
 * descending. A UID is unique only within an account's mailbox, so all four
 * are needed to give every row one place. The cursor is the last row of a
 * page, and the next page is every row after it in that order.
 */

export interface SearchCursor {
  /** ISO8601 date of the last row returned. */
  before: string;
  account_id: string;
  mailbox: string;
  uid: number;
}

export interface Ordered {
  account_id: string;
  mailbox: string;
  uid: number;
  envelope: { date: string };
}

function descending(a: string | number, b: string | number): number {
  if (a === b) return 0;
  return a > b ? -1 : 1;
}

/** Negative when `a` comes first in search_threads order. */
export function compareSearchOrder(a: Ordered, b: Ordered): number {
  return (
    descending(Date.parse(a.envelope.date), Date.parse(b.envelope.date)) ||
    descending(a.account_id, b.account_id) ||
    descending(a.mailbox, b.mailbox) ||
    descending(a.uid, b.uid)
  );
}

export function cursorAt(row: Ordered): SearchCursor {
  return { before: row.envelope.date, account_id: row.account_id, mailbox: row.mailbox, uid: row.uid };
}

/** Whether `row` comes after the cursor, and so belongs on a later page. */
export function isAfterCursor(row: Ordered, cursor: SearchCursor): boolean {
  const { before, ...key } = cursor;
  return compareSearchOrder(row, { ...key, envelope: { date: before } }) > 0;
}

export function encodeCursor(c: SearchCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

/** The cursor, or null for anything else, including cursors of an older shape. */
export function decodeCursor(raw: string): SearchCursor | null {
  try {
    const obj = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!obj || typeof obj !== 'object') return null;
    const { before, account_id, mailbox, uid } = obj;
    if (typeof before !== 'string' || Number.isNaN(Date.parse(before))) return null;
    if (typeof account_id !== 'string' || typeof mailbox !== 'string') return null;
    if (!Number.isInteger(uid)) return null;
    return { before, account_id, mailbox, uid };
  } catch {
    return null;
  }
}
