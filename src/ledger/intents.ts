import type { Database } from './sqlite.js';
import { v4 as uuidv4 } from 'uuid';
import { rowToIntent } from './db.js';
import type { Intent, IntentStatus, RiskLevel } from '../types.js';

export interface CreateIntentParams {
  account_id: string;
  tool: string;
  params: Record<string, unknown>;
  risk: RiskLevel;
  agent_id?: string;
}

export function createIntent(
  db: Database,
  p: CreateIntentParams
): Intent {
  const id = uuidv4();
  db.prepare(
    `INSERT INTO intents (id, account_id, tool, params, risk, status, agent_id)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`
  ).run(id, p.account_id, p.tool, JSON.stringify(p.params), p.risk, p.agent_id ?? null);

  return getIntent(db, id)!;
}

export function getIntent(
  db: Database,
  id: string
): Intent | null {
  const row = db
    .prepare('SELECT * FROM intents WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToIntent(row) : null;
}

export function updateIntentStatus(
  db: Database,
  id: string,
  status: IntentStatus,
  extra?: {
    resolved_by?: string;
    error_detail?: Record<string, unknown>;
    undo_token?: string;
    undo_expires_at?: string;
  }
): void {
  const resolvedAt =
    ['executed', 'rejected', 'failed', 'undone'].includes(status)
      ? new Date().toISOString()
      : null;

  db.prepare(
    `UPDATE intents SET
       status = ?,
       resolved_at = COALESCE(?, resolved_at),
       resolved_by = COALESCE(?, resolved_by),
       error_detail = COALESCE(?, error_detail),
       undo_token = COALESCE(?, undo_token),
       undo_expires_at = COALESCE(?, undo_expires_at)
     WHERE id = ?`
  ).run(
    status,
    resolvedAt,
    extra?.resolved_by ?? null,
    extra?.error_detail ? JSON.stringify(extra.error_detail) : null,
    extra?.undo_token ?? null,
    extra?.undo_expires_at ?? null,
    id
  );
}

export function updateIntentStatusIfCurrent(
  db: Database,
  id: string,
  currentStatus: IntentStatus,
  nextStatus: IntentStatus,
  extra?: {
    resolved_by?: string;
    error_detail?: Record<string, unknown>;
    undo_token?: string;
    undo_expires_at?: string;
  }
): boolean {
  const resolvedAt =
    ['executed', 'rejected', 'failed', 'undone'].includes(nextStatus)
      ? new Date().toISOString()
      : null;

  const result = db
    .prepare(
      `UPDATE intents SET
         status = ?,
         resolved_at = COALESCE(?, resolved_at),
         resolved_by = COALESCE(?, resolved_by),
         error_detail = COALESCE(?, error_detail),
         undo_token = COALESCE(?, undo_token),
         undo_expires_at = COALESCE(?, undo_expires_at)
       WHERE id = ? AND status = ?`
    )
    .run(
      nextStatus,
      resolvedAt,
      extra?.resolved_by ?? null,
      extra?.error_detail ? JSON.stringify(extra.error_detail) : null,
      extra?.undo_token ?? null,
      extra?.undo_expires_at ?? null,
      id,
      currentStatus
    ) as { changes?: number | bigint };

  return Number(result.changes ?? 0) > 0;
}

export function withImmediateTransaction<T>(
  db: Database,
  fn: () => T
): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function getPendingIntents(
  db: Database,
  accountId?: string
): Intent[] {
  const query = accountId
    ? `SELECT * FROM intents WHERE status = 'pending' AND account_id = ? ORDER BY created_at ASC`
    : `SELECT * FROM intents WHERE status = 'pending' ORDER BY created_at ASC`;
  const rows = accountId
    ? (db.prepare(query).all(accountId) as Array<Record<string, unknown>>)
    : (db.prepare(query).all() as Array<Record<string, unknown>>);
  return rows.map(rowToIntent);
}

export function getIntentsByStatus(
  db: Database,
  status: IntentStatus
): Intent[] {
  const rows = db
    .prepare('SELECT * FROM intents WHERE status = ? ORDER BY created_at ASC')
    .all(status) as Array<Record<string, unknown>>;
  return rows.map(rowToIntent);
}
