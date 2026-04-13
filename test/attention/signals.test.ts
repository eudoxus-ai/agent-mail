import { describe, it, expect } from 'vitest';
import { computeSignals } from '../../src/attention/signals.js';
import type { EmailMessage, Participant } from '../../src/types.js';

const me = 'you@example.com';
const p = (address: string, name: string | null = null): Participant => ({
  address: address.toLowerCase(),
  name,
});

function makeMessage(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    uid: 1,
    messageId: 'msg-1@test.com',
    from: p('alice@example.com', 'Alice'),
    to: [p(me)],
    cc: [],
    date: '2026-04-12T10:00:00Z',
    subject: 'Test',
    bodyText: '',
    references: [],
    flags: [],
    mailbox: 'INBOX',
    ...overrides,
  };
}

describe('computeSignals — recipient signals', () => {
  it('detects direct-to-me', () => {
    const s = computeSignals(makeMessage(), {
      accountEmail: me,
      threadMessages: [],
    });
    expect(s.direct_to_me).toBe(true);
    expect(s.cc_to_me).toBe(false);
    expect(s.is_bulk).toBe(false);
  });

  it('detects cc-to-me (not direct)', () => {
    const msg = makeMessage({
      to: [p('other@example.com')],
      cc: [p(me)],
    });
    const s = computeSignals(msg, { accountEmail: me, threadMessages: [] });
    expect(s.direct_to_me).toBe(false);
    expect(s.cc_to_me).toBe(true);
  });

  it('detects bulk when not a recipient at all', () => {
    const msg = makeMessage({
      to: [p('list@example.com')],
      cc: [],
    });
    const s = computeSignals(msg, { accountEmail: me, threadMessages: [] });
    expect(s.direct_to_me).toBe(false);
    expect(s.is_bulk).toBe(true);
  });

  it('matches accountEmail case-insensitively', () => {
    const msg = makeMessage({ to: [p('YOU@EXAMPLE.COM')] });
    const s = computeSignals(msg, {
      accountEmail: 'You@Example.com',
      threadMessages: [],
    });
    expect(s.direct_to_me).toBe(true);
  });
});

describe('computeSignals — sender signals', () => {
  it('flags list mail by List-Id presence', () => {
    const msg = makeMessage({ listUnsubscribe: '<https://x/u>' });
    const s = computeSignals(msg, { accountEmail: me, threadMessages: [] });
    expect(s.is_list_mail).toBe(true);
  });

  it('flags automated senders', () => {
    const cases = [
      'noreply@github.com',
      'no-reply@shopify.com',
      'notifications@slack.com',
      'mailer-daemon@google.com',
    ];
    for (const addr of cases) {
      const msg = makeMessage({ from: p(addr) });
      const s = computeSignals(msg, { accountEmail: me, threadMessages: [] });
      expect(s.is_automated).toBe(true);
    }
  });

  it('does not flag normal human senders', () => {
    const msg = makeMessage({ from: p('alice@normalco.com') });
    const s = computeSignals(msg, { accountEmail: me, threadMessages: [] });
    expect(s.is_automated).toBe(false);
  });
});

