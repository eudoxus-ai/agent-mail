import { writeFileSync, unlinkSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { LEDGER_DB_PATH } from '../config.js';

const PLIST_NAME = 'com.agent-mail.reviewer';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${PLIST_NAME}.plist`);
const LOG_PATH = join(homedir(), '.agent-mail', 'daemon.log');
const ERR_LOG_PATH = join(homedir(), '.agent-mail', 'daemon-error.log');

export interface RunnerResolution {
  bin: string;
  script: string;
  mode: 'built' | 'tsx';
  /** Non-fatal advisory, e.g. "dist is older than src". */
  warning?: string;
}

/**
 * Package root, whether this file is running from `src/cli` (via tsx) or
 * `dist/cli` (built). Both are two levels below the root.
 *
 * Resolving from the file's own location rather than cwd matters: launchd runs
 * the daemon with an unrelated working directory.
 */
function packageRoot(): string {
  // `import.meta.dirname` is undefined when a loader transpiles this module to
  // CJS. That doesn't happen on the normal path (the package is type: module),
  // but resolveRunner throwing would block daemon installation outright, so
  // derive it from import.meta.url when the shortcut isn't available.
  const here = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..');
}

/** Newest mtime among the TypeScript sources, for staleness detection. */
function newestSourceMtime(srcDir: string): number {
  let newest = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts')) {
        newest = Math.max(newest, statSync(full).mtimeMs);
      }
    }
  };
  try {
    walk(srcDir);
  } catch {
    return 0;
  }
  return newest;
}

/**
 * Pick the command launchd should run.
 *
 * Prefers the compiled output: a long-lived background process shouldn't
 * depend on tsx being resolvable years later. Falls back to tsx over the
 * TypeScript sources, checking the local `node_modules/.bin` before any global
 * install — the local copy is a devDependency and is what `bin/agent-mail.mjs`
 * already uses.
 */
export function resolveRunner(rootDir: string = packageRoot()): RunnerResolution {
  const builtScript = join(rootDir, 'dist', 'index.js');
  if (existsSync(builtScript)) {
    const nodePath = execSync('which node', { encoding: 'utf-8' }).trim();

    // A stale dist means the daemon silently runs old code after an edit —
    // confusing enough to be worth calling out rather than guessing.
    const srcMtime = newestSourceMtime(join(rootDir, 'src'));
    const builtMtime = statSync(builtScript).mtimeMs;
    const warning =
      srcMtime > builtMtime
        ? 'dist/ is older than src/ — run "npm run build" to pick up recent changes'
        : undefined;

    return { bin: nodePath, script: builtScript, mode: 'built', warning };
  }

  const tsScript = join(rootDir, 'src', 'index.ts');
  const localTsx = join(rootDir, 'node_modules', '.bin', 'tsx');
  if (existsSync(localTsx)) {
    return { bin: localTsx, script: tsScript, mode: 'tsx' };
  }

  try {
    const tsxPath = execSync('which tsx', { encoding: 'utf-8' }).trim();
    if (tsxPath) return { bin: tsxPath, script: tsScript, mode: 'tsx' };
  } catch {
    // fall through to the error below
  }

  throw new Error(
    'Cannot resolve a way to run the daemon. Looked for:\n' +
      `  built output: ${builtScript}\n` +
      `  local tsx:    ${localTsx}\n` +
      '  global tsx:   (not on PATH)\n' +
      'Run "npm run build", or "npm install" to restore the local tsx.'
  );
}

export function installDaemon(): void {
  const { bin, script, mode, warning } = resolveRunner();

  // Which code the daemon will actually run is the thing people get wrong, so
  // say it out loud rather than leaving it to be inferred from a plist.
  console.log(`Runner: ${mode === 'built' ? 'compiled dist/' : 'tsx over src/'} (${script})`);
  if (warning) console.warn(`Warning: ${warning}`);

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bin}</string>
    <string>${script}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${ERR_LOG_PATH}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>`;

  writeFileSync(PLIST_PATH, plist);
  console.log(`Wrote plist to ${PLIST_PATH}`);

  try {
    execSync(`launchctl bootout gui/$(id -u) ${PLIST_PATH} 2>/dev/null`, { stdio: 'ignore' });
  } catch {
    // Not loaded yet
  }

  execSync(`launchctl bootstrap gui/$(id -u) ${PLIST_PATH}`);
  console.log('Daemon installed and started.');
  console.log(`Logs: ${LOG_PATH}`);
}

