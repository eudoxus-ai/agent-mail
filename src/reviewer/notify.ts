import { execFile } from 'node:child_process';
import type { Intent } from '../types.js';
import { describeIntent } from '../ledger/audit-summary.js';
import { DEFAULT_REVIEWER_PORT } from '../config.js';
import { buildApprovalUrl } from './urls.js';

const REVIEWER_TITLE = 'agent-mail';

export function buildMacOsNotificationArgs(
  summary: string,
  port: number,
  intentId: string
): string[] {
  return [
    '-e',
    'on run argv',
    '-e',
    'display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)',
    '-e',
    'end run',
    summary,
    REVIEWER_TITLE,
    buildApprovalUrl(port, intentId),
  ];
}

export function notifyIntent(
  intent: Intent,
  port: number = DEFAULT_REVIEWER_PORT,
  currentPlatform: NodeJS.Platform = process.platform
): void {
  const summary = describeIntent(intent.tool, intent.params);

  if (currentPlatform !== 'darwin') {
    return;
  }

  execFile(
    'osascript',
    buildMacOsNotificationArgs(summary, port, intent.id),
    { timeout: 5000 },
    (error) => {
      if (error) {
        console.warn(
          `Failed to post macOS notification for intent ${intent.id}: ${error.message}`
        );
      }
    }
  );
}
