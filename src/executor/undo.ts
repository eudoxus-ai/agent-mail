export interface UndoOperation {
  tool: string;
  reverseAction: string;
  params: Record<string, unknown>;
}

export function generateUndoToken(
  tool: string,
  params: Record<string, unknown>
): string {
  const operation: UndoOperation = {
    tool,
    reverseAction: getReversAction(tool),
    params,
  };
  return JSON.stringify(operation);
}

export function parseUndoToken(token: string): UndoOperation {
  return JSON.parse(token) as UndoOperation;
}

export function getUndoExpiry(tool: string): string | null {
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  switch (tool) {
    case 'hold_messages':
    case 'hold_by_sender':
    case 'label_thread':
    case 'restore_messages':
    case 'draft_reply':
      return new Date(Date.now() + THIRTY_DAYS_MS).toISOString();
    default:
      return null;
  }
}

function getReversAction(tool: string): string {
  switch (tool) {
    case 'hold_messages':
    case 'hold_by_sender':
      return 'move_back_to_inbox';
    case 'label_thread':
      return 'reverse_label';
    case 'restore_messages':
      return 'rehold_messages';
    case 'draft_reply':
      return 'delete_draft';
    case 'unsubscribe_sender':
      return 'not_reversible';
    case 'queue_send':
      return 'not_reversible';
    default:
      return 'not_reversible';
  }
}
