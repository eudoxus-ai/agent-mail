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
      holdBySenderTool.inputSchema.parse({ from: 'x@y', limit: 2000 })
    ).toThrow();
  });

  /**
   * A one- or two-character `from` is not a narrow sweep, it is a silent zero.
   *
   * Measured against iCloud: `UID SEARCH FROM e`, `FROM em`, `FROM om` and
   * `FROM m` all return an empty set no matter what is in the mailbox, while
   * `FROM ema` returns 897. The server reports success either way, so the sweep
   * comes back `no_match` and reads as "this sender has no mail here" — the
   * exact misread the no_match status exists to prevent, arriving through a
   * door no_match cannot see.
   *
   * Rejecting at the schema means it fails before an intent is created, so
   * there is no queued sweep to poll and no ledger row implying work happened.
   */
  it('rejects a from term too short for the server to match', () => {
    expect(() => holdBySenderTool.inputSchema.parse({ from: 'a' })).toThrow();
    expect(() => holdBySenderTool.inputSchema.parse({ from: 'ab' })).toThrow();
    expect(() => holdBySenderTool.inputSchema.parse({ from: 'abc' })).not.toThrow();
  });

  it('says why the short term was rejected, not just that it was', () => {
    // "String must contain at least 3 character(s)" tells the caller a rule
    // exists. It does not tell them the rule is about the server silently
    // returning nothing, which is the part that changes what they do next.
    const result = holdBySenderTool.inputSchema.safeParse({ from: 'a' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((i) => i.message).join(' ');
      expect(message).toMatch(/silent|nothing|no match|zero/i);
    }
  });

  it('is not read-only', () => {
    expect(holdBySenderTool.annotations?.readOnlyHint).toBe(false);
  });
});
