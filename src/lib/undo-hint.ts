export interface UndoHintArgs {
  intent_id: string;
  tool: string;
  created_at: string; // ISO8601
  window_ms?: number; // default 30 days
}

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function buildUndoHint(args: UndoHintArgs) {
  const created = new Date(args.created_at);
  const expires = new Date(created.getTime() + (args.window_ms ?? DEFAULT_WINDOW_MS));
  const method = args.tool === 'hold_messages' ? 'restore_messages' : 'undo_intent';
  return {
    reversible: true,
    undo_hint: {
      intent_id: args.intent_id,
      method,
      window_expires_at: expires.toISOString(),
    },
  };
}
