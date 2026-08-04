import { DatabaseSync, type Database } from './sqlite.js';
import { LEDGER_DB_PATH } from '../config.js';
import type { Intent } from '../types.js';
import { runMigrations } from './migrations.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS intents (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  params JSON NOT NULL,
  risk TEXT NOT NULL CHECK (risk IN ('none', 'low', 'medium', 'high')),
  -- 'queued' means accepted and durable but not yet started. It is the state
  -- that lets accepted work survive a restart: anything only ever held in
  -- memory vanished with the process while still reading 'executing'.
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'queued', 'approved', 'executing', 'executed', 'rejected', 'failed', 'undone')),
  error_detail JSON,
  agent_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME,
  resolved_by TEXT,
  undo_token TEXT,
  undo_expires_at DATETIME,
  -- Claim bookkeeping. A worker takes ownership by setting claimed_by and a
  -- lease; the lease is what lets a dead worker's job be picked up again.
  claimed_by TEXT,
  claimed_at DATETIME,
  lease_expires_at DATETIME,
  -- NOT NULL DEFAULT 0 on purpose: the claim increments this, and NULL + 1 is
  -- NULL, which would silently disable the give-up-after-N rule.
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id TEXT REFERENCES intents(id),
  account_id TEXT,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export function openDatabase(dbPath: string = LEDGER_DB_PATH): Database {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA wal_autocheckpoint = 1000');
  db.exec(SCHEMA);
  runMigrations(db);
  return db;
}

export function checkStuckExecuting(db: Database): Intent[] {
  const rows = db
    .prepare(`SELECT * FROM intents WHERE status = 'executing'`)
    .all() as Array<Record<string, unknown>>;
  return rows.map(rowToIntent);
}

export function rowToIntent(row: Record<string, unknown>): Intent {
  return {
    id: row.id as string,
    account_id: row.account_id as string,
    tool: row.tool as string,
    params: JSON.parse(row.params as string),
    risk: row.risk as Intent['risk'],
    status: row.status as Intent['status'],
    error_detail: row.error_detail
      ? JSON.parse(row.error_detail as string)
      : null,
    agent_id: (row.agent_id as string) ?? null,
    created_at: row.created_at as string,
    resolved_at: (row.resolved_at as string) ?? null,
    resolved_by: (row.resolved_by as string) ?? null,
    undo_token: (row.undo_token as string) ?? null,
    undo_expires_at: (row.undo_expires_at as string) ?? null,
  };
}
