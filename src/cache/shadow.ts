import type { Logger } from '../logger.js';

/**
 * Shadow-mode divergence detection.
 *
 * The acceptance gate for turning the cache on. Unit tests prove the cache is
 * self-consistent; only a diff against the real server proves it's faithful to
 * a decade of real mail, with all its missing headers, re-delivered messages
 * and provider quirks. The failure that matters is the cache silently missing a
 * message, which no test written in advance would catch.
 */

export interface ShadowRow {
  account_id: string;
  mailbox: string;
  uid: number;
  envelope: { date: string };
}

export interface ShadowDiff {
  matched: boolean;
  imapCount: number;
  cacheCount: number;
  /** Rows IMAP returned that the cache did not. The dangerous direction. */
  missingFromCache: string[];
  /** Rows the cache returned that IMAP did not. */
  extraInCache: string[];
  /** Same membership, different order. */
  orderDiverged: boolean;
}

function key(row: ShadowRow): string {
  return `${row.account_id}\x00${row.mailbox}\x00${row.uid}`;
}

export function diffResults(imap: ShadowRow[], cache: ShadowRow[]): ShadowDiff {
  const imapKeys = imap.map(key);
  const cacheKeys = cache.map(key);
  const imapSet = new Set(imapKeys);
  const cacheSet = new Set(cacheKeys);

  const missingFromCache = imapKeys.filter((k) => !cacheSet.has(k));
  const extraInCache = cacheKeys.filter((k) => !imapSet.has(k));

  const sameMembership = missingFromCache.length === 0 && extraInCache.length === 0;
  const orderDiverged =
    sameMembership && imapKeys.some((k, i) => k !== cacheKeys[i]);

  return {
    matched: sameMembership && !orderDiverged,
    imapCount: imap.length,
    cacheCount: cache.length,
    missingFromCache,
    extraInCache,
    orderDiverged,
  };
}

/**
 * Log a divergence with enough context to reproduce it. Deliberately verbose:
 * a shadow-mode log nobody can act on is worse than no shadow mode, because it
 * creates the impression the cache was verified.
 */
export function logDivergence(
  logger: Logger,
  params: Record<string, unknown>,
  diff: ShadowDiff
): void {
  if (diff.matched) return;

  logger.warn('cache: shadow divergence', {
    params,
    imap_count: diff.imapCount,
    cache_count: diff.cacheCount,
    // Bounded: a cold cache diverges on every row, and a log line per message
    // would bury the interesting cases.
    missing_from_cache: diff.missingFromCache.slice(0, 20),
    extra_in_cache: diff.extraInCache.slice(0, 20),
    missing_total: diff.missingFromCache.length,
    extra_total: diff.extraInCache.length,
    order_diverged: diff.orderDiverged,
  });
}
