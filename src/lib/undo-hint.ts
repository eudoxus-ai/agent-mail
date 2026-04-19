export interface UndoHintArgs {
  intent_id: string;
  tool: string;
  created_at: string; // ISO8601
  window_ms?: number; // default 30 days
}

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const REVERSIBLE_TOOLS = new Set(['hold_messages', 'hold_by_sender', 'label_thread', 'restore_messages', 'draft_reply']);

export function buildUndoHint(args: UndoHintArgs): {
  reversible: true;
  undo_hint: { intent_id: string; method: string; window_expires_at: string };
  to_undo: string;
} | null {
  if (!REVERSIBLE_TOOLS.has(args.tool)) return null;
  const created = new Date(args.created_at);
  const expires = new Date(created.getTime() + (args.window_ms ?? DEFAULT_WINDOW_MS));
  const method =
    args.tool === 'hold_messages' || args.tool === 'hold_by_sender'
      ? 'restore_messages'
      : 'undo_intent';
  const window_expires_at = expires.toISOString();
  const to_undo = `To undo: call ${method} with intent_id "${args.intent_id}" (expires ${window_expires_at}).`;
  return {
    reversible: true,
    undo_hint: {
      intent_id: args.intent_id,
      method,
      window_expires_at,
    },
    to_undo,
  };
}
