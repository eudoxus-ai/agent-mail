import { describe, it, expect } from 'vitest';
import { pickNewestUids } from '../../src/provider/search-ordering.js';

describe('pickNewestUids', () => {
  it('returns the last N uids from an ascending list', () => {
    const uids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(pickNewestUids(uids, 3)).toEqual([8, 9, 10]);
  });

  it('returns all uids when list shorter than limit', () => {
    expect(pickNewestUids([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });

  it('returns empty array for empty input', () => {
    expect(pickNewestUids([], 10)).toEqual([]);
  });

  it('respects limit of 0', () => {
    expect(pickNewestUids([1, 2, 3], 0)).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const uids = [1, 2, 3, 4, 5];
    pickNewestUids(uids, 2);
    expect(uids).toEqual([1, 2, 3, 4, 5]);
  });
});
