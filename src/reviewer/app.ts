import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from '../ledger/sqlite.js';
import type { Executor } from '../executor/executor.js';
import type { Logger } from '../logger.js';
import { createRouter } from './routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Reject state-mutating requests whose Origin header is present but does not
// match localhost.  Browsers always send Origin on cross-origin requests and
// on same-origin POST/PUT/DELETE made via fetch, so this stops CSRF attempts
// from malicious pages without requiring a per-request token.
function csrfGuard(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    next();
    return;
  }
  const origin = req.headers.origin;
  if (
    origin !== undefined &&
    !origin.startsWith('http://127.0.0.1') &&
    !origin.startsWith('http://localhost')
  ) {
    res.status(403).json({ error: 'Cross-origin requests are not allowed' });
    return;
  }
  next();
}

export function createReviewerApp(deps: {
  db: Database;
  executor: Executor;
  logger: Logger;
}): express.Application {
  const app = express();

  app.use(express.json());

  app.use((_req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  // CSRF guard — reject mutations whose Origin is a non-localhost site
  app.use('/api', csrfGuard);

  // API routes — no auth (localhost-only)
  app.use('/api', createRouter(deps));

  // Serve static files
  app.use(express.static(join(__dirname, 'static')));

  // SPA fallback — serve index.html for all non-API, non-static paths
  app.get('*', (_req, res) => {
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
