import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { openDatabase, checkStuckExecuting } from '../ledger/db.js';
import { describeWorkerState } from '../ledger/worker-heartbeat.js';
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
import { getScanResultTool } from '../tools/get-scan-result.js';
import { ScanJobRunner, withTimeout } from '../executor/scan-jobs-runner.js';
import { getAttachmentTool } from '../tools/get-attachment.js';
import { getDiagnosticsTool } from '../tools/get-diagnostics.js';

import { runStartupMigrations, runStartupScanCleanup } from './startup.js';
import { openCache } from '../cache/db.js';
import { checkNodeRuntime } from '../lib/node-runtime.js';
import { loadCacheConfig } from '../cache/config.js';
import { existsSync } from 'node:fs';
import { CACHE_DB_PATH } from '../config.js';
import type { ToolDefinition } from '../types.js';

const SERVER_PREAMBLE = `agent-mail design contract. This server is built so that no action it exposes can cause irreversible harm. Every mutation (hold, label, draft) is reversible for 30 days via \`undo_intent\` or \`restore_messages\`, and every action is recorded in \`get_audit_log\`. Sending email and permanent deletion are deliberately not exposed — those operations require a separate human-in-the-loop flow outside this server. Agents should treat this as a low-stakes environment: prefer acting and reconciling afterward over asking permission per action. Over-holding-then-restoring is a normal interaction pattern, not a failure mode. Mutations are performed by a background daemon, so a tool may return an intent id with status \`queued\` before the work has happened — poll \`get_intent\` for the terminal status. If an action stays \`queued\`, call \`get_diagnostics\`: it reports whether the daemon is running and says how to start it. Queued work is durable and is never lost, so re-running an action that is merely slow will duplicate it.`;

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
  getAttachmentTool,
  getDiagnosticsTool,
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
  getScanResultTool,
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

  const runtime = checkNodeRuntime();
  if (runtime.warning) logger.warn(runtime.warning);

  // Open database
  const db = openDatabase();

  // Is anything going to perform what this server accepts?
  //
  // Logged at error, not warn: this server records mutations and hands back an
  // id, which looks identical whether or not a daemon exists to run them. If
  // nobody is draining the queue, every mutation this process accepts is a
  // promise it cannot keep, and that is not a warning-level fact.
  const workerState = describeWorkerState(db);
  if (!workerState.alive) {
    logger.error(workerState.warning!, {
      queued_count: workerState.queued_count,
      oldest_queued_age_seconds: workerState.oldest_queued_age_seconds,
    });
  }

  // Check for stuck executing intents (crash recovery)
  const stuck = checkStuckExecuting(db);
  if (stuck.length > 0) {
    logger.warn(
      `Found ${stuck.length} intent(s) stuck in 'executing' status (possible crash recovery).`,
      { intents: stuck.map((i) => ({ id: i.id, tool: i.tool })) }
    );
  }

  // Reap scan jobs orphaned in 'running' by a previous crash/restart.
  const reapedJobs = runStartupScanCleanup(db);
  if (reapedJobs > 0) {
    logger.warn(
      `Marked ${reapedJobs} orphaned scan job(s) as 'failed' (server restarted mid-scan).`
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

  // Open the local cache read-only. The daemon owns writes; MCP servers only
  // read. A missing or unreadable cache means reads go to IMAP as before.
  const cacheConfig = loadCacheConfig();
  let cache;
  if (cacheConfig.mode !== 'off' && existsSync(CACHE_DB_PATH)) {
    try {
      cache = openCache(CACHE_DB_PATH, { readOnly: true });
    } catch (error) {
      logger.warn(
        `Local cache unavailable, falling back to IMAP: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  // Create executor
  const executor = new Executor({ db, accounts, pool, logger, cache, cacheConfig });

  // Runner for async (background) scan jobs
  const scanRunner = new ScanJobRunner({ db, logger });

  // Read tools that support `async: true` — the scan work each runs.
  // get_overview uses runGetOverview directly; the other two reuse the
  // executor's no-intent read path. Returns the raw payload (byte-identical to
  // the synchronous result).
  const SCAN_TOOLS = new Set(['get_overview', 'list_senders', 'search_threads']);
  const runScan = (
    tool: string,
    validated: Record<string, unknown>
  ): Promise<unknown> => {
    if (tool === 'get_overview') {
      return runGetOverview({ pool, accounts, input: validated as any });
    }
    return executor.runRead(tool, validated);
  };

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
    // get_overview runs directly against the pool (multi-account). Both
    // list_senders and search_threads also support `async: true`; the async
    // branch below is shared. The synchronous get_overview path is guarded by
    // `withTimeout` so a heavy call fails fast advising `async: true` rather
    // than hanging.
    if (toolDef.name === 'get_overview') {
      server.tool(
        toolDef.name,
        toolDef.description,
        toolDef.inputSchema.shape,
        async (params: Record<string, unknown>) => {
          try {
            const validated = validateParams(toolDef, params);
            if (validated.async === true) {
              const handle = scanRunner.start(toolDef.name, validated, agentId, () =>
                runScan(toolDef.name, validated)
              );
              return {
                content: [
                  { type: 'text' as const, text: JSON.stringify(handle, null, 2) },
                ],
              };
            }
            const result = await withTimeout(
              runGetOverview({ pool, accounts, input: validated as any }),
              undefined,
              'get_overview'
            );
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

    // get_scan_result reads the scan_jobs ledger directly (like
    // get_pending_actions) — it never touches IMAP.
    if (toolDef.name === 'get_scan_result') {
      server.tool(
        toolDef.name,
        toolDef.description,
        toolDef.inputSchema.shape,
        async (params: Record<string, unknown>) => {
          const validated = validateParams(toolDef, params);
          const context = { accountId: '', agentId, db, accounts, logger };
          const result = await toolDef.execute(validated, context);
          return { content: result.content ?? [] };
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
        const validated = validateParams(toolDef, params);
        // list_senders / search_threads support `async: true`: register a
        // background scan job and return a pollable handle immediately instead
        // of routing through the synchronous executor path.
        if (SCAN_TOOLS.has(toolDef.name) && validated.async === true) {
          const handle = scanRunner.start(toolDef.name, validated, agentId, () =>
            runScan(toolDef.name, validated)
          );
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(handle, null, 2) },
            ],
          };
        }
        // Synchronous scan tools (list_senders / search_threads) get the same
        // fail-fast timeout guard as get_overview: a heavy sync read that
        // exceeds the timeout rejects fast advising `async: true` instead of
        // hanging the IMAP connection. Reads have no side effects, so a
        // discarded in-flight result is safe; a timed-out executeImmediate may
        // leave its intent in `executing`, which the boot `checkStuckExecuting`
        // reaper handles.
        if (SCAN_TOOLS.has(toolDef.name)) {
          return withTimeout(handler(validated), undefined, toolDef.name);
        }
        return handler(validated);
      }
    );
  }

  logger.info(
    `agent-mail MCP server initialized with ${accounts.length} account(s) and ${ALL_TOOLS.length} tools`
  );

  return { server, pool };
}
