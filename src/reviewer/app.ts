import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from '../ledger/sqlite.js';
import type { Executor } from '../executor/executor.js';
import type { Logger } from '../logger.js';
import { loadReviewerToken, authMiddleware } from './auth.js';
import { createRouter } from './routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createReviewerApp(deps: {
  db: Database;
  executor: Executor;
  logger: Logger;
}): express.Application {
  const app = express();

  app.use(express.json());

  // Auth middleware
  const token = loadReviewerToken();
  app.use(authMiddleware(token));

  // API routes
  app.use(createRouter(deps));

  // Serve static files
  app.use(express.static(join(__dirname, 'static')));

  // Fallback to index.html for SPA
  app.get('/', (_req, res) => {
    res.sendFile(join(__dirname, 'static', 'index.html'));
  });

  // Error handler
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      deps.logger.error('Unhandled error', { error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  );

  return app;
}
