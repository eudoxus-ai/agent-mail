import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCache, type Database } from '../../src/cache/db.js';
import { repairLatin1Mojibake, runCacheMigrations } from '../../src/cache/migrations.js';
import { upsertMessage } from '../../src/cache/store.js';
import { searchCache } from '../../src/cache/query.js';
import type { EmailMessage } from '../../src/types.js';

/** What the old preview decoder stored: UTF-8 bytes read one per character as Latin-1. */
function garble(text: string): string {
  return Buffer.from(text, 'utf-8').toString('latin1');
}

describe('repairLatin1Mojibake', () => {
  it('restores UTF-8 text that was read as Latin-1', () => {
    expect(garble('I’m on my way — 🎉')).toBe('Iâ\u0080\u0099m on my way â\u0080\u0094 ð\u009f\u008e\u0089');
    expect(repairLatin1Mojibake(garble('I’m on my way — 🎉'))).toBe('I’m on my way — 🎉');
  });

  it('restores a snippet whose last character was cut mid-sequence', () => {
    const cut = garble('See you — soon’').slice(0, -2);
    expect(repairLatin1Mojibake(cut)).toBe('See you — soon');
  });

  it('leaves real Latin-1 text alone', () => {
    expect(repairLatin1Mojibake('Café crème, à bientôt, 25°C ±2')).toBeNull();
  });

  it('leaves text that is already correct alone', () => {
    expect(repairLatin1Mojibake('I’m fine')).toBeNull();
    expect(repairLatin1Mojibake('plain ascii')).toBeNull();
  });

  it('gives up when the bytes are not valid UTF-8', () => {
    // A lead byte followed by a continuation byte, then a stray lead byte.
    expect(repairLatin1Mojibake('Ã© and Ã then text')).toBeNull();
  });

  it('does not change its own output', () => {
    const repaired = repairLatin1Mojibake(garble('naïve café — “quoted”'))!;
    expect(repaired).toBe('naïve café — “quoted”');
    expect(repairLatin1Mojibake(repaired)).toBeNull();
  });
});

describe('snippet repair migration', () => {
  function message(uid: number): EmailMessage {
    return {
      uid,
      messageId: `<m${uid}@x>`,
      from: { address: 'alice@example.com', name: null },
      to: [],
      cc: [],
      date: new Date(Date.UTC(2026, 5, uid)).toISOString(),
      subject: `Subject ${uid}`,
      bodyText: '',
      references: [],
      flags: [],
      mailbox: 'INBOX',
    };
  }

  function seed(db: Database, snippets: Record<number, string>) {
    for (const [uid, snippet] of Object.entries(snippets)) {
      upsertMessage(db, { accountId: 'work', message: message(Number(uid)), uidvalidity: 1, snippet });
    }
  }

  function snippets(db: Database): Record<number, string> {
    const rows = searchCache(db, { mailboxes: [{ account_id: 'work', mailbox: 'INBOX' }], limit: 10 });
    return Object.fromEntries(rows.map((r) => [r.uid, r.snippet]));
  }

  function unmigrated(): Database {
    const db = openCache(':memory:');
    db.exec('PRAGMA user_version = 0');
    return db;
  }

  it('repairs garbled snippets and leaves clean ones untouched', () => {
    const db = unmigrated();
    seed(db, {
      1: garble('I’m running late'),
      2: 'Café crème à bientôt',
      3: 'Already fine ’',
    });

    runCacheMigrations(db);

    expect(snippets(db)).toEqual({
      1: 'I’m running late',
      2: 'Café crème à bientôt',
      3: 'Already fine ’',
    });
  });

  it('runs once', () => {
    const db = unmigrated();
    seed(db, { 1: garble('first pass’') });
    runCacheMigrations(db);

    // Anything that looks garbled after the repair ran was written by the
    // fixed decoder, so a second run must not touch it.
    seed(db, { 2: garble('later row’') });
    runCacheMigrations(db);

    expect(snippets(db)).toEqual({ 1: 'first pass’', 2: garble('later row’') });
  });

  it('is safe on an empty cache', () => {
    const db = unmigrated();
    expect(() => runCacheMigrations(db)).not.toThrow();
    expect(snippets(db)).toEqual({});
  });

  it('runs when the daemon opens a cache written before the fix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-mail-repair-'));
    try {
      const path = join(dir, 'cache.db');
      const before = openCache(path);
      seed(before, { 1: garble('Here’s the plan') });
      before.exec('PRAGMA user_version = 0');
      before.close();

      const after = openCache(path);
      expect(snippets(after)).toEqual({ 1: 'Here’s the plan' });
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
