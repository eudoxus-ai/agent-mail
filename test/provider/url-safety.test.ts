import { describe, expect, it } from 'vitest';
import { assertSafeRemoteUrl } from '../../src/provider/url-safety.js';

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
});
