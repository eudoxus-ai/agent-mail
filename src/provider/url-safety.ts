import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const REQUEST_TIMEOUT_MS = 5_000;

export interface SafeRemoteUrl {
  /**
   * URL to pass directly to `fetch`. For plain HTTP this is IP-bound (hostname
   * replaced with the pre-validated resolved IP) to eliminate the DNS-rebinding
   * window between the safety check and the actual connection. For HTTPS the
   * original URL is returned because TLS certificate validation against the
   * original hostname provides equivalent protection.
   */
  url: URL;
  /** Any extra request headers required for this fetch (e.g. `Host` for IP-bound HTTP). */
  headers: Record<string, string>;
}

export async function assertSafeRemoteUrl(rawUrl: string): Promise<SafeRemoteUrl> {
  const url = new URL(rawUrl);

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only HTTP(S) unsubscribe URLs are allowed');
  }

  if (url.username || url.password) {
    throw new Error('Unsubscribe URLs cannot include credentials');
  }

  // url.hostname for IPv6 URLs includes brackets (e.g. "[::1]"). Strip them
  // so that isIP() and isPrivateAddress() receive a bare IP string.
  const rawHostname = url.hostname.trim().toLowerCase();
  const hostname =
    rawHostname.startsWith('[') && rawHostname.endsWith(']')
      ? rawHostname.slice(1, -1)
      : rawHostname;

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
  if (resolved.length === 0) {
    throw new Error('Unsubscribe URL hostname did not resolve');
  }
  if (resolved.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error('Unsubscribe URL resolves to a blocked private IP range');
  }

  // For plain HTTP: replace the hostname with the pre-validated IP to pin the
  // TCP connection to the address we just checked. This closes the TOCTOU
  // window between this DNS lookup and the fetch call — an attacker who
  // controls the DNS TTL cannot rebind the name to a private address after we
  // validate it. The Host header carries the original hostname so the server
  // receives the correct virtual-host value.
  //
  // For HTTPS this substitution is not needed: TLS certificate validation ties
  // the connection to the original hostname, so a rebinding attack would cause
  // a cert-mismatch error before any data is exchanged.
  if (url.protocol === 'http:') {
    const ip = resolved[0].address;
    const pinnedUrl = new URL(url.href);
    pinnedUrl.hostname = ip;
    return { url: pinnedUrl, headers: { Host: hostname } };
  }

  return { url, headers: {} };
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
    // fe80::/10 covers fe80:: through febf:: (top 10 bits = 1111 1110 10).
    // Checking only "fe80:" would miss fe81:: through febf::.
    const firstHextet = parseInt(normalized.substring(0, 4), 16);
    return (
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      (firstHextet & 0xffc0) === 0xfe80
    );
  }

  return false;
}
