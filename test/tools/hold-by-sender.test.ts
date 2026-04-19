import { describe, it, expect } from 'vitest';
import { holdBySenderTool } from '../../src/tools/hold-by-sender.js';

describe('hold_by_sender tool definition', () => {
  it('requires from', () => {
    expect(() => holdBySenderTool.inputSchema.parse({})).toThrow();
    expect(() => holdBySenderTool.inputSchema.parse({ from: 'x@y' })).not.toThrow();
  });

  it('accepts before + account_ids', () => {
    expect(() =>
      holdBySenderTool.inputSchema.parse({
        from: 'x@y',
        before: '2026-04-18T00:00:00Z',
        account_ids: ['a1'],
      })
    ).not.toThrow();
  });

  it('caps limit at 1000', () => {
    expect(() =>
      holdBySenderTool.inputSchema.parse({ from: 'x', limit: 2000 })
    ).toThrow();
  });

  it('is not read-only', () => {
    expect(holdBySenderTool.annotations?.readOnlyHint).toBe(false);
  });
});
