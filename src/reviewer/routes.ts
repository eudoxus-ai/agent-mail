import { Router } from 'express';
import type { Database } from '../ledger/sqlite.js';
import type { Executor } from '../executor/executor.js';
import type { Logger } from '../logger.js';
import { getPendingIntents, getIntent } from '../ledger/intents.js';
import { getAuditLog } from '../ledger/audit.js';
import { checkStuckExecuting, rowToIntent } from '../ledger/db.js';
import { loadAccounts } from '../provider/accounts.js';

export interface RouterDeps {
  db: Database;
  executor: Executor;
  logger: Logger;
}

export function createRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/pending', (req, res) => {
    const accountId = req.query.account_id as string | undefined;
    const pending = getPendingIntents(deps.db, accountId ? [accountId] : undefined);
    res.json(pending);
  });

  router.get('/audit', (req, res) => {
    const accountId = req.query.account_id as string | undefined;
    const entries = getAuditLog(deps.db, {
      account_ids: accountId ? [accountId] : undefined,
      limit: parseInt(req.query.limit as string, 10) || 50,
      offset: parseInt(req.query.offset as string, 10) || 0,
    });
    res.json(entries);
  });

  router.get('/intent/:id', (req, res) => {
    const intent = getIntent(deps.db, req.params.id);
    if (!intent) {
      res.status(404).json({ error: 'Intent not found' });
      return;
    }
    res.json(intent);
  });

  router.post('/intent/:id/approve', async (req, res) => {
    try {
      const editedParams = req.body?.params as Record<string, unknown> | undefined;
      const intent = await deps.executor.approveAndExecute(req.params.id, editedParams);
      res.json(intent);
    } catch (error) {
      deps.logger.error('Approve failed', {
        id: req.params.id,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.post('/intent/:id/reject', async (req, res) => {
    try {
      const reason = req.body?.reason as string | undefined;
      const intent = await deps.executor.rejectIntent(req.params.id, reason);
      res.json(intent);
    } catch (error) {
      deps.logger.error('Reject failed', {
        id: req.params.id,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.get('/accounts', (_req, res) => {
    try {
      const accounts = loadAccounts();
      res.json(
        accounts.map((a) => ({ id: a.id, email: a.email }))
      );
    } catch {
      res.json([]);
    }
  });

  router.get('/stuck', (_req, res) => {
    const stuck = checkStuckExecuting(deps.db);
    res.json(stuck);
  });

  router.get('/quarantine', (_req, res) => {
    // Exclude dry-run previews — they have status 'executed' but moved no
    // mail and intentionally have no undo token, so showing them in the
    // quarantine tab would offer a broken Undo action.
    const quarantined = deps.db.prepare(`
      SELECT * FROM intents
      WHERE tool IN ('hold_messages', 'hold_by_sender')
        AND status = 'executed'
        AND COALESCE(json_extract(params, '$.dry_run'), 0) = 0
        AND id NOT IN (
          SELECT intent_id FROM audit_log WHERE action = 'undone'
        )
      ORDER BY created_at DESC
    `).all() as Array<Record<string, unknown>>;

    res.json(quarantined.map(rowToIntent));
  });

  router.post('/intent/:id/undo', async (req, res) => {
    try {
      const result = await deps.executor.undoIntent(req.params.id);
      res.json(result);
    } catch (error) {
      deps.logger.error('Undo failed', {
        id: req.params.id,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
