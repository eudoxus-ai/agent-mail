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

describe('reviewer app', () => {
  it('requires auth for API reads and allows static shell access', async () => {
    const db = openDatabase(':memory:');
    const app = createReviewerApp({
      db,
      executor: {
        approveAndExecute: async () => {
          throw new Error('not used');
        },
        rejectIntent: async () => {
          throw new Error('not used');
        },
      } as any,
      logger: createLogger('cli', { minLevel: 'error' }),
      token: 'secret-token',
    });

    server = await new Promise<Server>((resolve) => {
      const started = app.listen(0, '127.0.0.1', () => resolve(started));
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve reviewer test server address');
    }

    const baseUrl = `http://127.0.0.1:${address.port}`;

    const shell = await fetch(baseUrl);
    expect(shell.status).toBe(200);

    const unauthenticated = await fetch(`${baseUrl}/api/pending`);
    expect(unauthenticated.status).toBe(401);

    const authenticated = await fetch(`${baseUrl}/api/pending`, {
      headers: { Authorization: 'Bearer secret-token' },
    });
    expect(authenticated.status).toBe(200);
  });
});
