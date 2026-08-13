import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCacheConfig, DEFAULT_CACHE_CONFIG } from '../../src/cache/config.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-mail-cfg-'));
  path = join(dir, 'cache.yaml');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(yaml: string): void {
  writeFileSync(path, yaml);
}

describe('loadCacheConfig', () => {
  it('returns defaults when the file is absent', () => {
    expect(loadCacheConfig(join(dir, 'nope.yaml'))).toEqual(DEFAULT_CACHE_CONFIG);
  });

  it('defaults mode to off so the cache never silently starts serving reads', () => {
    expect(DEFAULT_CACHE_CONFIG.mode).toBe('off');
  });

  it('defaults backfill to 730 days (design D4)', () => {
    expect(DEFAULT_CACHE_CONFIG.backfillDays).toBe(730);
  });

  it('excludes Gmail All Mail from the default mailbox set (design D3)', () => {
    expect(DEFAULT_CACHE_CONFIG.mailboxes).not.toContain('\\All');
    expect(DEFAULT_CACHE_CONFIG.mailboxes).toContain('INBOX');
    expect(DEFAULT_CACHE_CONFIG.mailboxes).toContain('\\Sent');
  });

  it('reads a full config', () => {
    write(`
cache:
  mode: on
  mailboxes: [INBOX, "\\\\All"]
  backfill_days: 30
  attachments: full
  max_attachment_bytes: 1024
  sync_interval_seconds: 5
`);
    const config = loadCacheConfig(path);
    expect(config.mode).toBe('on');
    expect(config.mailboxes).toEqual(['INBOX', '\\All']);
    expect(config.backfillDays).toBe(30);
    expect(config.attachments).toBe('full');
    expect(config.maxAttachmentBytes).toBe(1024);
    expect(config.syncIntervalSeconds).toBe(5);
  });

  it('treats null backfill_days as unbounded rather than missing', () => {
    write('cache:\n  backfill_days: null\n');
    expect(loadCacheConfig(path).backfillDays).toBeNull();
  });

  it('falls back to defaults for an invalid mode', () => {
    write('cache:\n  mode: turbo\n');
    expect(loadCacheConfig(path).mode).toBe(DEFAULT_CACHE_CONFIG.mode);
  });

  it('falls back to defaults for an invalid attachment policy', () => {
    write('cache:\n  attachments: sometimes\n');
    expect(loadCacheConfig(path).attachments).toBe('metadata');
  });

  it('rejects a non-positive interval', () => {
    write('cache:\n  sync_interval_seconds: -5\n');
    expect(loadCacheConfig(path).syncIntervalSeconds).toBe(
      DEFAULT_CACHE_CONFIG.syncIntervalSeconds
    );
  });

  it('ignores a malformed mailboxes list', () => {
    write('cache:\n  mailboxes: [1, 2, 3]\n');
    expect(loadCacheConfig(path).mailboxes).toEqual(DEFAULT_CACHE_CONFIG.mailboxes);
  });

  it('degrades to defaults on unparseable YAML rather than throwing', () => {
    // A broken cache.yaml must not take the MCP server down with it.
    write('cache:\n  mode: [unclosed\n');
    expect(loadCacheConfig(path)).toEqual(DEFAULT_CACHE_CONFIG);
  });

  it('accepts a top-level shape without the cache key', () => {
    write('mode: shadow\n');
    expect(loadCacheConfig(path).mode).toBe('shadow');
  });
});
