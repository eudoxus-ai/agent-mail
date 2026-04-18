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
  it('returns undo_intent for other tools', () => {
    expect(buildUndoHint({
      intent_id: 'i2', tool: 'label_thread', created_at: '2026-04-18T12:00:00Z',
    }).undo_hint.method).toBe('undo_intent');
  });
});
