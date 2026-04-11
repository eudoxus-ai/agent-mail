import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import inquirer from 'inquirer';

function getBinPath(): string {
  return resolve(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'agent-mail.mjs')
  );
}

function getServerEntry(): { command: string; args: string[] } {
  return { command: getBinPath(), args: ['serve'] };
}

export function printConfig(): void {
  console.log(JSON.stringify({ mcpServers: { 'agent-mail': getServerEntry() } }, null, 2));
}

const CLAUDE_DESKTOP_CONFIG = join(
  homedir(),
  'Library',
  'Application Support',
  'Claude',
  'claude_desktop_config.json'
);

export async function installConfig(): Promise<void> {
  const entry = getServerEntry();

  if (!existsSync(CLAUDE_DESKTOP_CONFIG)) {
    console.log(`Config file not found: ${CLAUDE_DESKTOP_CONFIG}`);
    console.log('Will create it with this entry:\n');
    console.log(JSON.stringify({ mcpServers: { 'agent-mail': entry } }, null, 2));

    const { proceed } = await inquirer.prompt([
      { type: 'confirm', name: 'proceed', message: 'Create this file?', default: true },
    ]);
    if (!proceed) { console.log('Cancelled.'); return; }

    const config = { mcpServers: { 'agent-mail': entry } };
    writeFileSync(CLAUDE_DESKTOP_CONFIG, JSON.stringify(config, null, 2) + '\n');
    console.log(`Created ${CLAUDE_DESKTOP_CONFIG}`);
    console.log('Restart Claude Desktop to pick up the change.');
    return;
  }

  const raw = readFileSync(CLAUDE_DESKTOP_CONFIG, 'utf-8');
  const config = JSON.parse(raw) as Record<string, unknown>;

  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }

  const servers = config.mcpServers as Record<string, unknown>;
  const existed = 'agent-mail' in servers;

  console.log(`File: ${CLAUDE_DESKTOP_CONFIG}`);
  if (existed) {
    console.log('\nExisting agent-mail entry:');
    console.log(JSON.stringify(servers['agent-mail'], null, 2));
    console.log('\nWill replace with:');
  } else {
    console.log('\nWill add:');
  }
  console.log(JSON.stringify({ 'agent-mail': entry }, null, 2));

  const { proceed } = await inquirer.prompt([
    { type: 'confirm', name: 'proceed', message: existed ? 'Update?' : 'Add to config?', default: true },
  ]);
  if (!proceed) { console.log('Cancelled.'); return; }

  servers['agent-mail'] = entry;
  writeFileSync(CLAUDE_DESKTOP_CONFIG, JSON.stringify(config, null, 2) + '\n');
  console.log(existed ? 'Updated.' : 'Added.');
  console.log('Restart Claude Desktop to pick up the change.');
}
