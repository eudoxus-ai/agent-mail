import { execFile } from 'node:child_process';
import type { Intent } from '../types.js';
import { describeIntent } from '../ledger/audit-summary.js';

const REVIEWER_TITLE = 'agent-mail';

export function buildMacOsNotificationArgs(summary: string, port: number): string[] {
  return [
    '-e',
    'on run argv',
    '-e',
    'display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)',
    '-e',
    'end run',
    summary,
    REVIEWER_TITLE,
    `Open reviewer at 127.0.0.1:${port}`,
  ];
}

export function notifyIntent(
  intent: Intent,
  port: number = 4242,
  currentPlatform: NodeJS.Platform = process.platform
): void {
  const summary = describeIntent(intent.tool, intent.params);

  if (currentPlatform !== 'darwin') {
    return;
  }

  execFile('osascript', buildMacOsNotificationArgs(summary, port), { timeout: 5000 }, (error) => {
    if (error) {
      console.warn(`Failed to post macOS notification for intent ${intent.id}: ${error.message}`);
    }
  });
}
