/**
 * Runtime version sanity check.
 *
 * This project stores mail in `node:sqlite`, whose availability and feature set
 * (FTS5 in particular) varies by Node major. A daemon that drifts onto an
 * unexpected runtime can therefore differ from the CLI about whether the local
 * cache works at all — and because launchd starts the daemon with a stripped
 * environment, that drift is silent unless something says so out loud.
 */

export interface RuntimeCheck {
  version: string;
  major: number;
  /** Odd majors are never promoted to LTS and are supported ~6 months. */
  isLtsLine: boolean;
  /** Below the project's declared engines floor. */
  belowMinimum: boolean;
  warning: string | null;
}

/** package.json engines floor. */
export const MINIMUM_NODE_MAJOR = 22;
/** The version this project pins and tests against. */
export const RECOMMENDED_NODE_MAJOR = 24;

export function checkNodeRuntime(version: string = process.version): RuntimeCheck {
  const major = Number.parseInt(version.replace(/^v/, '').split('.')[0] ?? '', 10);

  if (!Number.isFinite(major)) {
    return {
      version,
      major: NaN,
      isLtsLine: false,
      belowMinimum: false,
      warning: `Could not parse Node version "${version}".`,
    };
  }

  const isLtsLine = major % 2 === 0;
  const belowMinimum = major < MINIMUM_NODE_MAJOR;

  let warning: string | null = null;
  if (belowMinimum) {
    warning =
      `Node ${version} is below the minimum supported major (${MINIMUM_NODE_MAJOR}). ` +
      'node:sqlite is unavailable, so the intent ledger cannot open.';
  } else if (!isLtsLine) {
    // How the daemon ended up on Node 25: a version-manager shim resolved to a
    // Homebrew install under launchd's stripped PATH. Odd majors are never
    // promoted to LTS and stop receiving security fixes after about six
    // months, so landing on one is always accidental.
    warning =
      `Node ${version} is an odd-numbered release, which never becomes LTS and ` +
      `is short-lived. Use Node ${RECOMMENDED_NODE_MAJOR} (Active LTS).`;
  }

  return { version, major, isLtsLine, belowMinimum, warning };
}
