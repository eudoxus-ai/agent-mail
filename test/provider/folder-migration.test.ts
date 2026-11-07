import { describe, it, expect } from 'vitest';
import { migrateHoldingFolder } from '../../src/provider/folder-migration.js';

interface Call { op: string; args: unknown[]; }

function makeImap(opts: {
  hasHolding?: boolean;
  hasQuarantine?: boolean;
  renameOk?: boolean;
  uids?: number[];
  listFails?: boolean;
  moveFails?: boolean;
}) {
  const calls: Call[] = [];
  return {
    calls,
    async mailboxExists(name: string) {
      if (name === 'agent-mail-holding') return opts.hasHolding ?? false;
      if (name === 'agent-mail-quarantine') return opts.hasQuarantine ?? false;
      return false;
    },
    async renameMailbox(from: string, to: string) {
      calls.push({ op: 'rename', args: [from, to] });
      if (!opts.renameOk) throw new Error('rename not supported');
    },
    async ensureMailbox(name: string) {
      calls.push({ op: 'ensure', args: [name] });
    },
    async listMessageUids(mailbox: string) {
      calls.push({ op: 'listUids', args: [mailbox] });
      if (opts.listFails) throw new Error('search failed');
      return opts.uids ?? [];
    },
    async moveMessages(uids: number[], from: string, to: string) {
      calls.push({ op: 'move', args: [uids, from, to] });
      if (opts.moveFails) throw new Error('move failed');
    },
    async deleteMailbox(name: string) {
      calls.push({ op: 'delete', args: [name] });
    },
  };
}

describe('migrateHoldingFolder', () => {
  it('no-op when agent-mail-holding already exists', async () => {
    const imap = makeImap({ hasHolding: true });
    const result = await migrateHoldingFolder(imap);
    expect(result).toEqual({ action: 'noop' });
    expect(imap.calls).toEqual([]);
  });

  it('no-op when neither folder exists', async () => {
    const imap = makeImap({});
    const result = await migrateHoldingFolder(imap);
    expect(result).toEqual({ action: 'noop' });
    expect(imap.calls).toEqual([]);
  });

  it('renames in place when RENAME succeeds', async () => {
    const imap = makeImap({ hasQuarantine: true, renameOk: true });
    const result = await migrateHoldingFolder(imap);
    expect(result).toEqual({ action: 'renamed' });
    expect(imap.calls).toEqual([
      { op: 'rename', args: ['agent-mail-quarantine', 'agent-mail-holding'] },
    ]);
  });

  it('falls back to create+move+delete when RENAME throws', async () => {
    const imap = makeImap({ hasQuarantine: true, renameOk: false, uids: [1, 2, 3] });
    const result = await migrateHoldingFolder(imap);
    expect(result).toEqual({ action: 'copied', moved: 3 });
    expect(imap.calls).toEqual([
      { op: 'rename', args: ['agent-mail-quarantine', 'agent-mail-holding'] },
      { op: 'ensure', args: ['agent-mail-holding'] },
      { op: 'listUids', args: ['agent-mail-quarantine'] },
      { op: 'move', args: [[1, 2, 3], 'agent-mail-quarantine', 'agent-mail-holding'] },
      { op: 'delete', args: ['agent-mail-quarantine'] },
    ]);
  });

  it('keeps the old folder when its messages cannot be listed', async () => {
    const imap = makeImap({ hasQuarantine: true, listFails: true });
    await expect(migrateHoldingFolder(imap)).rejects.toThrow('search failed');
    expect(imap.calls.map((c) => c.op)).not.toContain('delete');
  });

  it('keeps the old folder when its messages cannot be moved', async () => {
    const imap = makeImap({ hasQuarantine: true, uids: [1], moveFails: true });
    await expect(migrateHoldingFolder(imap)).rejects.toThrow('move failed');
    expect(imap.calls.map((c) => c.op)).not.toContain('delete');
  });

  it('fallback with empty source does not call move but still deletes', async () => {
    const imap = makeImap({ hasQuarantine: true, renameOk: false, uids: [] });
    const result = await migrateHoldingFolder(imap);
    expect(result).toEqual({ action: 'copied', moved: 0 });
    const ops = imap.calls.map((c) => c.op);
    expect(ops).toEqual(['rename', 'ensure', 'listUids', 'delete']); // no 'move'
  });
});
