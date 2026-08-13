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

  it('tells the agent what queued means and where to look when work stalls', () => {
    const opts = buildServerOptions();

    // An agent that does not know `queued` is a normal intermediate state
    // reads it as a failure and retries — which duplicates the mutation the
    // moment the daemon comes back.
    expect(opts.instructions).toMatch(/queued/);
    expect(opts.instructions).toMatch(/get_diagnostics/);
    expect(opts.instructions).toMatch(/duplicate/i);
  });
});
