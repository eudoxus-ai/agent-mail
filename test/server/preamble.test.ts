import { describe, it, expect } from 'vitest';
import { buildServerOptions } from '../../src/server/server.js';

describe('MCP server preamble', () => {
  it('sets instructions string explaining the reversibility contract', () => {
    const opts = buildServerOptions();
    expect(opts.instructions).toMatch(/no action it exposes can cause irreversible harm/);
    expect(opts.instructions).toMatch(/undo_intent/);
    expect(opts.instructions).toMatch(/restore_messages/);
    expect(opts.instructions).toMatch(/Over-holding-then-restoring is a normal interaction pattern/);
  });
});
