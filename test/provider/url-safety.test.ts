import { describe, expect, it, vi } from 'vitest';
import { assertSafeRemoteUrl } from '../../src/provider/url-safety.js';

// Mock DNS lookup so tests are hermetic and fast
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

import { lookup } from 'node:dns/promises';

describe('assertSafeRemoteUrl', () => {
  it('rejects loopback IPs', async () => {
    await expect(assertSafeRemoteUrl('http://127.0.0.1/unsubscribe')).rejects.toThrow(
      'blocked private IP range'
    );
  });

  it('rejects localhost hostnames', async () => {
    await expect(assertSafeRemoteUrl('http://localhost/unsubscribe')).rejects.toThrow(
      'blocked local address'
    );
  });

  it('rejects non-http schemes', async () => {
    await expect(assertSafeRemoteUrl('mailto:test@example.com')).rejects.toThrow(
      'Only HTTP(S)'
    );
  });

  it('rejects IPv6 loopback via bracketed URL', async () => {
    await expect(assertSafeRemoteUrl('http://[::1]/unsubscribe')).rejects.toThrow(
      'blocked private IP range'
    );
  });

  it('rejects IPv6 link-local addresses across the full fe80::/10 range', async () => {
    for (const addr of ['fe80::1', 'fe81::1', 'fea0::1', 'febf::1']) {
      await expect(
        assertSafeRemoteUrl(`http://[${addr}]/unsubscribe`)
      ).rejects.toThrow('blocked private IP range');
    }
  });

  it('allows addresses just outside fe80::/10 (fec0::)', async () => {
    // fec0::/10 is deprecated site-local but not link-local — must not be
    // caught by the fe80::/10 check (it will be checked by DNS validation).
    vi.mocked(lookup).mockResolvedValueOnce([
      { address: 'fec0::1', family: 6 },
    ] as never);
    const result = await assertSafeRemoteUrl('https://example.com/unsub');
    expect(result.url.hostname).toBe('example.com');
  });

  it('pins HTTP connections to the resolved IP and sets a Host header', async () => {
    vi.mocked(lookup).mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
    ] as never);

    const { url, headers } = await assertSafeRemoteUrl('http://example.com/unsubscribe');
    expect(url.hostname).toBe('93.184.216.34');
    expect(headers['Host']).toBe('example.com');
  });

  it('does not pin HTTPS connections (TLS cert validation protects against rebinding)', async () => {
    vi.mocked(lookup).mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
    ] as never);

    const { url, headers } = await assertSafeRemoteUrl('https://example.com/unsubscribe');
    expect(url.hostname).toBe('example.com');
    expect(headers).toEqual({});
  });

  it('rejects when DNS resolves to a private address', async () => {
    vi.mocked(lookup).mockResolvedValueOnce([
      { address: '192.168.1.1', family: 4 },
    ] as never);

    await expect(assertSafeRemoteUrl('https://evil.example.com/unsub')).rejects.toThrow(
      'blocked private IP range'
    );
  });
});
