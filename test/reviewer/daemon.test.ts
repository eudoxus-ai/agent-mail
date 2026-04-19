import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import { createIntent } from '../../src/ledger/intents.js';
import type { Database } from '../../src/ledger/sqlite.js';
import { IntentWatcher } from '../../src/reviewer/watcher.js';
import { shouldNotify } from '../../src/reviewer/notification-policy.js';
import type { Intent } from '../../src/types.js';

let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:');
});

/**
 * The daemon wraps `notifyIntent` with `shouldNotify`. These tests mirror
 * that wiring exactly so we can verify suppression behavior without
 * spinning up the HTTP listener.
 */
function makeWrappedOnNewIntent(notify: (intent: Intent) => void) {
  return (intent: Intent) => {
    if (shouldNotify(intent)) {
      notify(intent);
    }
  };
}

describe('daemon notification wiring', () => {
  it('does not notify for low-risk pending intents', async () => {
    const notify = vi.fn();
    const watcher = new IntentWatcher({
      db,
      pollingIntervalMs: 50,
      onNewIntent: makeWrappedOnNewIntent(notify),
    });

    createIntent(db, {
      account_id: 'test@gmail.com',
      tool: 'label_thread',
      params: { thread_id: 't1', label: 'done' },
      risk: 'low',
    });

    watcher.start();
    await new Promise((r) => setTimeout(r, 150));
    watcher.stop();

    expect(notify).not.toHaveBeenCalled();
  });

  it('notifies exactly once for high-risk pending intents', async () => {
    const notify = vi.fn();
    const watcher = new IntentWatcher({
      db,
      pollingIntervalMs: 50,
      onNewIntent: makeWrappedOnNewIntent(notify),
    });

    const intent = createIntent(db, {
      account_id: 'test@gmail.com',
      tool: 'queue_send',
      params: { to: 'alice@example.com', subject: 'Test' },
      risk: 'high',
    });

    watcher.start();
    await new Promise((r) => setTimeout(r, 200));
    watcher.stop();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].id).toBe(intent.id);
  });

  it('suppresses notifications tagged with __unknown_tool_fallback', async () => {
    const notify = vi.fn();
    const watcher = new IntentWatcher({
      db,
      pollingIntervalMs: 50,
      onNewIntent: makeWrappedOnNewIntent(notify),
    });

    createIntent(db, {
      account_id: 'test@gmail.com',
      tool: 'mystery_tool',
      params: { foo: 'bar', __unknown_tool_fallback: true },
      risk: 'high',
    });

    watcher.start();
    await new Promise((r) => setTimeout(r, 150));
    watcher.stop();

    expect(notify).not.toHaveBeenCalled();
  });
});
