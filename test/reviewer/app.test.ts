import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { openDatabase } from '../../src/ledger/db.js';
import { createReviewerApp } from '../../src/reviewer/app.js';
import { createLogger } from '../../src/logger.js';

let server: Server | null = null;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    server = null;
  }
});

function makeApp() {
  const db = openDatabase(':memory:');
  return createReviewerApp({
    db,
    executor: {
      approveAndExecute: async () => { throw new Error('not used'); },
      rejectIntent: async () => { throw new Error('not used'); },
    } as any,
    logger: createLogger('cli', { minLevel: 'error' }),
  });
}

async function startServer(app: ReturnType<typeof createReviewerApp>): Promise<{ server: Server; baseUrl: string }> {
  const srv = await new Promise<Server>((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  server = srv;
  const address = srv.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve reviewer test server address');
  }
  return { server: srv, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe('reviewer app', () => {
  it('allows unauthenticated access to all API routes', async () => {
    const { baseUrl } = await startServer(makeApp());

    const shell = await fetch(baseUrl);
    expect(shell.status).toBe(200);

    const pending = await fetch(`${baseUrl}/api/pending`);
    expect(pending.status).toBe(200);
  });

  it('CSRF guard: allows POST from same-origin (localhost Origin)', async () => {
    const { baseUrl } = await startServer(makeApp());

    const res = await fetch(`${baseUrl}/api/intent/nonexistent/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl },
      body: JSON.stringify({ reason: 'test' }),
    });
    // 400 = executor threw (intent not found), not 403 = CSRF blocked
    expect(res.status).toBe(400);
  });

  it('CSRF guard: blocks POST from a cross-origin page', async () => {
    const { baseUrl } = await startServer(makeApp());

    const res = await fetch(`${baseUrl}/api/intent/nonexistent/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
      body: JSON.stringify({ reason: 'test' }),
    });
    expect(res.status).toBe(403);
  });
});
