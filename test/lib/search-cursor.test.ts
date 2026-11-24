import { describe, it, expect } from 'vitest';
import {
  compareSearchOrder,
  decodeCursor,
  encodeCursor,
} from '../../src/lib/search-cursor.js';

const cursor = { before: '2026-04-18T10:00:00.000Z', account_id: 'a@x.com', mailbox: 'INBOX', uid: 42 };

describe('search cursor', () => {
  it('round-trips the last row of a page', () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('returns null for invalid cursor', () => {
    expect(decodeCursor('garbage')).toBeNull();
  });

  it('returns null for malformed payload', () => {
    const bad = Buffer.from(JSON.stringify({ foo: 'bar' })).toString('base64url');
    expect(decodeCursor(bad)).toBeNull();
  });

  it('returns null when before is not a parseable timestamp (regression)', () => {
    expect(decodeCursor(encodeCursor({ ...cursor, before: 'not-a-date' }))).toBeNull();
  });

  it('returns null for a cursor of the older boundary_seen shape', () => {
    const old = Buffer.from(
      JSON.stringify({
        before: '2026-04-18T10:00:00Z',
        boundary_seen: [{ account_id: 'a@x.com', mailbox: 'INBOX', uid: 42 }],
      })
    ).toString('base64url');
    expect(decodeCursor(old)).toBeNull();
  });

  it('returns null when uid is not an integer', () => {
    expect(decodeCursor(encodeCursor({ ...cursor, uid: '42' as never }))).toBeNull();
  });
});

describe('search order', () => {
  const row = (date: string, account_id: string, mailbox: string, uid: number) => ({
    account_id,
    mailbox,
    uid,
    envelope: { date },
  });

  it('is newest first, then account, mailbox and uid descending', () => {
    const rows = [
      row('2026-04-17T00:00:00.000Z', 'b', 'INBOX', 9),
      row('2026-04-18T00:00:00.000Z', 'a', 'INBOX', 1),
      row('2026-04-18T00:00:00.000Z', 'a', 'INBOX', 2),
      row('2026-04-18T00:00:00.000Z', 'a', 'Sent', 1),
      row('2026-04-18T00:00:00.000Z', 'b', 'INBOX', 1),
    ];
    expect([...rows].sort(compareSearchOrder)).toEqual([
      rows[4],
      rows[3],
      rows[2],
      rows[1],
      rows[0],
    ]);
  });
});
