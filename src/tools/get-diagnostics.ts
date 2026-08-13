import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

export const getDiagnosticsTool: ToolDefinition = {
  name: 'get_diagnostics',
  description:
    'Health of the whole system: whether the daemon that performs queued mutations is alive, how much work is queued and how long the oldest has waited, IMAP connection pool state for THIS process (the daemon has its own pool, not visible here), per-account borrow-queue depth, the operation currently in flight, executing intents split into in_progress_intents (live worker lease or fresh progress — do not re-run) and orphaned_intents (no lease, progress stale over ten minutes — safe to re-run), and runtime info. Call this FIRST when a mutation sits at "queued" without progressing — the usual cause is that the daemon is not running, and the `worker` block plus `interpretation` say so directly and give the command to fix it. Also use it when tool calls hang or time out: it distinguishes "queued behind a slow operation" from "wedged" from "the process restarted". Pool state lives only inside the server process, so no CLI command can show it.',
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
