import { describe, it, expect } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import {
  insertIntentTargets,
  getIntentTargets,
} from '../../src/ledger/intent-targets.js';

describe('intent_targets', () => {
  it('inserts and retrieves target rows with envelope snapshots', () => {
    const db = openDatabase(':memory:');
    db.prepare(
      `INSERT INTO intents (id, account_id, tool, params, risk, status)
       VALUES ('i1', 'a@x.com', 'hold_messages', '{}', 'medium', 'executed')`
    ).run();

    insertIntentTargets(db, 'i1', [
      {
        account_id: 'a@x.com',
        uid: 42,
        mailbox: 'INBOX',
        envelope_snapshot: { subject: 'Hi', from: 'b@y.com', original_mailbox: 'INBOX' },
      },
    ]);

    const rows = getIntentTargets(db, 'i1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      intent_id: 'i1',
      account_id: 'a@x.com',
      uid: 42,
      mailbox: 'INBOX',
    });
    expect(rows[0].envelope_snapshot).toEqual({
      subject: 'Hi',
      from: 'b@y.com',
      original_mailbox: 'INBOX',
    });
  });

  it('returns empty array when no targets recorded', () => {
    const db = openDatabase(':memory:');
    expect(getIntentTargets(db, 'missing')).toEqual([]);
  });

  it('persists envelope_snapshot as null when omitted', () => {
    const db = openDatabase(':memory:');
    db.prepare(
      `INSERT INTO intents (id, account_id, tool, params, risk, status)
       VALUES ('i2', 'a@x.com', 'hold_messages', '{}', 'medium', 'executed')`
    ).run();
    insertIntentTargets(db, 'i2', [
      { account_id: 'a@x.com', uid: 1, mailbox: 'INBOX' },
    ]);
    const rows = getIntentTargets(db, 'i2');
    expect(rows[0].envelope_snapshot).toBeNull();
  });

  it('round-trips destination_uid', () => {
    const db = openDatabase(':memory:');
    db.prepare(
      `INSERT INTO intents (id, account_id, tool, params, risk, status)
       VALUES ('i3', 'a@x.com', 'hold_messages', '{}', 'medium', 'executed')`
    ).run();
    insertIntentTargets(db, 'i3', [
      { account_id: 'a@x.com', uid: 10, mailbox: 'agent-mail-holding', destination_uid: 500 },
      { account_id: 'a@x.com', uid: 11, mailbox: 'agent-mail-holding' },
    ]);
    const rows = getIntentTargets(db, 'i3');
    expect(rows).toHaveLength(2);
    // Row with explicit destination_uid
    expect(rows[0].uid).toBe(10);
    expect(rows[0].destination_uid).toBe(500);
    // Row without destination_uid should be null
    expect(rows[1].uid).toBe(11);
    expect(rows[1].destination_uid).toBeNull();
  });
});
