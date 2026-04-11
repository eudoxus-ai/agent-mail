import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, checkStuckExecuting } from '../../src/ledger/db.js';

describe('openDatabase', () => {
  it('creates tables', () => {
    const db = openDatabase(':memory:');

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
      )
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('intents');
    expect(names).toContain('audit_log');
  });

  it('sets WAL mode on file-based databases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-mail-test-'));
    const dbPath = join(dir, 'test.db');
    const db = openDatabase(dbPath);
    const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(row.journal_mode).toBe('wal');
  });
});

describe('checkStuckExecuting', () => {
  it('returns intents stuck in executing status', () => {
    const db = openDatabase(':memory:');
    db.prepare(
      `INSERT INTO intents (id, account_id, tool, params, risk, status)
       VALUES ('test-1', 'gmail', 'queue_send', '{}', 'high', 'executing')`
    ).run();
    db.prepare(
      `INSERT INTO intents (id, account_id, tool, params, risk, status)
       VALUES ('test-2', 'gmail', 'label_thread', '{}', 'low', 'executed')`
    ).run();

    const stuck = checkStuckExecuting(db);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].id).toBe('test-1');
    expect(stuck[0].status).toBe('executing');
  });

  it('returns empty array when nothing is stuck', () => {
    const db = openDatabase(':memory:');
    const stuck = checkStuckExecuting(db);
    expect(stuck).toHaveLength(0);
  });
});
