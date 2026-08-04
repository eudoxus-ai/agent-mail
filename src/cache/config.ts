import { readFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';
import { join } from 'node:path';
import { AGENT_MAIL_DIR } from '../config.js';
import { DEFAULT_MAILBOX_SELECTORS, DEFAULT_BACKFILL_DAYS } from './sync.js';

export const CACHE_YAML_PATH = join(AGENT_MAIL_DIR, 'cache.yaml');

/**
 * `off`    — cache is not read. Sync still runs so it warms in the background.
 * `shadow` — both paths run, IMAP's answer is returned, divergences are logged.
 *            This is how the cache earns trust before it serves anything.
 * `on`     — cache serves reads, IMAP is the fallback.
 */
export type CacheMode = 'off' | 'shadow' | 'on';

export type AttachmentPolicy = 'none' | 'metadata' | 'full';

export interface CacheConfig {
  mode: CacheMode;
  mailboxes: string[];
  /** null = unbounded. Default 730 (design D4). */
  backfillDays: number | null;
  attachments: AttachmentPolicy;
  maxAttachmentBytes: number;
  /** Seconds since last delta after which the cache reports itself stale. */
  freshnessWindowSeconds: number;
  syncIntervalSeconds: number;
  batchSize: number;
  bodyBatchSize: number;
}

export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  // Defaults to `off`: a cache that silently starts answering queries before
  // anyone has compared it against the server is exactly the failure this
  // rollout is designed to avoid.
  mode: 'off',
  mailboxes: DEFAULT_MAILBOX_SELECTORS,
  backfillDays: DEFAULT_BACKFILL_DAYS,
  attachments: 'metadata',
  maxAttachmentBytes: 25 * 1024 * 1024,
  freshnessWindowSeconds: 300,
  syncIntervalSeconds: 60,
  batchSize: 500,
  bodyBatchSize: 50,
};

const MODES: CacheMode[] = ['off', 'shadow', 'on'];
const POLICIES: AttachmentPolicy[] = ['none', 'metadata', 'full'];

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/**
 * Load cache settings, falling back to defaults for anything absent or
 * malformed. A broken cache.yaml degrades to defaults rather than taking the
 * MCP server down with it — the cache is an optimization, not a dependency.
 */
export function loadCacheConfig(path: string = CACHE_YAML_PATH): CacheConfig {
  if (!existsSync(path)) return { ...DEFAULT_CACHE_CONFIG };

  let raw: Record<string, unknown>;
  try {
    const parsed = yaml.load(readFileSync(path, 'utf-8'));
    raw = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  } catch {
    return { ...DEFAULT_CACHE_CONFIG };
  }

  const cache = (raw.cache ?? raw) as Record<string, unknown>;

  const mode = MODES.includes(cache.mode as CacheMode)
    ? (cache.mode as CacheMode)
    : DEFAULT_CACHE_CONFIG.mode;

  const attachments = POLICIES.includes(cache.attachments as AttachmentPolicy)
    ? (cache.attachments as AttachmentPolicy)
    : DEFAULT_CACHE_CONFIG.attachments;

  const mailboxes =
    Array.isArray(cache.mailboxes) && cache.mailboxes.every((m) => typeof m === 'string')
      ? (cache.mailboxes as string[])
      : DEFAULT_CACHE_CONFIG.mailboxes;

  // `null` is meaningful here (unbounded backfill), so it can't share the
  // "missing -> default" path that every other field uses.
  const backfillDays =
    cache.backfill_days === null
      ? null
      : typeof cache.backfill_days === 'number' && cache.backfill_days > 0
        ? Math.floor(cache.backfill_days)
        : DEFAULT_CACHE_CONFIG.backfillDays;

  return {
    mode,
    mailboxes,
    backfillDays,
    attachments,
    maxAttachmentBytes: positiveInt(
      cache.max_attachment_bytes,
      DEFAULT_CACHE_CONFIG.maxAttachmentBytes
    ),
    freshnessWindowSeconds: positiveInt(
      cache.freshness_window_seconds,
      DEFAULT_CACHE_CONFIG.freshnessWindowSeconds
    ),
    syncIntervalSeconds: positiveInt(
      cache.sync_interval_seconds,
      DEFAULT_CACHE_CONFIG.syncIntervalSeconds
    ),
    batchSize: positiveInt(cache.batch_size, DEFAULT_CACHE_CONFIG.batchSize),
    bodyBatchSize: positiveInt(cache.body_batch_size, DEFAULT_CACHE_CONFIG.bodyBatchSize),
  };
}

export const DEFAULT_CACHE_YAML = `# agent-mail local message cache
#
# mode:
#   off    - cache is not read (sync still warms it in the background)
#   shadow - run both paths, return IMAP's answer, log any divergence
#   on     - serve reads from the cache, fall back to IMAP when stale
cache:
  mode: off

  # Mailboxes to sync. Entries starting with a backslash are IMAP special-use
  # flags, resolved per provider (Gmail's "[Gmail]/Sent Mail" and iCloud's
  # "Sent Messages" both match "\\\\Sent").
  #
  # Gmail's All Mail ("\\\\All") is excluded on purpose: it holds a near-copy of
  # every message, roughly doubling cache size for very little extra reach.
  # Add "\\\\All" here if you want it.
  mailboxes: [INBOX, "\\\\Sent", "\\\\Archive", agent-mail-holding]

  # How far back to backfill. Set to null for your entire mail history —
  # be aware that a decade-old account can take hours and several GB.
  backfill_days: 730

  # none     - store nothing about attachments
  # metadata - filename/type/size only; fetch payloads on demand (default)
  # full     - cache payloads too (much larger on disk)
  attachments: metadata
  max_attachment_bytes: 26214400

  sync_interval_seconds: 60
`;
