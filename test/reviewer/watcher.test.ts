import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import { createIntent } from '../../src/ledger/intents.js';
import type { Database } from '../../src/ledger/sqlite.js';
import { IntentWatcher } from '../../src/reviewer/watcher.js';

let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:');
});

describe('IntentWatcher', () => {
  it('detects new pending intents', async () => {
    const notified: string[] = [];
    const watcher = new IntentWatcher({
      db,
      pollingIntervalMs: 50,
      onNewIntent: (intent) => { notified.push(intent.id); },
    });

    watcher.start();

    const intent = createIntent(db, {
      account_id: 'test@gmail.com',
      tool: 'queue_send',
      params: { to: 'alice@example.com', subject: 'Test' },
      risk: 'high',
    });

    await new Promise(r => setTimeout(r, 150));

    watcher.stop();
    expect(notified).toContain(intent.id);
  });

  it('does not re-notify for already-seen intents', async () => {
    const notified: string[] = [];
    const watcher = new IntentWatcher({
      db,
      pollingIntervalMs: 50,
      onNewIntent: (intent) => { notified.push(intent.id); },
    });

    createIntent(db, {
      account_id: 'test@gmail.com',
      tool: 'queue_send',
      params: { to: 'alice@example.com', subject: 'Test' },
      risk: 'high',
    });

    watcher.start();
    await new Promise(r => setTimeout(r, 200));
    watcher.stop();

    expect(notified).toHaveLength(1);
  });
});
