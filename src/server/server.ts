import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { openDatabase, checkStuckExecuting } from '../ledger/db.js';
import { loadAccounts } from '../provider/accounts.js';
import { verifyKeychainAccess } from '../provider/keychain.js';
import { ImapConnectionPool } from '../provider/imap-pool.js';
import { loadPolicy } from '../policy/engine.js';
import { Executor } from '../executor/executor.js';
import { wrapToolHandler } from './middleware.js';
import { createLogger } from '../logger.js';
import { DEFAULT_REVIEWER_PORT } from '../config.js';
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
import { holdMessagesTool } from '../tools/hold-messages.js';
import { holdBySenderTool } from '../tools/hold-by-sender.js';
import { restoreMessagesTool } from '../tools/restore-messages.js';
import { undoIntentTool } from '../tools/undo-intent.js';
import { getOverviewTool, runGetOverview } from '../tools/get-overview.js';
import { listSendersTool } from '../tools/list-senders.js';
import { listMailboxesTool } from '../tools/list-mailboxes.js';
import { getIntentTool } from '../tools/get-intent.js';

import { runStartupMigrations } from './startup.js';
import type { ToolDefinition } from '../types.js';

const SERVER_PREAMBLE = `agent-mail design contract. This server is built so that no action it exposes can cause irreversible harm. Every mutation (hold, label, draft) is reversible for 30 days via \`undo_intent\` or \`restore_messages\`, and every action is recorded in \`get_audit_log\`. Sending email and permanent deletion are deliberately not exposed — those operations require a separate human-in-the-loop flow outside this server. Agents should treat this as a low-stakes environment: prefer acting and reconciling afterward over asking permission per action. Over-holding-then-restoring is a normal interaction pattern, not a failure mode.`;

export function buildServerOptions() {
  return {
    name: 'agent-mail',
    version: '0.1.0',
    instructions: SERVER_PREAMBLE,
  };
}

const ALL_TOOLS: ToolDefinition[] = [
  searchThreadsTool,
  readThreadTool,
  draftReplyTool,
  labelThreadTool,
  unsubscribeSenderTool,
  getPendingActionsTool,
  getAuditLogTool,
  queueSendTool,
  holdMessagesTool,
  holdBySenderTool,
  restoreMessagesTool,
  undoIntentTool,
  getOverviewTool,
  listSendersTool,
  listMailboxesTool,
  getIntentTool,
];

export interface McpServerBundle {
  server: McpServer;
  pool: ImapConnectionPool;
}

export interface CreateMcpServerOptions {
  reviewerPort?: number;
}

export async function createMcpServer(
  options: CreateMcpServerOptions = {}
): Promise<McpServerBundle> {
  const logger = createLogger('mcp');
  const reviewerPort = options.reviewerPort ?? DEFAULT_REVIEWER_PORT;

  // Verify Keychain access
  try {
    verifyKeychainAccess();
  } catch (error) {
    logger.error(
      `Keychain verification failed: ${error instanceof Error ? error.message : error}`
    );
    process.exit(1);
  }

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

  // Construct IMAP connection pool
  const pool = new ImapConnectionPool({ accounts, logger });

  // Run holding-folder migration for each account at startup
  try {
    const migrationResults = await runStartupMigrations({ pool, accounts });
    for (const [accountId, outcome] of Object.entries(migrationResults)) {
      logger.info(`holding-folder migration [${accountId}]: ${outcome.action}${'moved' in outcome ? ` (${outcome.moved} messages)` : ''}`);
    }
  } catch (err) {
    logger.warn(`holding-folder migration failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Create executor
  const executor = new Executor({ db, accounts, pool, logger });

  // Create MCP server
  const serverOptions = buildServerOptions();
  const server = new McpServer(
    serverOptions,
    { capabilities: { tools: {} } }
  );

  // Fallback until client metadata is available from the transport.
  const agentId = process.env.AGENT_MAIL_AGENT_ID ?? 'unknown';

  const validateParams = (
    toolDef: ToolDefinition,
    params: Record<string, unknown>
  ): Record<string, unknown> => {
    if (toolDef.validate) {
      return toolDef.validate(params);
    }
    return toolDef.inputSchema.parse(params);
  };

  // Register all tools
  for (const toolDef of ALL_TOOLS) {
    // get_overview runs directly against the pool (multi-account)
    if (toolDef.name === 'get_overview') {
      server.tool(
        toolDef.name,
        toolDef.description,
        toolDef.inputSchema.shape,
        async (params: Record<string, unknown>) => {
          try {
            const validated = validateParams(toolDef, params);
            const result = await runGetOverview({
              pool,
              accounts,
              input: validated as any,
            });
            return {
              content: [
                { type: 'text' as const, text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (error) {
            logger.error('get_overview failed', {
              error: error instanceof Error ? error.message : String(error),
            });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: true,
                    message: error instanceof Error ? error.message : String(error),
                  }),
                },
              ],
            };
          }
        }
      );
      continue;
    }

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
          const validated = validateParams(toolDef, params);
          const context = {
            accountId: '',
            agentId,
            db,
            accounts,
            logger,
          };
          const result = await toolDef.execute(validated, context);
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
          const validated = validateParams(toolDef, params);
          const intentId = validated.intent_id as string;
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
      reviewerPort,
    });

    server.tool(
      toolDef.name,
      toolDef.description,
      toolDef.inputSchema.shape,
      async (params: Record<string, unknown>) => {
        return handler(validateParams(toolDef, params));
      }
    );
  }

  logger.info(
    `agent-mail MCP server initialized with ${accounts.length} account(s) and ${ALL_TOOLS.length} tools`
  );

  return { server, pool };
}
