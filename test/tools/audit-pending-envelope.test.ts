import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from '../../src/ledger/sqlite.js';
import type { AccountConfig, ToolContext } from '../../src/types.js';
import { openDatabase } from '../../src/ledger/db.js';
import { createIntent } from '../../src/ledger/intents.js';
import { logAudit } from '../../src/ledger/audit.js';
import { createLogger } from '../../src/logger.js';
import { getAuditLogTool } from '../../src/tools/get-audit-log.js';
import { getPendingActionsTool } from '../../src/tools/get-pending-actions.js';

const a: AccountConfig = {
  id: 'a@x.com',
  email: 'a@x.com',
  imap: { host: 'imap.x.com', port: 993, tls: true },
  smtp: { host: 'smtp.x.com', port: 587, tls: true },
};
const b: AccountConfig = {
  id: 'b@y.com',
  email: 'b@y.com',
  imap: { host: 'imap.y.com', port: 993, tls: true },
  smtp: { host: 'smtp.y.com', port: 587, tls: true },
};

let db: Database;
let ctx: ToolContext;

beforeEach(() => {
  db = openDatabase(':memory:');
  ctx = {
    accountId: 'a@x.com',
    agentId: 'claude',
    db,
    accounts: [a, b],
    logger: createLogger('cli', { minLevel: 'error' }),
  };
});

function readEnvelope(text: string) {
  return JSON.parse(text);
}

describe('getAuditLogTool — envelope', () => {
  it('returns envelope with all account ids when account_ids is omitted', async () => {
    const result = await getAuditLogTool.execute({}, ctx);
    const env = readEnvelope(result.content![0].text);
    expect(env.accounts_searched).toEqual(['a@x.com', 'b@y.com']);
    expect(env.accounts_available).toEqual(['a@x.com', 'b@y.com']);
    expect(env.results).toEqual([]);
  });

  it('scopes accounts_searched when account_ids is provided', async () => {
    const ia = createIntent(db, { account_id: 'a@x.com', tool: 'queue_send', params: {}, risk: 'high' });
    const ib = createIntent(db, { account_id: 'b@y.com', tool: 'queue_send', params: {}, risk: 'high' });
    logAudit(db, { intent_id: ia.id, account_id: 'a@x.com', action: 'created', actor: 'claude' });
    logAudit(db, { intent_id: ib.id, account_id: 'b@y.com', action: 'created', actor: 'claude' });

    const result = await getAuditLogTool.execute({ account_ids: ['a@x.com'] }, ctx);
    const env = readEnvelope(result.content![0].text);
    expect(env.accounts_searched).toEqual(['a@x.com']);
    expect(env.accounts_available).toEqual(['a@x.com', 'b@y.com']);
    expect(env.results).toHaveLength(1);
    expect(env.results[0].account_id).toBe('a@x.com');
  });

  it('throws on unknown account_ids', async () => {
    await expect(
      getAuditLogTool.execute({ account_ids: ['nope@nowhere'] }, ctx)
    ).rejects.toThrow(/Unknown account_ids: nope@nowhere/);
  });
});

describe('getPendingActionsTool — envelope', () => {
  it('returns envelope with all account ids when account_ids is omitted', async () => {
    const result = await getPendingActionsTool.execute({}, ctx);
    const env = readEnvelope(result.content![0].text);
    expect(env.accounts_searched).toEqual(['a@x.com', 'b@y.com']);
    expect(env.accounts_available).toEqual(['a@x.com', 'b@y.com']);
    expect(env.results).toEqual([]);
  });

  it('scopes accounts_searched when account_ids is provided', async () => {
    createIntent(db, { account_id: 'a@x.com', tool: 'queue_send', params: {}, risk: 'high' });
    createIntent(db, { account_id: 'b@y.com', tool: 'queue_send', params: {}, risk: 'high' });

    const result = await getPendingActionsTool.execute({ account_ids: ['a@x.com'] }, ctx);
    const env = readEnvelope(result.content![0].text);
    expect(env.accounts_searched).toEqual(['a@x.com']);
    expect(env.accounts_available).toEqual(['a@x.com', 'b@y.com']);
    expect(env.results).toHaveLength(1);
    expect(env.results[0].account).toBe('a@x.com');
  });

  it('throws on unknown account_ids', async () => {
    await expect(
      getPendingActionsTool.execute({ account_ids: ['nope@nowhere'] }, ctx)
    ).rejects.toThrow(/Unknown account_ids: nope@nowhere/);
  });
});
