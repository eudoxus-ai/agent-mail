import { describe, it, expect } from 'vitest';
import { shouldNotify } from '../../src/reviewer/notification-policy.js';
import type { Intent } from '../../src/types.js';

const mk = (over: Partial<Intent>): Intent => ({
  id: 'i1', tool: 'hold_messages', params: {}, risk: 'low',
  status: 'pending', account_id: 'a', agent_id: 'claude',
  created_at: new Date().toISOString(), resolved_at: null,
  resolved_by: null, error_detail: null, undo_token: null,
  undo_expires_at: null,
  ...over,
});

describe('shouldNotify', () => {
  it('notifies for high risk (e.g. queue_send)', () => {
    expect(shouldNotify(mk({ tool: 'queue_send', risk: 'high' }))).toBe(true);
  });
  it('notifies for medium risk with replies', () => {
    expect(shouldNotify(mk({ tool: 'hold_messages', risk: 'medium' }))).toBe(true);
  });
  it('suppresses low-risk gated intents', () => {
    expect(shouldNotify(mk({ tool: 'label_thread', risk: 'low' }))).toBe(false);
  });
  it('suppresses unknown-tool fallback gated intents', () => {
    expect(shouldNotify(mk({ tool: 'list_mailboxes', risk: 'high', params: { __unknown_tool_fallback: true } }))).toBe(false);
  });
});
