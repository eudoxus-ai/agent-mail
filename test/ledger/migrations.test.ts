import { describe, it, expect } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import { runMigrations } from '../../src/ledger/migrations.js';

describe('ledger schema v3', () => {
  it('has intent_targets table with envelope_snapshot, destination_uid and uidvalidity', () => {
    const db = openDatabase(':memory:');
    const cols = db.prepare(`PRAGMA table_info(intent_targets)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        'intent_id',
        'account_id',
        'uid',
        'mailbox',
        'envelope_snapshot',
        'destination_uid',
        // A UID is meaningless without the mailbox generation it came from.
        'uidvalidity',
      ].sort()
    );
  });

  it('has reverses_intent_id and reversed_by_intent_id columns on intents', () => {
    const db = openDatabase(':memory:');
    const cols = db.prepare(`PRAGMA table_info(intents)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('reverses_intent_id');
    expect(names).toContain('reversed_by_intent_id');
  });

  it('rewrites quarantine_thread and quarantine_messages intents to hold_messages', () => {
    const db = openDatabase(':memory:');
    db.prepare(
      `INSERT INTO intents (id, account_id, tool, params, risk, status)
       VALUES (?, ?, ?, ?, 'medium', 'executed')`
    ).run('old-1', 'a@x.com', 'quarantine_thread', '{}');
    db.prepare(
      `INSERT INTO intents (id, account_id, tool, params, risk, status)
       VALUES (?, ?, ?, ?, 'medium', 'executed')`
    ).run('old-2', 'a@x.com', 'quarantine_messages', '{}');

    runMigrations(db);

    const rows = db
      .prepare(`SELECT id, tool FROM intents ORDER BY id`)
      .all() as Array<{ id: string; tool: string }>;
    expect(rows).toEqual([
      { id: 'old-1', tool: 'hold_messages' },
      { id: 'old-2', tool: 'hold_messages' },
    ]);
  });
});
