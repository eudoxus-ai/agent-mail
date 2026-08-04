import { describe, it, expect, beforeEach } from 'vitest';
import { toFtsMatchQuery } from '../../src/cache/fts-query.js';
import { openCache, type Database } from '../../src/cache/db.js';

describe('toFtsMatchQuery', () => {
  it('quotes bare terms', () => {
    expect(toFtsMatchQuery('pricing')).toBe('"pricing"');
  });

  it('AND-s multiple terms', () => {
    expect(toFtsMatchQuery('q2 pricing')).toBe('"q2" "pricing"');
  });

  it('preserves explicit phrases', () => {
    expect(toFtsMatchQuery('"final offer" pricing')).toBe('"final offer" "pricing"');
  });

  it('supports trailing-star prefix search', () => {
    expect(toFtsMatchQuery('pric*')).toBe('"pric"*');
  });

  it('returns null for empty or whitespace input', () => {
    expect(toFtsMatchQuery('')).toBeNull();
    expect(toFtsMatchQuery('   ')).toBeNull();
    expect(toFtsMatchQuery(null)).toBeNull();
    expect(toFtsMatchQuery(undefined)).toBeNull();
  });

  it('escapes embedded double quotes', () => {
    expect(toFtsMatchQuery('say "hi')).toBe('"say" """hi"');
  });
});

describe('toFtsMatchQuery against real FTS5', () => {
  let db: Database;

  beforeEach(() => {
    db = openCache(':memory:');
    db.prepare(
      `INSERT INTO messages_fts (rowid, subject, body, participants, attachment_names)
       VALUES (1, 'Q2-pricing review', 'the NOT urgent (draft) plan: costs', 'alice@example.com', 'q2-deck.pdf')`
    ).run();
  });

  function match(query: string): number[] {
    const expr = toFtsMatchQuery(query);
    if (!expr) return [];
    return (
      db
        .prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?`)
        .all(expr) as Array<{ rowid: number }>
    ).map((r) => r.rowid);
  }

  // Each of these throws a SQLite syntax error if passed to MATCH unescaped.
  const hostile: Array<[string, string]> = [
    ['hyphen parsed as column filter', 'Q2-pricing'],
    ['colon parsed as column filter', 'subject:pricing'],
    ['unbalanced quote', 'say "hi'],
    ['parenthesis', '(draft)'],
    ['bare operator', 'NOT'],
    ['trailing operator', 'costs AND'],
    ['caret', '^costs'],
    ['braces', '{costs}'],
  ];

  for (const [label, query] of hostile) {
    it(`does not throw on ${label}`, () => {
      expect(() => match(query)).not.toThrow();
    });
  }

  it('finds a hyphenated term', () => {
    expect(match('Q2-pricing')).toEqual([1]);
  });

  it('finds a hyphenated attachment name', () => {
    expect(match('q2-deck.pdf')).toEqual([1]);
  });

  it('treats NOT as a literal word rather than a negation', () => {
    // If NOT were honored as an operator this would exclude the only row.
    expect(match('NOT urgent')).toEqual([1]);
  });

  it('prefix search matches', () => {
    expect(match('pric*')).toEqual([1]);
  });

  it('returns nothing for a term that is absent', () => {
    expect(match('nonexistent')).toEqual([]);
  });
});
