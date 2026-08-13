import { describe, it, expect, vi } from 'vitest';
import { ImapProvider } from '../../src/provider/imap.js';

/**
 * iCloud advertises CONDSTORE but botches the ENABLE handshake.
 *
 * It replies to `ENABLE QRESYNC` with a bare tagged OK and omits the required
 * untagged `* ENABLED` response, so imapflow records the extension as
 * not-enabled — and `STATUS (HIGHESTMODSEQ)` comes back without a modseq. That
 * routed every iCloud mailbox onto the fallback sync path forever: on one real
 * account, re-ingesting the same 6363 envelopes every tick while never once
 * getting the cheap delta.
 *
 * But the server DID process the ENABLE. SELECT responses carry HIGHESTMODSEQ
 * regardless of the handshake, so opening the mailbox recovers the modseq that
 * STATUS withheld — and with a modseq recorded, the sync engine uses the delta
 * path exactly as it does on a well-behaved server.
 */

function makeProvider() {
  return new ImapProvider({
    id: 'icloud',
    email: 'a@icloud.com',
    imap: { host: 'imap.mail.me.com', port: 993, tls: true },
    smtp: { host: 'h', port: 465, tls: true },
    auth: { user: 'u', pass: 'p' },
  });
}

describe('mailboxSnapshot on a server with the iCloud ENABLE bug', () => {
  it('recovers HIGHESTMODSEQ from SELECT when STATUS omits it', async () => {
    const provider = makeProvider();
    const lock = { release: vi.fn() };
    const client = {
      capabilities: new Map([['CONDSTORE', true]]),
      status: vi.fn().mockResolvedValue({
        uidValidity: 42n,
        uidNext: 1000,
        messages: 5,
        // The bug: no highestModseq in STATUS despite the capability.
      }),
      getMailboxLock: vi.fn(async () => {
        // Opening the mailbox populates client.mailbox from the SELECT
        // response, which does include HIGHESTMODSEQ.
        (client as any).mailbox = { uidValidity: 42n, highestModseq: 715194n };
        return lock;
      }),
    };
    (provider as any).client = client;

    const snapshot = await provider.mailboxSnapshot('INBOX');

    expect(snapshot.highestModseq).toBe(715194);
    expect(lock.release).toHaveBeenCalled();
  });

  it('does not bother opening the mailbox when STATUS already answered', async () => {
    const provider = makeProvider();
    const getMailboxLock = vi.fn();
    (provider as any).client = {
      capabilities: new Map([['CONDSTORE', true]]),
      status: vi.fn().mockResolvedValue({
        uidValidity: 42n,
        uidNext: 1000,
        messages: 5,
        highestModseq: 999n,
      }),
      getMailboxLock,
    };

    const snapshot = await provider.mailboxSnapshot('INBOX');

    // SELECT costs a round trip and briefly changes the selected mailbox; on
    // the happy path it has nothing to add.
    expect(snapshot.highestModseq).toBe(999);
    expect(getMailboxLock).not.toHaveBeenCalled();
  });

  it('reports null on a server that genuinely has no CONDSTORE', async () => {
    const provider = makeProvider();
    const getMailboxLock = vi.fn();
    (provider as any).client = {
      capabilities: new Map(),
      status: vi.fn().mockResolvedValue({ uidValidity: 42n, uidNext: 1000, messages: 5 }),
      getMailboxLock,
    };

    const snapshot = await provider.mailboxSnapshot('INBOX');

    // No capability means SELECT will not carry a modseq either — opening the
    // mailbox would be a wasted round trip on every tick, forever, for servers
    // that can never answer.
    expect(snapshot.highestModseq).toBeNull();
    expect(getMailboxLock).not.toHaveBeenCalled();
  });

  it('survives the SELECT probe failing', async () => {
    const provider = makeProvider();
    (provider as any).client = {
      capabilities: new Map([['CONDSTORE', true]]),
      status: vi.fn().mockResolvedValue({ uidValidity: 42n, uidNext: 1000, messages: 5 }),
      getMailboxLock: vi.fn(async () => {
        throw new Error('SELECT failed');
      }),
    };

    // Degraded, not broken: the fallback path still works without a modseq.
    const snapshot = await provider.mailboxSnapshot('INBOX');
    expect(snapshot.highestModseq).toBeNull();
  });
});

/**
 * The other half of the same bug: imapflow drops the CHANGEDSINCE fetch
 * modifier unless its own `enabled` set contains CONDSTORE
 * (imapflow/lib/commands/fetch.js). With iCloud's missing `* ENABLED`
 * response that set stays empty — so even with a recovered modseq, a delta
 * fetch would silently return EVERY message in the mailbox as "changed",
 * which re-ingests the whole mailbox per tick while looking like a working
 * delta path.
 *
 * The server did process the ENABLE (it replied OK), so the session has the
 * extensions active server-side; the repair records that fact where imapflow
 * looks for it.
 */
describe('repairEnabledExtensions', () => {
  function clientWith(capabilities: string[], enabled: string[] = []) {
    return {
      capabilities: new Map(capabilities.map((c) => [c, true])),
      enabled: new Set(enabled),
      connect: vi.fn(async () => {}),
    };
  }

  it('adds CONDSTORE and QRESYNC when advertised but missing from the handshake', async () => {
    const provider = makeProvider();
    const client = clientWith(['ENABLE', 'CONDSTORE', 'QRESYNC']);
    (provider as any).client = client;

    await provider.connect();

    expect(client.enabled.has('CONDSTORE')).toBe(true);
    expect(client.enabled.has('QRESYNC')).toBe(true);
  });

  it('reports that it repaired the session, for diagnostics', async () => {
    const provider = makeProvider();
    (provider as any).client = clientWith(['ENABLE', 'CONDSTORE', 'QRESYNC']);

    await provider.connect();

    const caps = provider.syncCapabilities();
    expect(caps.enable_handshake_repaired).toBe(true);
    expect(caps.condstore).toBe(true);
  });

  it('leaves a compliant server alone', async () => {
    const provider = makeProvider();
    const client = clientWith(['ENABLE', 'CONDSTORE', 'QRESYNC'], ['CONDSTORE', 'QRESYNC']);
    (provider as any).client = client;

    await provider.connect();

    expect(provider.syncCapabilities().enable_handshake_repaired).toBe(false);
  });

  it('does not invent extensions the server never advertised', async () => {
    const provider = makeProvider();
    const client = clientWith(['ENABLE']);
    (provider as any).client = client;

    await provider.connect();

    // Patching these in on a server that cannot serve them would turn every
    // delta fetch into a protocol error instead of a clean fallback.
    expect(client.enabled.has('CONDSTORE')).toBe(false);
    expect(provider.syncCapabilities().enable_handshake_repaired).toBe(false);
  });

  it('does not patch when the server has no ENABLE at all', async () => {
    const provider = makeProvider();
    // No ENABLE capability means imapflow never sent the command, so there is
    // nothing to repair — the extensions were never requested.
    const client = clientWith(['CONDSTORE']);
    (provider as any).client = client;

    await provider.connect();

    expect(client.enabled.has('CONDSTORE')).toBe(false);
  });
});
