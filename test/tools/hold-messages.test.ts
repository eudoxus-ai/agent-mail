import { describe, it, expect } from 'vitest';
import { holdMessagesTool } from '../../src/tools/hold-messages.js';

describe('hold_messages tool', () => {
  it('has reversibility-first description leading with the contract', () => {
    expect(holdMessagesTool.name).toBe('hold_messages');
    expect(holdMessagesTool.description).toMatch(/REVERSIBLE for 30 days/);
    expect(holdMessagesTool.description).toMatch(/cannot permanently delete/);
    expect(holdMessagesTool.description).toMatch(/agent-mail-holding/);
  });
  it('marks itself as non-destructive', () => {
    expect(holdMessagesTool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
  });
  it('input schema accepts targets, dry_run, include_summary', () => {
    const parsed = holdMessagesTool.inputSchema.parse({
      targets: [{ account_id: 'a@x.com', uid: 1 }],
      dry_run: true,
      include_summary: true,
    });
    expect(parsed.dry_run).toBe(true);
    expect(parsed.include_summary).toBe(true);
  });
});
