import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import yaml from 'js-yaml';
import { CACHE_YAML_PATH, loadCacheConfig, type CacheMode } from '../cache/config.js';

const MODES: CacheMode[] = ['off', 'shadow', 'on'];

const EXPLANATIONS: Record<CacheMode, string> = {
  off:
    'The cache is neither read nor written, and the daemon does not sync it. ' +
    'Nothing warms up in the background — there is no local cache until you pick another mode.',
  shadow:
    'The daemon syncs, and every search runs against both the cache and IMAP. IMAP still ' +
    'gives you the answer; differences are logged as "cache: shadow divergence". Sender ' +
    'sweeps already use the cache to catch messages the server search missed.',
  on:
    'Searches are served from the cache, falling back to IMAP when it is stale or a mailbox ' +
    'is still backfilling. Sender sweeps cross-check it for messages the server search missed.',
};

export interface CacheModeReport {
  mode: CacheMode;
  /** The file the mode came from, or `default` when none is set. */
  source: string;
  summary: string;
}

export function describeCacheMode(path: string = CACHE_YAML_PATH): CacheModeReport {
  const config = loadCacheConfig(path);
  return {
    mode: config.mode,
    source: existsSync(path) ? path : 'default',
    summary: EXPLANATIONS[config.mode],
  };
}

export interface SetCacheModeResult {
  mode: CacheMode;
  previous: CacheMode;
  changed: boolean;
  path: string;
}

/**
 * Change `cache.mode`, leaving the rest of the file alone.
 *
 * Edits rather than regenerates. `cache.yaml` belongs to the user and may hold
 * settings this command knows nothing about — `backfill_days`, `mailboxes`,
 * attachment policy — and rewriting it from the in-memory config would drop
 * them silently. The loss would not surface until the next start, as a re-sync
 * of two years of mail.
 */
export function setCacheMode(
  mode: CacheMode,
  path: string = CACHE_YAML_PATH
): SetCacheModeResult {
  if (!MODES.includes(mode)) {
    throw new Error(`Unknown cache mode "${mode}". Valid modes: ${MODES.join(', ')}.`);
  }

  const previous = loadCacheConfig(path).mode;

  let doc: Record<string, unknown> = {};
  if (existsSync(path)) {
    const text = readFileSync(path, 'utf-8');
    let parsed: unknown;
    try {
      parsed = yaml.load(text);
    } catch (error) {
      // loadCacheConfig degrades to defaults on a broken file, which is right
      // for a read. Writing over one is not: whatever the user was part-way
      // through typing would be gone.
      throw new Error(
        `${path} is not valid YAML, so it cannot be edited safely ` +
          `(${error instanceof Error ? error.message : String(error)}). ` +
          'Fix or delete the file, then try again.'
      );
    }
    if (parsed && typeof parsed === 'object') doc = parsed as Record<string, unknown>;
  }

  const cache =
    doc.cache && typeof doc.cache === 'object'
      ? (doc.cache as Record<string, unknown>)
      : {};
  cache.mode = mode;
  doc.cache = cache;

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, yaml.dump(doc), { mode: 0o600 });
  // writeFileSync's mode only applies on create; an existing file keeps its
  // own. This sits beside the ledger and the account credentials.
  chmodSync(path, 0o600);

  return { mode, previous, changed: mode !== previous, path };
}

/** `agent-mail cache [off|shadow|on]` */
export async function cacheCommand(requested?: string): Promise<void> {
  if (!requested) {
    const report = describeCacheMode();
    console.log(`Cache mode: ${report.mode}  (from ${report.source})`);
    console.log(`  ${report.summary}`);
    console.log('');
    console.log(`Change it with: agent-mail cache <${MODES.join('|')}>`);
    console.log('');
    const { printCacheStatus } = await import('./daemon.js');
    await printCacheStatus();
    return;
  }

  let result: SetCacheModeResult;
  try {
    result = setCacheMode(requested as CacheMode);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (!result.changed) {
    console.log(`Cache mode is already ${result.mode}. Nothing changed.`);
    return;
  }

  console.log(`Cache mode: ${result.previous} → ${result.mode}`);
  console.log(`  ${EXPLANATIONS[result.mode]}`);
  console.log(`  Written to ${result.path}`);
  console.log('');
  // The mode is read once at startup, so the running daemon is still on the
  // old one until it restarts. Saying this is the difference between the
  // setting taking effect and the user assuming it did.
  console.log('The daemon reads this at startup — restart it to apply:');
  console.log('  agent-mail install-daemon');
}