export function uninstallDaemon(): void {
  if (!existsSync(PLIST_PATH)) {
    console.log('Daemon not installed.');
    return;
  }

  try {
    execSync(`launchctl bootout gui/$(id -u) ${PLIST_PATH}`);
  } catch {
    // Already unloaded
  }

  unlinkSync(PLIST_PATH);
  console.log('Daemon uninstalled.');
}

export async function daemonStatus(): Promise<void> {
  if (!existsSync(PLIST_PATH)) {
    console.log('Daemon: not installed');
    return;
  }

  try {
    const output = execSync(`launchctl print gui/$(id -u)/${PLIST_NAME} 2>&1`, {
      encoding: 'utf-8',
    });
    const pidMatch = output.match(/pid = (\d+)/);
    if (pidMatch) {
      console.log(`Daemon: running (PID ${pidMatch[1]})`);
    } else {
      console.log('Daemon: installed but not running');
    }
  } catch {
    console.log('Daemon: installed but not running');
  }

  if (existsSync(LEDGER_DB_PATH)) {
    try {
      const { openDatabase } = await import('../ledger/db.js');
      const { getPendingIntents } = await import('../ledger/intents.js');
      const { checkStuckExecuting } = await import('../ledger/db.js');
      const { getIntentTargets } = await import('../ledger/intent-targets.js');
      const db = openDatabase();
      const pending = getPendingIntents(db);
      console.log(`Pending intents: ${pending.length}`);

      // An intent left in 'executing' means the process died mid-action —
      // nothing else can produce that state, since both the success and
      // failure paths move it on. This is the difference between "the server
      // crashed" and "the provider was slow and the client gave up".
      const stuck = checkStuckExecuting(db);
      if (stuck.length > 0) {
        console.log(`\nInterrupted actions: ${stuck.length}`);
        console.log('  (these died mid-execution — the process stopped before finishing)');
        for (const intent of stuck) {
          const targets = getIntentTargets(db, intent.id);
          const unconfirmed = targets.filter((t) => t.destination_uid === null).length;
          console.log(
            `  ${intent.id}  ${intent.tool}  started ${intent.created_at}\n` +
              `    ${targets.length} target(s) recorded, ${unconfirmed} unconfirmed` +
              (targets.length > 0
                ? `\n    restore with: undo_intent ${intent.id}`
                : '\n    no targets recorded — nothing to restore from')
          );
        }
      }
    } catch {
      // DB might be locked
    }
  }

  await printCacheStatus();
}

/**
 * Per-mailbox cache coverage. First backfill of a large account takes a while,
 * and without this it's indistinguishable from the daemon having hung.
 */
async function printCacheStatus(): Promise<void> {
  const { CACHE_DB_PATH } = await import('../config.js');
  if (!existsSync(CACHE_DB_PATH)) {
    console.log('Local cache: not created yet');
    return;
  }

  try {
    const { openCache } = await import('../cache/db.js');
    const { loadCacheConfig } = await import('../cache/config.js');
    const config = loadCacheConfig();
    const cache = openCache(CACHE_DB_PATH, { readOnly: true });

    const rows = cache
      .prepare(
        `SELECT s.account_id, s.mailbox, s.backfill_complete, s.oldest_date, s.last_delta_at,
                (SELECT COUNT(*) FROM messages m
                 WHERE m.account_id = s.account_id AND m.mailbox = s.mailbox) AS messages,
                (SELECT COUNT(*) FROM messages m
                 WHERE m.account_id = s.account_id AND m.mailbox = s.mailbox
                   AND m.body_state = 'pending') AS pending_bodies
         FROM mailbox_state s
         ORDER BY s.account_id, s.mailbox`
      )
      .all() as Array<Record<string, number | string | null>>;

    console.log(`Local cache: mode=${config.mode}`);
    if (rows.length === 0) {
      console.log('  (no mailboxes synced yet)');
      return;
    }

    for (const row of rows) {
      const complete = row.backfill_complete === 1;
      const oldest = row.oldest_date
        ? new Date(Number(row.oldest_date)).toISOString().slice(0, 10)
        : '—';
      const synced = row.last_delta_at
        ? `${Math.round((Date.now() - Number(row.last_delta_at)) / 1000)}s ago`
        : 'pending';
      const bodies = Number(row.pending_bodies) > 0 ? `, ${row.pending_bodies} bodies queued` : '';

      console.log(
        `  ${row.account_id}/${row.mailbox}: ${row.messages} messages, ` +
          `${complete ? 'backfill complete' : 'backfilling'}, back to ${oldest}, synced ${synced}${bodies}`
      );
    }
  } catch (error) {
    console.log(
      `Local cache: unavailable (${error instanceof Error ? error.message : error})`
    );
  }
}
