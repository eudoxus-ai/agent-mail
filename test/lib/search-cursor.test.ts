import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../../src/lib/search-cursor.js';

describe('search cursor', () => {
  it('round-trips a date + uid tuple', () => {
    const c = encodeCursor({ before: '2026-04-18T10:00:00Z', lastUid: 42 });
    expect(decodeCursor(c)).toEqual({ before: '2026-04-18T10:00:00Z', lastUid: 42 });
  });
  it('returns null for invalid cursor', () => {
    expect(decodeCursor('garbage')).toBeNull();
  });
  it('returns null for malformed payload', () => {
    const bad = Buffer.from(JSON.stringify({ foo: 'bar' })).toString('base64url');
    expect(decodeCursor(bad)).toBeNull();
  });
});
