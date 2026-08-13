import { describe, it, expect, vi } from 'vitest';
import { ImapSyncProvider } from '../../src/provider/imap-sync.js';
import type { ImapProvider } from '../../src/provider/imap.js';

/**
 * The adapter must forward `vanishedReliable`.
 *
 * `DeltaChanges.vanishedReliable` is optional and the sync engine treats
 * `undefined` as reliable, so dropping it silently disables the UID
 * reconciliation that is the only way deletions propagate on a server with
 * CONDSTORE but not QRESYNC. The fake provider used by the sync tests set the
 * flag correctly while the real adapter did not, so the whole suite stayed
 * green over a cache that would never have expired a deleted message.
 */

function providerStub(overrides: Partial<ImapProvider> = {}): ImapProvider {
  return {
    qresyncDelta: vi.fn(),
    fetchSyncEnvelopes: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ImapProvider;
}

describe('ImapSyncProvider.delta', () => {
  it('forwards vanishedReliable: false from a CONDSTORE-only server', async () => {
    const imap = providerStub({
      qresyncDelta: vi.fn().mockResolvedValue({
        uidValidity: 1,
        highestModseq: 10,
        vanished: [],
        changed: [],
        vanishedReliable: false,
      }),
    } as Partial<ImapProvider>);

    const delta = await new ImapSyncProvider(imap).delta('INBOX', {
      uidValidity: 1,
      highestModseq: 5,
    });

    expect(delta?.vanishedReliable).toBe(false);
  });

  it('forwards vanishedReliable: true when QRESYNC is available', async () => {
    const imap = providerStub({
      qresyncDelta: vi.fn().mockResolvedValue({
        uidValidity: 1,
        highestModseq: 10,
        vanished: [7],
        changed: [],
        vanishedReliable: true,
      }),
    } as Partial<ImapProvider>);

    const delta = await new ImapSyncProvider(imap).delta('INBOX', {
      uidValidity: 1,
      highestModseq: 5,
    });

    expect(delta?.vanishedReliable).toBe(true);
    expect(delta?.vanished).toEqual([7]);
  });

  it('forwards the flag on the UIDVALIDITY-mismatch path too', async () => {
    const imap = providerStub({
      qresyncDelta: vi.fn().mockResolvedValue({
        uidValidity: 99,
        highestModseq: null,
        vanished: [],
        changed: [],
        vanishedReliable: false,
      }),
    } as Partial<ImapProvider>);

    const delta = await new ImapSyncProvider(imap).delta('INBOX', {
      uidValidity: 1,
      highestModseq: 5,
    });

    expect(delta?.uidValidity).toBe(99);
    expect(delta?.vanishedReliable).toBe(false);
  });

  it('returns null when the server supports neither extension', async () => {
    const imap = providerStub({
      qresyncDelta: vi.fn().mockResolvedValue(null),
    } as Partial<ImapProvider>);

    expect(
      await new ImapSyncProvider(imap).delta('INBOX', { uidValidity: 1, highestModseq: 5 })
    ).toBeNull();
  });

  it('does not refetch a UID reported as both changed and vanished', async () => {
    const fetchSyncEnvelopes = vi.fn().mockResolvedValue([]);
    const imap = providerStub({
      qresyncDelta: vi.fn().mockResolvedValue({
        uidValidity: 1,
        highestModseq: 10,
        vanished: [7],
        changed: [7, 8],
        vanishedReliable: true,
      }),
      fetchSyncEnvelopes,
    } as Partial<ImapProvider>);

    await new ImapSyncProvider(imap).delta('INBOX', { uidValidity: 1, highestModseq: 5 });

    // Refetching a dead UID errors on some servers.
    expect(fetchSyncEnvelopes).toHaveBeenCalledWith('INBOX', [8]);
  });
});
