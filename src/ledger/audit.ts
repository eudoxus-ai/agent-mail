import type { Database } from './sqlite.js';
import type { AuditAction, AuditEntry } from '../types.js';

export interface LogAuditParams {
  intent_id: string;
  account_id?: string;
  action: AuditAction;
  actor: string;
  detail?: Record<string, unknown>;
}

export function logAudit(db: Database, p: LogAuditParams): void {
  db.prepare(
    `INSERT INTO audit_log (intent_id, account_id, action, actor, detail)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    p.intent_id,
    p.account_id ?? null,
    p.action,
    p.actor,
    p.detail ? JSON.stringify(p.detail) : null
  );
}

export interface AuditFilters {
  intent_id?: string;
  account_ids?: string[];
  tool?: string;
  limit?: number;
  offset?: number;
}

export function getAuditLog(
  db: Database,
  filters?: AuditFilters
): AuditEntry[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.intent_id) {
    conditions.push('a.intent_id = ?');
    params.push(filters.intent_id);
  }
  if (filters?.account_ids && filters.account_ids.length > 0) {
    const placeholders = filters.account_ids.map(() => '?').join(', ');
    conditions.push(`a.account_id IN (${placeholders})`);
    params.push(...filters.account_ids);
  }
  if (filters?.tool) {
    conditions.push('i.tool = ?');
    params.push(filters.tool);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters?.limit ?? 100;
  const offset = filters?.offset ?? 0;

  const query = `
    SELECT a.* FROM audit_log a
    LEFT JOIN intents i ON a.intent_id = i.id
    ${where}
    ORDER BY a.id DESC
    LIMIT ? OFFSET ?
  `;

  const allParams = [...params, limit, offset] as (string | number | null)[];
  const rows = db
    .prepare(query)
    .all(...allParams) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: row.id as number,
    intent_id: row.intent_id as string,
    account_id: (row.account_id as string) ?? null,
    action: row.action as AuditAction,
    actor: row.actor as string,
    detail: row.detail ? JSON.parse(row.detail as string) : null,
    created_at: row.created_at as string,
  }));
}
