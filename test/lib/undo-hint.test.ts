import { describe, it, expect } from 'vitest';
import { buildUndoHint } from '../../src/lib/undo-hint.js';

describe('buildUndoHint', () => {
  it('returns undo_intent for hold intents', () => {
    expect(buildUndoHint({
      intent_id: 'i1', tool: 'hold_messages', created_at: '2026-04-18T12:00:00Z',
    })).toEqual({
      reversible: true,
      undo_hint: {
        intent_id: 'i1',
        method: 'undo_intent',
        window_expires_at: '2026-05-18T12:00:00.000Z',
      },
      to_undo: 'To undo: call undo_intent with intent_id "i1" (expires 2026-05-18T12:00:00.000Z).',
    });
  });

  it('to_undo for hold_messages references undo_intent, not restore_messages (regression)', () => {
    const hint = buildUndoHint({
      intent_id: 'i-hold', tool: 'hold_messages', created_at: '2026-04-18T12:00:00Z',
    });
    expect(hint).not.toBeNull();
    expect(hint!.to_undo).toContain('undo_intent');
    expect(hint!.to_undo).not.toContain('restore_messages');
  });

  it('to_undo for hold_by_sender references undo_intent, not restore_messages (regression)', () => {
    const hint = buildUndoHint({
      intent_id: 'i-hbs', tool: 'hold_by_sender', created_at: '2026-04-18T12:00:00Z',
    });
    expect(hint).not.toBeNull();
    expect(hint!.to_undo).toContain('undo_intent');
    expect(hint!.to_undo).not.toContain('restore_messages');
  });

  it('includes a human-readable to_undo string naming intent_id and expiry', () => {
    const hint = buildUndoHint({
      intent_id: 'abc-123', tool: 'label_thread', created_at: '2026-04-18T12:00:00Z',
    });
    expect(hint).not.toBeNull();
    expect(hint!.to_undo).toMatch(/undo_intent.*intent_id "abc-123"/);
    expect(hint!.to_undo).toMatch(/expires 2026-05-18T12:00:00\.000Z/);
  });
  it('returns undo_intent for label_thread', () => {
    const hint = buildUndoHint({
      intent_id: 'i2', tool: 'label_thread', created_at: '2026-04-18T12:00:00Z',
    });
    expect(hint).not.toBeNull();
    expect(hint!.undo_hint.method).toBe('undo_intent');
  });
  it('returns undo_intent for restore_messages', () => {
    const hint = buildUndoHint({
      intent_id: 'i3', tool: 'restore_messages', created_at: '2026-04-18T12:00:00Z',
    });
    expect(hint).not.toBeNull();
    expect(hint!.undo_hint.method).toBe('undo_intent');
  });
  it('returns null for draft_reply (not reversible)', () => {
    const hint = buildUndoHint({
      intent_id: 'i4', tool: 'draft_reply', created_at: '2026-04-18T12:00:00Z',
    });
    expect(hint).toBeNull();
  });
  it('returns null for non-reversible tools', () => {
    expect(buildUndoHint({ intent_id: 'i5', tool: 'queue_send', created_at: '2026-04-18T12:00:00Z' })).toBeNull();
    expect(buildUndoHint({ intent_id: 'i6', tool: 'unsubscribe_sender', created_at: '2026-04-18T12:00:00Z' })).toBeNull();
    expect(buildUndoHint({ intent_id: 'i7', tool: 'search_threads', created_at: '2026-04-18T12:00:00Z' })).toBeNull();
  });
});
