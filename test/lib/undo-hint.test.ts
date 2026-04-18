import { describe, it, expect } from 'vitest';
import { buildUndoHint } from '../../src/lib/undo-hint.js';

describe('buildUndoHint', () => {
  it('returns restore_messages for hold intents', () => {
    expect(buildUndoHint({
      intent_id: 'i1', tool: 'hold_messages', created_at: '2026-04-18T12:00:00Z',
    })).toEqual({
      reversible: true,
      undo_hint: {
        intent_id: 'i1',
        method: 'restore_messages',
        window_expires_at: '2026-05-18T12:00:00.000Z',
      },
    });
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
  it('returns undo_intent for draft_reply', () => {
    const hint = buildUndoHint({
      intent_id: 'i4', tool: 'draft_reply', created_at: '2026-04-18T12:00:00Z',
    });
    expect(hint).not.toBeNull();
    expect(hint!.undo_hint.method).toBe('undo_intent');
  });
  it('returns null for non-reversible tools', () => {
    expect(buildUndoHint({ intent_id: 'i5', tool: 'queue_send', created_at: '2026-04-18T12:00:00Z' })).toBeNull();
    expect(buildUndoHint({ intent_id: 'i6', tool: 'unsubscribe_sender', created_at: '2026-04-18T12:00:00Z' })).toBeNull();
    expect(buildUndoHint({ intent_id: 'i7', tool: 'search_threads', created_at: '2026-04-18T12:00:00Z' })).toBeNull();
  });
});
