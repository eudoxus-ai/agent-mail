import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { openDatabase, checkStuckExecuting } from '../ledger/db.js';
import { loadAccounts } from '../provider/accounts.js';
import { loadPolicy } from '../policy/engine.js';
import { Executor } from '../executor/executor.js';
import { wrapToolHandler } from './middleware.js';
import { createLogger } from '../logger.js';
import { getPendingIntents } from '../ledger/intents.js';
import { getAuditLog } from '../ledger/audit.js';

// Import all tools
import { searchThreadsTool } from '../tools/search-threads.js';
import { readThreadTool } from '../tools/read-thread.js';
import { draftReplyTool } from '../tools/draft-reply.js';
import { labelThreadTool } from '../tools/label-thread.js';
import { unsubscribeSenderTool } from '../tools/unsubscribe-sender.js';
import { getPendingActionsTool } from '../tools/get-pending-actions.js';
import { getAuditLogTool } from '../tools/get-audit-log.js';
import { queueSendTool } from '../tools/queue-send.js';
import { quarantineThreadTool } from '../tools/quarantine-thread.js';
import { undoIntentTool } from '../tools/undo-intent.js';

import type { ToolDefinition } from '../types.js';

const ALL_TOOLS: ToolDefinition[] = [
  searchThreadsTool,
  readThreadTool,
  draftReplyTool,
  labelThreadTool,
  unsubscribeSenderTool,
  getPendingActionsTool,
  getAuditLogTool,
  queueSendTool,
  quarantineThreadTool,
  undoIntentTool,
];

export async function createMcpServer(): Promise<McpServer> {
  const logger = createLogger('mcp');

  // Load accounts
  let accounts;
  try {
    accounts = loadAccounts();
  } catch (error) {
    logger.error(
      'Failed to load accounts. Run "npx agent-mail add-account" first.'
    );
    process.exit(1);
  }

  if (accounts.length === 0) {
    logger.error(
      'No accounts configured. Run "npx agent-mail add-account" first.'
    );
    process.exit(1);
  }

  // Open database
  const db = openDatabase();

  // Check for stuck executing intents (crash recovery)
  const stuck = checkStuckExecuting(db);
  if (stuck.length > 0) {
    logger.warn(
      `Found ${stuck.length} intent(s) stuck in 'executing' status (possible crash recovery).`,
      { intents: stuck.map((i) => ({ id: i.id, tool: i.tool })) }
    );
  }

  // Load policy
  const policy = loadPolicy();

  // Create executor
  const executor = new Executor({ db, accounts, logger });

  // Create MCP server
  const server = new McpServer(
    { name: 'agent-mail', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  // Determine agent ID (will be populated from client info)
  const agentId = 'unknown';

  // Register all tools
  for (const toolDef of ALL_TOOLS) {
    // Special handling for tools that read directly from the DB
    if (
      toolDef.name === 'get_pending_actions' ||
      toolDef.name === 'get_audit_log'
    ) {
      server.tool(
        toolDef.name,
        toolDef.description,
        toolDef.inputSchema.shape,
        async (params: Record<string, unknown>) => {
          const context = {
            accountId: '',
            agentId,
            db,
            accounts,
            logger,
          };
          const result = await toolDef.execute(params, context);
          return { content: result.content ?? [] };
        }
      );
      continue;
    }

    // Special handling for undo_intent
    if (toolDef.name === 'undo_intent') {
      server.tool(
        toolDef.name,
        toolDef.description,
        toolDef.inputSchema.shape,
        async (params: Record<string, unknown>) => {
          const intentId = params.intent_id as string;
          const result = await executor.undoIntent(intentId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          };
        }
      );
      continue;
    }

    // Standard tools go through the middleware
    const handler = wrapToolHandler(toolDef, {
      db,
      executor,
      policy,
      accounts,
      logger,
      agentId,
    });

    server.tool(
      toolDef.name,
      toolDef.description,
      toolDef.inputSchema.shape,
      async (params: Record<string, unknown>) => {
        return handler(params);
      }
    );
  }

  logger.info(
    `agent-mail MCP server initialized with ${accounts.length} account(s) and ${ALL_TOOLS.length} tools`
  );

  return server;
}
