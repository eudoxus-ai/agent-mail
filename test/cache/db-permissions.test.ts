import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCache } from '../../src/cache/db.js';
import { upsertMessage } from '../../src/cache/store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-mail-perm-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cache file permissions', () => {
  it('creates cache.db 0600, not the umask default', () => {
    const path = join(dir, 'cache.db');
    openCache(path);

    // Full message bodies live here; the default 0644 would make them
    // world-readable if the parent directory were ever relaxed.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('restricts the WAL and SHM sidecars too', () => {
    const path = join(dir, 'cache.db');
    const db = openCache(path);

    upsertMessage(db, {
      accountId: 'work',
      uidvalidity: 1,
      message: {
        uid: 1,
        messageId: '<a@x>',
        from: { address: 'alice@example.com', name: null },
        to: [],
        cc: [],
        date: new Date().toISOString(),
        subject: 'Sensitive',
        bodyText: 'confidential body text',
        references: [],
        flags: [],
        mailbox: 'INBOX',
      },
    });

    // The WAL holds recently written pages — just as sensitive as the db.
    for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
      if (existsSync(sidecar)) {
        expect(statSync(sidecar).mode & 0o777).toBe(0o600);
      }
    }
  });

  it('does not choke on an in-memory database', () => {
    expect(() => openCache(':memory:')).not.toThrow();
  });
});
