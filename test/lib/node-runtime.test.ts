import { describe, it, expect } from 'vitest';
import {
  checkNodeRuntime,
  MINIMUM_NODE_MAJOR,
  RECOMMENDED_NODE_MAJOR,
} from '../../src/lib/node-runtime.js';

/**
 * The daemon was found running Node 25 on a machine where only asdf-managed
 * versions were installed — a version-manager shim resolving to a Homebrew
 * build under launchd's stripped PATH. Node 25 reached end-of-life in March
 * 2026, so it had been running unpatched. This check makes that loud.
 */

describe('checkNodeRuntime', () => {
  it('is quiet on the recommended LTS', () => {
    const check = checkNodeRuntime(`v${RECOMMENDED_NODE_MAJOR}.18.1`);
    expect(check.warning).toBeNull();
    expect(check.isLtsLine).toBe(true);
    expect(check.belowMinimum).toBe(false);
  });

  it('is quiet on the older supported LTS', () => {
    expect(checkNodeRuntime('v22.14.0').warning).toBeNull();
  });

  it('flags odd-numbered releases, which never become LTS', () => {
    const check = checkNodeRuntime('v25.6.1');
    expect(check.isLtsLine).toBe(false);
    expect(check.warning).toContain('never becomes LTS');
    expect(check.warning).toContain(String(RECOMMENDED_NODE_MAJOR));
  });

  it('flags a version below the engines floor', () => {
    const check = checkNodeRuntime('v20.11.0');
    expect(check.belowMinimum).toBe(true);
    // Below 22 there is no node:sqlite, so the ledger cannot open at all —
    // a hard failure, not a preference.
    expect(check.warning).toContain('node:sqlite');
  });

  it('treats the minimum major as acceptable', () => {
    expect(checkNodeRuntime(`v${MINIMUM_NODE_MAJOR}.0.0`).belowMinimum).toBe(false);
  });

  it('parses versions with and without the v prefix', () => {
    expect(checkNodeRuntime('24.18.1').major).toBe(24);
    expect(checkNodeRuntime('v24.18.1').major).toBe(24);
  });

  it('does not throw on an unparseable version', () => {
    const check = checkNodeRuntime('not-a-version');
    expect(check.warning).toContain('Could not parse');
  });

  it('passes on the runtime actually running these tests', () => {
    // Guards against the pinned version drifting below what the project needs.
    expect(checkNodeRuntime().belowMinimum).toBe(false);
  });
});
