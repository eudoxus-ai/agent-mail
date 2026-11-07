import { describe, it, expect } from 'vitest';
import { parseMessageIds } from '../../src/lib/message-ids.js';

describe('parseMessageIds', () => {
  it('reads ids separated by whitespace or folding', () => {
    expect(parseMessageIds('<a@x> <b@x>\r\n <c@x>')).toEqual(['<a@x>', '<b@x>', '<c@x>']);
  });

  it('drops the comma that iCloud rejects in a search term', () => {
    expect(parseMessageIds('<a@x>, <b@x>,<c@x>')).toEqual(['<a@x>', '<b@x>', '<c@x>']);
  });

  it('ignores a comment or quoted name beside the id', () => {
    expect(parseMessageIds('"Some One" <a@x> (sent earlier)')).toEqual(['<a@x>']);
  });

  it('gives nothing for a missing or id-less header', () => {
    expect(parseMessageIds(null)).toEqual([]);
    expect(parseMessageIds(undefined)).toEqual([]);
    expect(parseMessageIds('not an id')).toEqual([]);
  });
});
