import { describe, it, expect, vi } from 'vitest';
import { locateMessages } from '../../src/executor/locate.js';

function mailbox(uids: number[], byId: Record<string, number[]> = {}) {
  return {
    existingUids: vi.fn(async (_m: string, wanted: number[]) =>
      wanted.filter((uid) => uids.includes(uid))
    ),
    uidsByMessageId: vi.fn(
      async () => new Map(Object.entries(byId).map(([id, hits]) => [id, [...hits]]))
    ),
  };
}

describe('locateMessages', () => {
  it('trusts a recorded UID that still exists, without searching', async () => {
    const imap = mailbox([7]);
    await expect(locateMessages(imap, 'M', [{ uid: 7, messageId: '<a>' }])).resolves.toEqual([7]);
    expect(imap.uidsByMessageId).not.toHaveBeenCalled();
  });

  it('falls back to the Message-Id when the recorded UID has gone', async () => {
    const imap = mailbox([8], { '<a>': [8] });
    await expect(locateMessages(imap, 'M', [{ uid: 7, messageId: '<a>' }])).resolves.toEqual([8]);
  });

  it('finds a message with no recorded UID', async () => {
    const imap = mailbox([8], { '<a>': [8] });
    await expect(locateMessages(imap, 'M', [{ uid: null, messageId: '<a>' }])).resolves.toEqual([8]);
    expect(imap.existingUids).not.toHaveBeenCalled();
  });

  it('gives null when there is nothing to go on', async () => {
    const imap = mailbox([]);
    await expect(
      locateMessages(imap, 'M', [{ uid: 7 }, { uid: null }, { uid: 9, messageId: '<a>' }])
    ).resolves.toEqual([null, null, null]);
  });

  it('hands each copy of a shared Message-Id out once', async () => {
    const imap = mailbox([], { '<a>': [1, 2] });
    await expect(
      locateMessages(imap, 'M', [
        { uid: null, messageId: '<a>' },
        { uid: null, messageId: '<a>' },
        { uid: null, messageId: '<a>' },
      ])
    ).resolves.toEqual([1, 2, null]);
  });

  it('never takes a reserved UID', async () => {
    const imap = mailbox([], { '<a>': [1, 2] });
    await expect(
      locateMessages(imap, 'M', [{ uid: null, messageId: '<a>' }], new Set([1]))
    ).resolves.toEqual([2]);
  });

  it('does not take a copy another target owns by UID', async () => {
    const imap = mailbox([1], { '<a>': [1] });
    await expect(
      locateMessages(imap, 'M', [
        { uid: 1, messageId: '<a>' },
        { uid: null, messageId: '<a>' },
      ])
    ).resolves.toEqual([1, null]);
  });
});
