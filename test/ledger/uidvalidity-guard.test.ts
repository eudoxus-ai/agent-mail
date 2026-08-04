import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/ledger/db.js';
import type { Database } from '../../src/ledger/sqlite.js';
import { createIntent } from '../../src/ledger/intents.js';
import {
  insertIntentTargets,
  getIntentTargets,
} from '../../src/ledger/intent-targets.js';

/**
 * A UID means nothing without its mailbox generation.
 *
 * IMAP UIDs are only meaningful within a (mailbox, UIDVALIDITY) pair. When the
 * server reassigns UIDs — a rebuild, a restore, a provider migration — the same
 * number identifies a completely different message. Every replay path
 * (restore_messages, undo_intent, and soon a durable queue's at-least-once
 * retry) moves mail by recorded UID, so replaying across a generation boundary
 * would move messages the user never selected.
 *
 * Recording the generation is what makes that detectable.
 */

let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:');
});

function intentId(): string {
  return createIntent(db, {
    account_id: 'icloud',
    tool: 'hold_messages',
    params: {},
    risk: 'medium',
    agent_id: 'test',
  }).id;
}

describe('uidvalidity on intent targets', () => {
  it('persists the generation a UID was captured in', () => {
    const id = intentId();

    insertIntentTargets(db, id, [
      {
        account_id: 'icloud',
        uid: 123,
        mailbox: 'INBOX',
        uidvalidity: 42,
        envelope_snapshot: {
          subject: 'Q2 pricing',
          from: 'alice@example.com',
          original_mailbox: 'INBOX',
        },
      },
    ]);

    expect(getIntentTargets(db, id)[0].uidvalidity).toBe(42);
  });

  it('reads back null for rows recorded before the column existed', () => {
    const id = intentId();

    // Back-compat: every target written before this migration has no
    // generation. Those rows must still be readable — refusing them would
    // break undo for everything already in the ledger.
    insertIntentTargets(db, id, [
      { account_id: 'icloud', uid: 123, mailbox: 'INBOX' },
    ]);

    expect(getIntentTargets(db, id)[0].uidvalidity).toBeNull();
  });

  it('keeps generations distinct per mailbox', () => {
    const id = intentId();

    // Mailboxes have independent UIDVALIDITY values; one is not a proxy for
    // the other.
    insertIntentTargets(db, id, [
      { account_id: 'icloud', uid: 123, mailbox: 'INBOX', uidvalidity: 42 },
      { account_id: 'icloud', uid: 123, mailbox: 'Archive', uidvalidity: 7 },
    ]);

    const rows = getIntentTargets(db, id);
    expect(rows.find((r) => r.mailbox === 'INBOX')!.uidvalidity).toBe(42);
    expect(rows.find((r) => r.mailbox === 'Archive')!.uidvalidity).toBe(7);
  });

  it('does not erase a recorded generation on re-insert', () => {
    const id = intentId();

    insertIntentTargets(db, id, [
      { account_id: 'icloud', uid: 123, mailbox: 'INBOX', uidvalidity: 42 },
    ]);
    // A retry after an ambiguous timeout re-inserts, possibly without the
    // generation. Losing it would silently disable the guard.
    insertIntentTargets(db, id, [
      { account_id: 'icloud', uid: 123, mailbox: 'INBOX' },
    ]);

    expect(getIntentTargets(db, id)[0].uidvalidity).toBe(42);
  });
});
