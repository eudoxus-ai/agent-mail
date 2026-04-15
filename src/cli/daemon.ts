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
}
