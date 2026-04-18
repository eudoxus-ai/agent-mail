import { describe, it, expect } from 'vitest';
import { restoreMessagesTool } from '../../src/tools/restore-messages.js';

describe('restore_messages tool', () => {
  it('has reversibility-first description', () => {
    expect(restoreMessagesTool.name).toBe('restore_messages');
    expect(restoreMessagesTool.description.startsWith(
      'Move messages out of the holding folder back to their original mailbox. Fully reversible'
    )).toBe(true);
  });
  it('annotations: not read-only, not destructive, idempotent', () => {
    expect(restoreMessagesTool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
  });
  it('accepts targets and dry_run', () => {
    const parsed = restoreMessagesTool.inputSchema.parse({
      targets: [{ account_id: 'a@x.com', uid: 1 }],
      dry_run: false,
    });
    expect(parsed.targets).toHaveLength(1);
  });
});
