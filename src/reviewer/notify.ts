import notifier from 'node-notifier';
import type { Intent } from '../types.js';
import { describeIntent } from '../ledger/audit-summary.js';

const REVIEWER_PORT = 4242;

export function notifyIntent(intent: Intent): void {
  const summary = describeIntent(intent.tool, intent.params);

  notifier.notify({
    title: 'agent-mail',
    message: summary,
    open: `http://127.0.0.1:${REVIEWER_PORT}/intent/${intent.id}`,
    timeout: 30,
  });
}
