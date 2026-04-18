import { describe, it, expect } from 'vitest';
import {
  quarantineMessagesTool,
  quarantineThreadTool,
} from '../../src/tools/quarantine-thread.js';

describe('quarantine tool aliasing', () => {
  it('exports the new preferred tool named quarantine_messages', () => {
    expect(quarantineMessagesTool.name).toBe('quarantine_messages');
    expect(quarantineMessagesTool.annotations?.destructiveHint).toBe(true);
    expect(quarantineMessagesTool.description).not.toMatch(/DEPRECATED/i);
  });

  it('still exports quarantine_thread as a deprecated alias', () => {
    expect(quarantineThreadTool.name).toBe('quarantine_thread');
    expect(quarantineThreadTool.annotations?.destructiveHint).toBe(true);
    expect(quarantineThreadTool.description).toMatch(/DEPRECATED/i);
    expect(quarantineThreadTool.description).toMatch(/quarantine_messages/);
  });

  it('both tools share the same input schema', () => {
    const payload = {
      targets: [{ account_id: 'a@x.com', uid: 1 }],
      dry_run: true,
    };
    expect(quarantineMessagesTool.inputSchema.parse(payload)).toEqual(
      quarantineThreadTool.inputSchema.parse(payload)
    );
  });
});
