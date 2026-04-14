import { describe, expect, it } from 'vitest';
import { queueSendTool } from '../../src/tools/queue-send.js';

describe('queueSendTool.validate', () => {
  it('accepts inline send mode', () => {
    const parsed = queueSendTool.validate?.({
      to: 'alice@example.com',
      subject: 'Hello',
      body: 'World',
    });

    expect(parsed).toMatchObject({
      to: 'alice@example.com',
      subject: 'Hello',
      body: 'World',
    });
  });

  it('accepts draft send mode', () => {
    const parsed = queueSendTool.validate?.({
      draft_id: 42,
    });

    expect(parsed).toMatchObject({ draft_id: 42 });
  });

  it('rejects mixed send modes', () => {
    expect(() =>
      queueSendTool.validate?.({
        draft_id: 42,
        to: 'alice@example.com',
        subject: 'Hello',
        body: 'World',
      })
    ).toThrow('exactly one mode');
  });

  it('rejects partial inline mode', () => {
    expect(() =>
      queueSendTool.validate?.({
        to: 'alice@example.com',
        subject: 'Hello',
      })
    ).toThrow('requires to, subject, and body');
  });
});
