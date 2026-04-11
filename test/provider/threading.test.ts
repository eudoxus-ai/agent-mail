import { describe, it, expect } from 'vitest';
import { buildThreads, getThreadId } from '../../src/provider/threading.js';
import type { EmailMessage } from '../../src/types.js';

function makeMessage(overrides: Partial<EmailMessage>): EmailMessage {
  return {
    uid: 1,
    messageId: 'msg-1@test.com',
    from: 'alice@test.com',
    to: ['bob@test.com'],
    cc: [],
    date: '2026-04-10T10:00:00Z',
    subject: 'Test',
    bodyText: 'Hello',
    references: [],
    flags: [],
    mailbox: 'INBOX',
    ...overrides,
  };
}

describe('buildThreads', () => {
  it('groups messages by references into a thread', () => {
    const messages: EmailMessage[] = [
      makeMessage({ uid: 1, messageId: 'msg-1@test.com', subject: 'Hello' }),
      makeMessage({
        uid: 2,
        messageId: 'msg-2@test.com',
        subject: 'Re: Hello',
        inReplyTo: 'msg-1@test.com',
        references: ['msg-1@test.com'],
        date: '2026-04-10T11:00:00Z',
      }),
      makeMessage({
        uid: 3,
        messageId: 'msg-3@test.com',
        subject: 'Re: Re: Hello',
        inReplyTo: 'msg-2@test.com',
        references: ['msg-1@test.com', 'msg-2@test.com'],
        date: '2026-04-10T12:00:00Z',
      }),
    ];

    const threads = buildThreads(messages, 'gmail');
    expect(threads).toHaveLength(1);
    expect(threads[0].messageCount).toBe(3);
    expect(threads[0].messages[0].messageId).toBe('msg-1@test.com');
    expect(threads[0].messages[2].messageId).toBe('msg-3@test.com');
  });

  it('separates unrelated messages into distinct threads', () => {
    const messages: EmailMessage[] = [
      makeMessage({ uid: 1, messageId: 'msg-a@test.com', subject: 'Topic A' }),
      makeMessage({ uid: 2, messageId: 'msg-b@test.com', subject: 'Topic B' }),
    ];

    const threads = buildThreads(messages, 'gmail');
    expect(threads).toHaveLength(2);
  });

  it('collects participants from all messages', () => {
    const messages: EmailMessage[] = [
      makeMessage({ uid: 1, messageId: 'msg-1@test.com', from: 'alice@test.com', to: ['bob@test.com'] }),
      makeMessage({
        uid: 2,
        messageId: 'msg-2@test.com',
        from: 'bob@test.com',
        to: ['alice@test.com', 'carol@test.com'],
        inReplyTo: 'msg-1@test.com',
        references: ['msg-1@test.com'],
      }),
    ];

    const threads = buildThreads(messages, 'gmail');
    expect(threads[0].participants).toContain('alice@test.com');
    expect(threads[0].participants).toContain('bob@test.com');
    expect(threads[0].participants).toContain('carol@test.com');
  });

  it('handles single message as its own thread', () => {
    const messages = [makeMessage({ uid: 1, messageId: 'solo@test.com' })];
    const threads = buildThreads(messages, 'gmail');
    expect(threads).toHaveLength(1);
    expect(threads[0].messageCount).toBe(1);
  });
});

describe('getThreadId', () => {
  it('returns the root reference as thread ID', () => {
    const msg = makeMessage({
      messageId: 'msg-3@test.com',
      references: ['msg-1@test.com', 'msg-2@test.com'],
    });
    expect(getThreadId(msg)).toBe('msg-1@test.com');
  });

  it('falls back to inReplyTo when no references', () => {
    const msg = makeMessage({
      messageId: 'msg-2@test.com',
      inReplyTo: 'msg-1@test.com',
      references: [],
    });
    expect(getThreadId(msg)).toBe('msg-1@test.com');
  });

  it('uses own messageId when no references or inReplyTo', () => {
    const msg = makeMessage({ messageId: 'standalone@test.com' });
    expect(getThreadId(msg)).toBe('standalone@test.com');
  });
});