describe('computeSignals — thread state', () => {
  it('is "new" for a single-message thread', () => {
    const msg = makeMessage();
    const s = computeSignals(msg, {
      accountEmail: me,
      threadMessages: [msg],
    });
    expect(s.thread_state).toBe('new');
  });

  it('is "awaiting_you" when the last message is from someone else to you', () => {
    const earlier = makeMessage({
      messageId: 'msg-1@test.com',
      from: p(me),
      to: [p('alice@example.com')],
      date: '2026-04-12T09:00:00Z',
    });
    const latest = makeMessage({
      messageId: 'msg-2@test.com',
      from: p('alice@example.com'),
      to: [p(me)],
      date: '2026-04-12T10:00:00Z',
      inReplyTo: 'msg-1@test.com',
    });
    const s = computeSignals(latest, {
      accountEmail: me,
      threadMessages: [earlier, latest],
    });
    expect(s.thread_state).toBe('awaiting_you');
  });

  it('is "awaiting_them" when the last message is from you', () => {
    const earlier = makeMessage({
      messageId: 'msg-1@test.com',
      from: p('alice@example.com'),
      to: [p(me)],
      date: '2026-04-12T09:00:00Z',
    });
    const latest = makeMessage({
      messageId: 'msg-2@test.com',
      from: p(me),
      to: [p('alice@example.com')],
      date: '2026-04-12T10:00:00Z',
      inReplyTo: 'msg-1@test.com',
    });
    const s = computeSignals(latest, {
      accountEmail: me,
      threadMessages: [earlier, latest],
    });
    expect(s.thread_state).toBe('awaiting_them');
  });

  it('overrides to "new" when the last message is automated', () => {
    const msg = makeMessage({
      from: p('notifications@github.com'),
      to: [p(me)],
    });
    const s = computeSignals(msg, {
      accountEmail: me,
      threadMessages: [msg],
    });
    expect(s.thread_state).toBe('new');
    expect(s.is_automated).toBe(true);
  });

  it('overrides to "new" when the message is list mail', () => {
    const msg = makeMessage({
      listUnsubscribe: '<https://x/u>',
      from: p('list@example.com'),
    });
    const s = computeSignals(msg, {
      accountEmail: me,
      threadMessages: [msg],
    });
    expect(s.thread_state).toBe('new');
  });
});

describe('computeSignals — reply context', () => {
  it('detects in_reply_to_your_message', () => {
    const yours = makeMessage({
      messageId: 'yours@test.com',
      from: p(me),
      to: [p('alice@example.com')],
    });
    const theirs = makeMessage({
      messageId: 'theirs@test.com',
      from: p('alice@example.com'),
      to: [p(me)],
      inReplyTo: 'yours@test.com',
    });
    const s = computeSignals(theirs, {
      accountEmail: me,
      threadMessages: [yours, theirs],
    });
    expect(s.in_reply_to_your_message).toBe(true);
  });

  it('detects is_reply_in_thread_you_started', () => {
    const yours = makeMessage({
      messageId: 'yours@test.com',
      from: p(me),
    });
    const theirs = makeMessage({
      messageId: 'theirs@test.com',
      from: p('alice@example.com'),
      inReplyTo: 'yours@test.com',
    });
    const s = computeSignals(theirs, {
      accountEmail: me,
      threadMessages: [yours, theirs],
    });
    expect(s.is_reply_in_thread_you_started).toBe(true);
  });
});

describe('computeSignals — network signals', () => {
  it('collects thread participants in first-appearance order', () => {
    const m1 = makeMessage({
      messageId: 'm1',
      from: p('alice@x.com'),
      to: [p('bob@x.com')],
      date: '2026-04-12T09:00:00Z',
    });
    const m2 = makeMessage({
      messageId: 'm2',
      from: p('bob@x.com'),
      to: [p('alice@x.com'), p('carol@x.com')],
      date: '2026-04-12T10:00:00Z',
      inReplyTo: 'm1',
    });
    const s = computeSignals(m2, {
      accountEmail: me,
      threadMessages: [m1, m2],
    });
    const addrs = s.thread_participants.map((x) => x.address);
    expect(addrs).toEqual(['alice@x.com', 'bob@x.com', 'carol@x.com']);
    expect(s.thread_participant_count).toBe(3);
    expect(s.thread_message_count).toBe(2);
  });

  it('marks is_small_group for <= 4 participants', () => {
    const s = computeSignals(makeMessage(), {
      accountEmail: me,
      threadMessages: [makeMessage()],
    });
    expect(s.is_small_group).toBe(true);
  });

  it('marks is_broadcast when the current message has >= 10 recipients', () => {
    const many = Array.from({ length: 11 }, (_, i) => p(`p${i}@x.com`));
    const msg = makeMessage({ to: many });
    const s = computeSignals(msg, { accountEmail: me, threadMessages: [msg] });
    expect(s.is_broadcast).toBe(true);
  });
});

describe('computeSignals — Z-reserved fields', () => {
  it('has null for LLM-derived fields in this MVP', () => {
    const s = computeSignals(makeMessage(), {
      accountEmail: me,
      threadMessages: [],
    });
    expect(s.has_deadline_language).toBeNull();
    expect(s.mentions_you_by_name).toBeNull();
    expect(s.urgency_score).toBeNull();
  });
});
