import notifier from 'node-notifier';
import type { Intent } from '../types.js';
import { describeIntent } from '../ledger/audit-summary.js';

export function notifyIntent(intent: Intent, port: number = 4242): void {
  const summary = describeIntent(intent.tool, intent.params);

  notifier.notify({
    title: 'agent-mail',
    message: summary,
    open: `http://127.0.0.1:${port}/intent/${intent.id}`,
    timeout: 30,
  });
}
