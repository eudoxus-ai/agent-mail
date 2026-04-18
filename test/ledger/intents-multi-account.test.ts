import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from '../../src/ledger/sqlite.js';
import { openDatabase } from '../../src/ledger/db.js';
import { createIntent, getPendingIntents } from '../../src/ledger/intents.js';

let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:');
});

function seed() {
  createIntent(db, { account_id: 'a@x.com', tool: 'queue_send', params: {}, risk: 'high' });
  createIntent(db, { account_id: 'b@y.com', tool: 'queue_send', params: {}, risk: 'high' });
  createIntent(db, { account_id: 'c@z.com', tool: 'queue_send', params: {}, risk: 'high' });
}

describe('getPendingIntents — multi-account', () => {
  it('scopes to a single account', () => {
    seed();
    const rows = getPendingIntents(db, ['a@x.com']);
    expect(rows).toHaveLength(1);
    expect(rows[0].account_id).toBe('a@x.com');
  });

  it('returns rows for multiple accounts ordered by created_at ASC', () => {
    seed();
    const rows = getPendingIntents(db, ['a@x.com', 'b@y.com']);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.account_id)).toEqual(['a@x.com', 'b@y.com']);
    const t0 = new Date(rows[0].created_at).getTime();
    const t1 = new Date(rows[1].created_at).getTime();
    expect(t0).toBeLessThanOrEqual(t1);
  });

  it('returns all pending intents when account_ids is omitted', () => {
    seed();
    const rows = getPendingIntents(db);
    expect(rows).toHaveLength(3);
  });
});
