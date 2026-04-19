import type { Intent } from '../types.js';

const NOTIFY_TOOLS = new Set(['queue_send', 'hold_messages', 'restore_messages']);

export function shouldNotify(intent: Intent): boolean {
  const params = (intent.params ?? {}) as Record<string, unknown>;
  if (params.__unknown_tool_fallback === true) return false;
  if (intent.risk === 'high') return true;
  if (intent.risk === 'medium' && NOTIFY_TOOLS.has(intent.tool)) return true;
  return false;
}
