import { describe, it, expect } from 'vitest';
import { applyCursorBoundary } from '../../src/executor/executor.js';
import { encodeCursor, decodeCursor } from '../../src/lib/search-cursor.js';

/**
 * The cache path must apply the same cursor boundary filter as IMAP.
 *
 * `before` is padded by 1 ms so rows sharing the previous page's boundary
 * timestamp come back rather than being skipped. Returning them unfiltered
 * makes page two repeat page one, and when enough messages share a timestamp
 * the cursor stops advancing entirely.
 */

const BOUNDARY = '2026-06-01T12:00:00.000Z';

function row(uid: number, date = BOUNDARY, account_id = 'work', mailbox = 'INBOX') {
  return { account_id, mailbox, uid, envelope: { date } };
}

describe('applyCursorBoundary', () => {
  it('drops rows already emitted at the boundary timestamp', () => {
    const cursor = decodeCursor(
      encodeCursor({
        before: BOUNDARY,
        boundary_seen: [{ account_id: 'work', mailbox: 'INBOX', uid: 10 }],
      })
    )!;

    const filtered = applyCursorBoundary([row(10), row(11)], cursor);
    expect(filtered.map((r) => r.uid)).toEqual([11]);
  });

  it('keeps rows strictly older than the boundary', () => {
    const cursor = decodeCursor(
      encodeCursor({ before: BOUNDARY, boundary_seen: [] })
    )!;

    const older = row(5, '2026-05-31T00:00:00.000Z');
    expect(applyCursorBoundary([older], cursor).map((r) => r.uid)).toEqual([5]);
  });

  it('drops rows newer than the boundary', () => {
    const cursor = decodeCursor(
      encodeCursor({ before: BOUNDARY, boundary_seen: [] })
    )!;

    const newer = row(99, '2026-06-02T00:00:00.000Z');
    expect(applyCursorBoundary([newer], cursor)).toEqual([]);
  });

  it('does not confuse identical UIDs across accounts', () => {
    const cursor = decodeCursor(
      encodeCursor({
        before: BOUNDARY,
        boundary_seen: [{ account_id: 'work', mailbox: 'INBOX', uid: 10 }],
      })
    )!;

    // UIDs are unique only per account/mailbox; a scalar comparison would
    // wrongly drop the personal account's row.
    const filtered = applyCursorBoundary(
      [row(10, BOUNDARY, 'work'), row(10, BOUNDARY, 'personal')],
      cursor
    );
    expect(filtered.map((r) => r.account_id)).toEqual(['personal']);
  });

  it('does not confuse identical UIDs across mailboxes', () => {
    const cursor = decodeCursor(
      encodeCursor({
        before: BOUNDARY,
        boundary_seen: [{ account_id: 'work', mailbox: 'INBOX', uid: 10 }],
      })
    )!;

    const filtered = applyCursorBoundary(
      [row(10, BOUNDARY, 'work', 'INBOX'), row(10, BOUNDARY, 'work', 'Archive')],
      cursor
    );
    expect(filtered.map((r) => r.mailbox)).toEqual(['Archive']);
  });

  it('makes a second page disjoint from the first', () => {
    const page1 = [row(12), row(11), row(10)];
    const cursor = decodeCursor(
      encodeCursor({
        before: BOUNDARY,
        boundary_seen: page1.map((r) => ({
          account_id: r.account_id,
          mailbox: r.mailbox,
          uid: r.uid,
        })),
      })
    )!;

    // What the padded `before` would fetch again for page two.
    const refetched = [...page1, row(9), row(8)];
    const page2 = applyCursorBoundary(refetched, cursor);

    expect(page2.map((r) => r.uid)).toEqual([9, 8]);
    const overlap = page2.filter((r) => page1.some((p) => p.uid === r.uid));
    expect(overlap).toEqual([]);
  });
});
