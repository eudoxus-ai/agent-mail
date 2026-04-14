import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const REQUEST_TIMEOUT_MS = 5_000;

export async function assertSafeRemoteUrl(rawUrl: string): Promise<URL> {
  const url = new URL(rawUrl);

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only HTTP(S) unsubscribe URLs are allowed');
  }

  if (url.username || url.password) {
    throw new Error('Unsubscribe URLs cannot include credentials');
  }

  const hostname = url.hostname.trim().toLowerCase();
  if (!hostname) {
    throw new Error('Unsubscribe URL must include a hostname');
  }

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('Unsubscribe URL targets a blocked local address');
  }

  if (hostname.endsWith('.local')) {
    throw new Error('Unsubscribe URL targets a blocked local network hostname');
  }

  if (isIP(hostname) && isPrivateAddress(hostname)) {
    throw new Error('Unsubscribe URL targets a blocked private IP range');
  }

  const resolved = await lookup(hostname, { all: true });
  if (resolved.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error('Unsubscribe URL resolves to a blocked private IP range');
  }

  return url;
}

export function createTimedAbortSignal(
  timeoutMs = REQUEST_TIMEOUT_MS
): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    const [a, b] = octets;

    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80:')
    );
  }

  return false;
}
