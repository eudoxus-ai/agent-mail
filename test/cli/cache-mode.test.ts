import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { setCacheMode, describeCacheMode } from '../../src/cli/cache.js';
import { loadCacheConfig } from '../../src/cache/config.js';

/**
 * `cache.yaml` is a file the user owns and may have edited by hand.
 *
 * A setter that rewrites it from the in-memory config would quietly discard
 * every key it does not know about — backfill_days, mailboxes, attachment
 * policy — and the loss would only show up much later as a re-sync of two
 * years of mail. So this edits the file rather than regenerating it.
 */

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-mail-cache-cfg-'));
  path = join(dir, 'cache.yaml');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function read(): Record<string, any> {
  return yaml.load(readFileSync(path, 'utf-8')) as Record<string, any>;
}

describe('setCacheMode', () => {
  it('creates the file when there is none', () => {
    const result = setCacheMode('shadow', path);

    expect(result.previous).toBe('off');
    expect(result.mode).toBe('shadow');
    expect(read().cache.mode).toBe('shadow');
    // Round-trips through the real loader, not just the YAML.
    expect(loadCacheConfig(path).mode).toBe('shadow');
  });

  it('keeps every other setting in the file', () => {
    writeFileSync(
      path,
      yaml.dump({
        cache: {
          mode: 'off',
          backfill_days: 365,
          mailboxes: ['INBOX', 'Archive'],
          attachments: 'none',
        },
      })
    );

    setCacheMode('on', path);

    const after = read();
    expect(after.cache.mode).toBe('on');
    // Losing these would silently re-sync years of mail on the next start.
    expect(after.cache.backfill_days).toBe(365);
    expect(after.cache.mailboxes).toEqual(['INBOX', 'Archive']);
    expect(after.cache.attachments).toBe('none');
  });

  it('keeps unrelated top-level keys', () => {
    writeFileSync(path, yaml.dump({ cache: { mode: 'off' }, something_else: { a: 1 } }));

    setCacheMode('shadow', path);

    expect(read().something_else).toEqual({ a: 1 });
  });

  it('refuses a mode that is not a mode', () => {
    // Silently writing a typo would leave the daemon on `off` with a config
    // file that looks like it says otherwise.
    expect(() => setCacheMode('shdaow' as never, path)).toThrow(/shdaow/);
    expect(existsSync(path)).toBe(false);
  });

  it('reports the previous mode so the caller can say what changed', () => {
    setCacheMode('shadow', path);
    const result = setCacheMode('on', path);

    expect(result.previous).toBe('shadow');
    expect(result.mode).toBe('on');
    expect(result.changed).toBe(true);
  });

  it('is a no-op when the mode already matches', () => {
    setCacheMode('shadow', path);
    const result = setCacheMode('shadow', path);

    expect(result.changed).toBe(false);
  });

  it('writes the file 0600', () => {
    setCacheMode('shadow', path);

    // It sits beside the ledger and the account credentials; anything in
    // ~/.agent-mail is the user's alone.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('does not destroy a malformed file without saying so', () => {
    writeFileSync(path, 'cache: {{{ not yaml');

    // loadCacheConfig deliberately degrades to defaults on a broken file, but
    // silently overwriting one on the way past would throw away whatever the
    // user was mid-way through typing.
    expect(() => setCacheMode('on', path)).toThrow(/parse|yaml|malformed/i);
    expect(readFileSync(path, 'utf-8')).toContain('not yaml');
  });
});

describe('hand-edited files', () => {
  it('reads an unquoted "on" as the mode, not as a boolean', () => {
    // In YAML 1.1 an unquoted `on` is the boolean true, and a mode that fails
    // validation falls back to `off` — so a hand-edited file would silently
    // leave the cache disabled while looking enabled. js-yaml uses the 1.2 core
    // schema, where it stays a string. Pinned, because a parser or schema
    // change would reintroduce exactly that silent downgrade.
    writeFileSync(path, 'cache:\n  mode: on\n');
    expect(loadCacheConfig(path).mode).toBe('on');
  });

  it('round-trips a mode this command wrote', () => {
    setCacheMode('on', path);
    expect(loadCacheConfig(path).mode).toBe('on');
  });
});

describe('describeCacheMode', () => {
  it('explains what the current mode actually does', () => {
    const off = describeCacheMode(path);
    expect(off.mode).toBe('off');
    expect(off.summary).toMatch(/not/i);
    // The README used to claim `off` still warms the cache in the background.
    // It does not, and this is the surface most likely to be believed.
    expect(off.summary).toMatch(/sync/i);

    setCacheMode('shadow', path);
    expect(describeCacheMode(path).summary).toMatch(/compare|shadow|both/i);
  });

  it('says where the setting came from', () => {
    expect(describeCacheMode(path).source).toBe('default');
    setCacheMode('on', path);
    expect(describeCacheMode(path).source).toBe(path);
  });
});
