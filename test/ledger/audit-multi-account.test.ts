import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from '../../src/ledger/sqlite.js';
import { openDatabase } from '../../src/ledger/db.js';
import { logAudit, getAuditLog } from '../../src/ledger/audit.js';
import { createIntent } from '../../src/ledger/intents.js';

let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:');
});

function seed() {
  const ia = createIntent(db, {
    account_id: 'a@x.com',
    tool: 'queue_send',
    params: {},
    risk: 'high',
  });
  const ib = createIntent(db, {
    account_id: 'b@y.com',
    tool: 'queue_send',
    params: {},
    risk: 'high',
  });
  const ic = createIntent(db, {
    account_id: 'c@z.com',
    tool: 'queue_send',
    params: {},
    risk: 'high',
  });
  logAudit(db, { intent_id: ia.id, account_id: 'a@x.com', action: 'created', actor: 'claude' });
  logAudit(db, { intent_id: ib.id, account_id: 'b@y.com', action: 'created', actor: 'claude' });
  logAudit(db, { intent_id: ic.id, account_id: 'c@z.com', action: 'created', actor: 'claude' });
}

describe('getAuditLog — multi-account', () => {
  it('scopes to a single account when account_ids has one entry', () => {
    seed();
    const rows = getAuditLog(db, { account_ids: ['a@x.com'] });
    expect(rows).toHaveLength(1);
    expect(rows[0].account_id).toBe('a@x.com');
  });

  it('returns rows for every requested account, ordered by id DESC', () => {
    seed();
    const rows = getAuditLog(db, { account_ids: ['a@x.com', 'b@y.com'] });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.account_id)).toEqual(['b@y.com', 'a@x.com']);
    expect(rows[0].id).toBeGreaterThan(rows[1].id);
  });

  it('returns all rows when account_ids is omitted', () => {
    seed();
    const rows = getAuditLog(db);
    expect(rows).toHaveLength(3);
  });
});
