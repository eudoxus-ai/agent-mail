import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../../src/lib/search-cursor.js';

describe('search cursor', () => {
  it('round-trips a date + boundary_seen tuple', () => {
    const seen = [{ account_id: 'a@x.com', mailbox: 'INBOX', uid: 42 }];
    const c = encodeCursor({ before: '2026-04-18T10:00:00Z', boundary_seen: seen });
    expect(decodeCursor(c)).toEqual({ before: '2026-04-18T10:00:00Z', boundary_seen: seen });
  });
  it('returns null for invalid cursor', () => {
    expect(decodeCursor('garbage')).toBeNull();
  });
  it('returns null for malformed payload', () => {
    const bad = Buffer.from(JSON.stringify({ foo: 'bar' })).toString('base64url');
    expect(decodeCursor(bad)).toBeNull();
  });
  it('returns null when boundary_seen is not an array', () => {
    const bad = Buffer.from(
      JSON.stringify({ before: '2026-04-18T10:00:00Z', boundary_seen: 'nope' })
    ).toString('base64url');
    expect(decodeCursor(bad)).toBeNull();
  });
});
