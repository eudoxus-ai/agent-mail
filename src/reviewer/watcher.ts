import type { Database } from '../ledger/sqlite.js';
import type { Intent } from '../types.js';
import { getPendingIntents } from '../ledger/intents.js';

export interface WatcherOptions {
  db: Database;
  pollingIntervalMs?: number;
  onNewIntent: (intent: Intent) => void;
}

export class IntentWatcher {
  private db: Database;
  private intervalMs: number;
  private onNewIntent: (intent: Intent) => void;
  private seenIds = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: WatcherOptions) {
    this.db = options.db;
    this.intervalMs = options.pollingIntervalMs ?? 3000;
    this.onNewIntent = options.onNewIntent;
  }

  start(): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private poll(): void {
    const pending = getPendingIntents(this.db);
    for (const intent of pending) {
      if (!this.seenIds.has(intent.id)) {
        this.seenIds.add(intent.id);
        this.onNewIntent(intent);
      }
    }
  }
}
