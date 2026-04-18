import { describe, it, expect } from 'vitest';
import { buildOverviewRecommendations } from '../../src/tools/get-overview.js';

describe('buildOverviewRecommendations', () => {
  it('recommends list_senders when >30 senders have count>=4', () => {
    const senders = Array.from({ length: 31 }, (_, i) => ({ from: `s${i}@x`, count: 4 }));
    const recs = buildOverviewRecommendations(senders);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatch(/`list_senders` will let you make sender-level decisions/);
    expect(recs[0]).toContain('31 senders');
  });

  it('does not recommend when exactly 30 heavy senders', () => {
    const senders = Array.from({ length: 30 }, (_, i) => ({ from: `s${i}@x`, count: 4 }));
    expect(buildOverviewRecommendations(senders)).toEqual([]);
  });

  it('does not recommend when counts are low', () => {
    expect(buildOverviewRecommendations([{ from: 'a@x', count: 2 }])).toEqual([]);
  });
});
