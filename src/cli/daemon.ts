import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { LEDGER_DB_PATH } from '../config.js';

const PLIST_NAME = 'com.agent-mail.reviewer';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${PLIST_NAME}.plist`);
const LOG_PATH = join(homedir(), '.agent-mail', 'daemon.log');
const ERR_LOG_PATH = join(homedir(), '.agent-mail', 'daemon-error.log');

function resolveRunner(): { bin: string; script: string } {
  const builtScript = join(import.meta.dirname, '..', 'index.js');
  if (existsSync(builtScript)) {
    // Built project — use plain node
    const nodePath = execSync('which node', { encoding: 'utf-8' }).trim();
    return { bin: nodePath, script: builtScript };
  }

  // Unbuilt source checkout — must use tsx to run TypeScript
  const tsScript = join(import.meta.dirname, '..', 'index.ts');
  try {
    const tsxPath = execSync('which tsx', { encoding: 'utf-8' }).trim();
    return { bin: tsxPath, script: tsScript };
  } catch {
    throw new Error(
      'Cannot install daemon from unbuilt source without tsx. ' +
      'Either run "npm run build" first, or install tsx globally: npm i -g tsx'
    );
  }
}

export function installDaemon(): void {
  const { bin, script } = resolveRunner();

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
      const db = openDatabase();
      const pending = getPendingIntents(db);
      console.log(`Pending intents: ${pending.length}`);
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
