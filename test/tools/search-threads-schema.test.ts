import { describe, it, expect } from 'vitest';
import { searchThreadsTool } from '../../src/tools/search-threads.js';

describe('search_threads schema', () => {
  it('accepts a `before` ISO8601 cursor', () => {
    const parsed = searchThreadsTool.inputSchema.parse({
      before: '2026-03-18T00:00:00Z',
    });
    expect(parsed.before).toBe('2026-03-18T00:00:00Z');
  });

  it('rejects non-string `before`', () => {
    expect(() =>
      searchThreadsTool.inputSchema.parse({ before: 123 as any })
    ).toThrow();
  });
});
