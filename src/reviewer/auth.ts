import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { Request, Response, NextFunction } from 'express';
import { REVIEWER_TOKEN_PATH } from '../config.js';

export function generateReviewerToken(): string {
  const token = randomBytes(32).toString('hex');
  writeFileSync(REVIEWER_TOKEN_PATH, token, { mode: 0o600 });
  return token;
}

export function loadReviewerToken(): string {
  if (!existsSync(REVIEWER_TOKEN_PATH)) {
    return generateReviewerToken();
  }
  return readFileSync(REVIEWER_TOKEN_PATH, 'utf-8').trim();
}

export function authMiddleware(
  token: string
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    // GET requests are read-only, no auth required
    if (req.method === 'GET') {
      next();
      return;
    }

    // POST/PUT/DELETE require bearer token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }

    const provided = authHeader.slice(7);
    if (provided !== token) {
      res.status(403).json({ error: 'Invalid token' });
      return;
    }

    next();
  };
}
