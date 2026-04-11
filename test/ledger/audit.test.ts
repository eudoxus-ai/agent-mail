import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from '../../src/ledger/sqlite.js';
import { openDatabase } from '../../src/ledger/db.js';
import { logAudit, getAuditLog } from '../../src/ledger/audit.js';
import { createIntent } from '../../src/ledger/intents.js';

let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:');
});

describe('logAudit', () => {
  it('logs an audit entry', () => {
    const intent = createIntent(db, {
      account_id: 'gmail',
      tool: 'queue_send',
      params: {},
      risk: 'high',
    });

    logAudit(db, {
      intent_id: intent.id,
      account_id: 'gmail',
      action: 'created',
      actor: 'claude',
      detail: { source: 'mcp' },
    });

    const entries = getAuditLog(db);
    expect(entries).toHaveLength(1);
    expect(entries[0].intent_id).toBe(intent.id);
    expect(entries[0].action).toBe('created');
    expect(entries[0].actor).toBe('claude');
    expect(entries[0].detail).toEqual({ source: 'mcp' });
  });
});

describe('getAuditLog', () => {
  it('filters by account_id', () => {
    const i1 = createIntent(db, { account_id: 'gmail', tool: 'queue_send', params: {}, risk: 'high' });
    const i2 = createIntent(db, { account_id: 'icloud', tool: 'queue_send', params: {}, risk: 'high' });
    logAudit(db, { intent_id: i1.id, account_id: 'gmail', action: 'created', actor: 'claude' });
    logAudit(db, { intent_id: i2.id, account_id: 'icloud', action: 'created', actor: 'claude' });

    const gmail = getAuditLog(db, { account_id: 'gmail' });
    expect(gmail).toHaveLength(1);
    expect(gmail[0].account_id).toBe('gmail');
  });

  it('supports limit and offset', () => {
    const intent = createIntent(db, { account_id: 'gmail', tool: 'label_thread', params: {}, risk: 'low' });
    for (let i = 0; i < 5; i++) {
      logAudit(db, { intent_id: intent.id, action: 'created', actor: `agent-${i}` });
    }

    const page1 = getAuditLog(db, { limit: 2, offset: 0 });
    expect(page1).toHaveLength(2);

    const page2 = getAuditLog(db, { limit: 2, offset: 2 });
    expect(page2).toHaveLength(2);
  });

  it('returns entries in reverse chronological order', () => {
    const intent = createIntent(db, { account_id: 'gmail', tool: 'queue_send', params: {}, risk: 'high' });
    logAudit(db, { intent_id: intent.id, action: 'created', actor: 'claude' });
    logAudit(db, { intent_id: intent.id, action: 'approved', actor: 'user' });
    logAudit(db, { intent_id: intent.id, action: 'executed', actor: 'policy' });

    const entries = getAuditLog(db);
    expect(entries[0].action).toBe('executed');
    expect(entries[2].action).toBe('created');
  });
});
