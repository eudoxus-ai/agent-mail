import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import type { Database } from '../../src/ledger/sqlite.js';
import { createIntent } from '../../src/ledger/intents.js';
import {
  insertIntentTargets,
  updateIntentTargetDestinations,
  getIntentTargets,
  getUnconfirmedTargets,
} from '../../src/ledger/intent-targets.js';

/**
 * Targets are written before the IMAP move, not after.
 *
 * Previously a bulk hold persisted its targets only once every account's moves
 * had finished. If the process died mid-sweep, messages sat in the holding
 * folder with no envelope snapshot and no original_mailbox — restore_messages
 * had nothing to work from, so an interrupted sweep was unrecoverable.
 */

let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:');
});

function intentId(): string {
  return createIntent(db, {
    account_id: 'icloud',
    tool: 'hold_by_sender',
    params: { sender: 'news@example.com' },
    risk: 'medium',
    agent_id: 'test',
  }).id;
}

const targets = [
  {
    account_id: 'icloud',
    uid: 101,
    mailbox: 'INBOX',
    envelope_snapshot: {
      subject: 'Morning Brew',
      from: 'news@example.com',
      original_mailbox: 'INBOX',
    },
  },
  {
    account_id: 'icloud',
    uid: 102,
    mailbox: 'INBOX',
    envelope_snapshot: {
      subject: 'Morning Brew',
      from: 'news@example.com',
      original_mailbox: 'INBOX',
    },
  },
];

describe('interrupted bulk hold', () => {
  it('leaves a restorable record when the move never completes', () => {
    const id = intentId();

    // Ledger write happens first...
    insertIntentTargets(db, id, targets);
    // ...and then the process dies before any move is confirmed.

    const recorded = getIntentTargets(db, id);
    expect(recorded).toHaveLength(2);
    // This is what restore_messages needs and previously would not have had.
    expect(recorded[0].envelope_snapshot?.original_mailbox).toBe('INBOX');
    expect(recorded[0].envelope_snapshot?.subject).toBe('Morning Brew');
  });

  it('marks targets unconfirmed until the move reports back', () => {
    const id = intentId();
    insertIntentTargets(db, id, targets);

    expect(getUnconfirmedTargets(db, id)).toHaveLength(2);

    updateIntentTargetDestinations(db, id, 'icloud', new Map([[101, 9001]]));

    // One confirmed, one still in flight when the process stopped.
    const unconfirmed = getUnconfirmedTargets(db, id);
    expect(unconfirmed).toHaveLength(1);
    expect(unconfirmed[0].uid).toBe(102);
  });

  it('records where confirmed messages landed', () => {
    const id = intentId();
    insertIntentTargets(db, id, targets);
    updateIntentTargetDestinations(
      db,
      id,
      'icloud',
      new Map([
        [101, 9001],
        [102, 9002],
      ])
    );

    const rows = getIntentTargets(db, id);
    expect(rows.map((r) => r.destination_uid)).toEqual([9001, 9002]);
    expect(getUnconfirmedTargets(db, id)).toHaveLength(0);
  });

  it('survives a retry of the same batch without a primary-key collision', () => {
    const id = intentId();
    insertIntentTargets(db, id, targets);

    // A re-run after an ambiguous timeout re-inserts the same rows.
    expect(() => insertIntentTargets(db, id, targets)).not.toThrow();
    expect(getIntentTargets(db, id)).toHaveLength(2);
  });

  it('does not lose a confirmed destination to a later re-insert', () => {
    const id = intentId();
    insertIntentTargets(db, id, targets);
    updateIntentTargetDestinations(db, id, 'icloud', new Map([[101, 9001]]));

    // Re-inserting carries no destination_uid; it must not clobber the one we
    // already confirmed, or undo would move the wrong message back.
    insertIntentTargets(db, id, targets);

    const row = getIntentTargets(db, id).find((r) => r.uid === 101)!;
    expect(row.destination_uid).toBe(9001);
  });

  it('does not lose an envelope snapshot to a later re-insert', () => {
    const id = intentId();
    insertIntentTargets(db, id, targets);
    insertIntentTargets(db, id, [
      { account_id: 'icloud', uid: 101, mailbox: 'INBOX' },
    ]);

    const row = getIntentTargets(db, id).find((r) => r.uid === 101)!;
    expect(row.envelope_snapshot?.original_mailbox).toBe('INBOX');
  });

  it('scopes destination updates to one account', () => {
    const id = intentId();
    insertIntentTargets(db, id, [
      ...targets,
      { account_id: 'gmail', uid: 101, mailbox: 'INBOX' },
    ]);

    // UIDs are only unique per account; a cross-account update would corrupt
    // the other account's undo record.
    updateIntentTargetDestinations(db, id, 'icloud', new Map([[101, 9001]]));

    const gmail = getIntentTargets(db, id).find((r) => r.account_id === 'gmail')!;
    expect(gmail.destination_uid).toBeNull();
  });
});

describe('targets spanning mailboxes', () => {
  /**
   * IMAP UIDs are unique only within a mailbox. With a primary key of
   * (intent_id, account_id, uid), a single hold_messages call covering INBOX
   * uid 123 and Archive uid 123 collided — and once inserts became upserts the
   * collision silently overwrote the first envelope snapshot. Both messages
   * moved; only one could be restored.
   */
  const sameUidTwoMailboxes = [
    {
      account_id: 'icloud',
      uid: 123,
      mailbox: 'INBOX',
      envelope_snapshot: {
        subject: 'From the inbox',
        from: 'a@example.com',
        original_mailbox: 'INBOX',
      },
    },
    {
      account_id: 'icloud',
      uid: 123,
      mailbox: 'Archive',
      envelope_snapshot: {
        subject: 'From the archive',
        from: 'b@example.com',
        original_mailbox: 'Archive',
      },
    },
  ];

  it('keeps both records rather than collapsing them', () => {
    const id = intentId();
    insertIntentTargets(db, id, sameUidTwoMailboxes);

    const rows = getIntentTargets(db, id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.mailbox).sort()).toEqual(['Archive', 'INBOX']);
  });

  it('keeps each snapshot intact, so both stay restorable', () => {
    const id = intentId();
    insertIntentTargets(db, id, sameUidTwoMailboxes);

    const rows = getIntentTargets(db, id);
    const inbox = rows.find((r) => r.mailbox === 'INBOX')!;
    const archive = rows.find((r) => r.mailbox === 'Archive')!;

    expect(inbox.envelope_snapshot?.original_mailbox).toBe('INBOX');
    expect(archive.envelope_snapshot?.original_mailbox).toBe('Archive');
  });

  it('scopes destination updates to one mailbox', () => {
    const id = intentId();
    insertIntentTargets(db, id, sameUidTwoMailboxes);

    updateIntentTargetDestinations(db, id, 'icloud', new Map([[123, 9001]]), 'INBOX');

    const rows = getIntentTargets(db, id);
    expect(rows.find((r) => r.mailbox === 'INBOX')!.destination_uid).toBe(9001);
    // The Archive message has not moved; stamping it would send undo to the
    // wrong message.
    expect(rows.find((r) => r.mailbox === 'Archive')!.destination_uid).toBeNull();
  });
});
