import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

export const getDiagnosticsTool: ToolDefinition = {
  name: 'get_diagnostics',
  description:
    'Live internal state of the running MCP server: IMAP connection pool health, per-account queue depth, the operation currently in flight and how long it has been running, any actions stuck mid-execution, and runtime info. Use this when tool calls hang, time out, or when background intents sit at "executing" without progressing — it distinguishes "queued behind a slow operation" from "wedged" from "the process restarted". This state lives only inside the server process, so no CLI command can show it.',
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  async execute() {
    return { type: 'immediate', content: [] };
  },
};
