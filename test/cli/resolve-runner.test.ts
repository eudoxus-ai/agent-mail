import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRunner } from '../../src/cli/daemon.js';

/**
 * Regression coverage for daemon runner resolution.
 *
 * The original implementation looked for the built entrypoint at
 * `<root>/src/index.js` — a path the build never produces — so a successful
 * `npm run build` was ignored, and it then only checked for a *global* tsx,
 * missing the local devDependency. Installing the daemon from a source
 * checkout failed with advice that was wrong in both directions.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-mail-runner-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'index.ts'), '// entry');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeDist(): string {
  mkdirSync(join(root, 'dist'), { recursive: true });
  const path = join(root, 'dist', 'index.js');
  writeFileSync(path, '// built entry');
  return path;
}

function makeLocalTsx(): string {
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  const path = join(root, 'node_modules', '.bin', 'tsx');
  writeFileSync(path, '#!/bin/sh\n', { mode: 0o755 });
  return path;
}

describe('resolveRunner', () => {
  it('finds the built entrypoint in dist/, not src/', () => {
    const built = makeDist();
    const resolved = resolveRunner(root);

    expect(resolved.mode).toBe('built');
    expect(resolved.script).toBe(built);
    expect(resolved.script).not.toContain(join('src', 'index.js'));
  });

  it('prefers the built output over tsx when both are available', () => {
    makeDist();
    makeLocalTsx();
    // A launchd daemon shouldn't depend on tsx resolving years from now.
    expect(resolveRunner(root).mode).toBe('built');
  });

  it('falls back to the local node_modules tsx when there is no build', () => {
    const tsx = makeLocalTsx();
    const resolved = resolveRunner(root);

    expect(resolved.mode).toBe('tsx');
    expect(resolved.bin).toBe(tsx);
    expect(resolved.script).toBe(join(root, 'src', 'index.ts'));
  });

  it('warns when dist is older than src instead of silently running stale code', () => {
    const built = makeDist();
    const past = new Date(Date.now() - 60_000);
    utimesSync(built, past, past);
    // Source edited after the last build.
    const now = new Date();
    utimesSync(join(root, 'src', 'index.ts'), now, now);

    const resolved = resolveRunner(root);
    expect(resolved.mode).toBe('built');
    expect(resolved.warning).toContain('npm run build');
  });

  it('does not warn when the build is current', () => {
    makeDist();
    expect(resolveRunner(root).warning).toBeUndefined();
  });

  it('names every location it checked when nothing is usable', () => {
    // No dist, no local tsx. Global tsx may or may not exist on the machine
    // running these tests, so only assert when resolution actually fails.
    let error: Error | null = null;
    try {
      resolveRunner(root);
    } catch (e) {
      error = e as Error;
    }

    if (error) {
      expect(error.message).toContain(join(root, 'dist', 'index.js'));
      expect(error.message).toContain(join(root, 'node_modules', '.bin', 'tsx'));
      // The old message claimed a build would fix it while looking in the
      // wrong place; the new one shows the paths so it can be verified.
      expect(error.message).not.toBe(
        'Cannot install daemon from unbuilt source without tsx. ' +
          'Either run "npm run build" first, or install tsx globally: npm i -g tsx'
      );
    }
  });
});
