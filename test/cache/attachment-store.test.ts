import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, sep } from 'node:path';
import {
  sanitizeFilename,
  stageAttachment,
  gcAttachments,
  AttachmentTooLargeError,
  ATTACHMENT_TTL_MS,
} from '../../src/cache/attachment-store.js';

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'agent-mail-attach-'));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('sanitizeFilename', () => {
  it('keeps an ordinary filename', () => {
    expect(sanitizeFilename('q2-pricing.pdf', 'fallback')).toBe('q2-pricing.pdf');
  });

  // The filename comes from the MIME headers of a message anyone can send.
  const traversals: Array<[string, string]> = [
    ['posix traversal', '../../../../etc/passwd'],
    ['windows traversal', '..\\..\\..\\Windows\\System32\\config'],
    ['absolute path', '/etc/passwd'],
    ['mixed separators', 'a/../../b/../../../etc/shadow'],
    ['home-relative', '~/.ssh/authorized_keys'],
  ];

  for (const [label, input] of traversals) {
    it(`neutralizes ${label}`, () => {
      const out = sanitizeFilename(input, 'fallback');
      expect(out).not.toContain('/');
      expect(out).not.toContain('\\');
      expect(out).not.toBe('..');
      expect(out.startsWith('.')).toBe(false);
    });
  }

  it('strips null bytes', () => {
    expect(sanitizeFilename('evil\0.pdf', 'fallback')).not.toContain('\0');
  });

  it('strips control characters', () => {
    expect(sanitizeFilename('report.pdf', 'fallback')).toBe('report.pdf');
  });

  it('falls back when the name reduces to nothing', () => {
    expect(sanitizeFilename('..', 'attachment-2')).toBe('attachment-2');
    expect(sanitizeFilename('...', 'attachment-2')).toBe('attachment-2');
    expect(sanitizeFilename('/', 'attachment-2')).toBe('attachment-2');
    expect(sanitizeFilename('', 'attachment-2')).toBe('attachment-2');
    expect(sanitizeFilename(null, 'attachment-2')).toBe('attachment-2');
  });

  it('does not produce a hidden dotfile', () => {
    expect(sanitizeFilename('.bashrc', 'fallback')).toBe('bashrc');
  });

  it('bounds absurdly long names while keeping the extension', () => {
    const out = sanitizeFilename(`${'x'.repeat(500)}.pdf`, 'fallback');
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith('.pdf')).toBe(true);
  });

  it('defuses Windows reserved device names', () => {
    expect(sanitizeFilename('con', 'fallback')).toBe('_con');
    expect(sanitizeFilename('LPT1.txt', 'fallback')).toBe('_LPT1.txt');
  });
});

describe('stageAttachment', () => {
  const content = Buffer.from('%PDF-1.4 fake');

  it('writes the payload and returns its path', () => {
    const staged = stageAttachment({
      filename: 'deck.pdf',
      partId: '2',
      content,
      maxBytes: 1024,
      baseDir,
    });

    expect(existsSync(staged.path)).toBe(true);
    expect(readFileSync(staged.path)).toEqual(content);
    expect(staged.filename).toBe('deck.pdf');
    expect(staged.size).toBe(content.byteLength);
  });

  it('writes 0600 and never executable', () => {
    const staged = stageAttachment({
      filename: 'evil.sh',
      partId: '2',
      content,
      maxBytes: 1024,
      baseDir,
    });

    const mode = statSync(staged.path).mode & 0o777;
    expect(mode).toBe(0o600);
    // No execute bit for anyone, whatever the extension or MIME type claims.
    expect(mode & 0o111).toBe(0);
  });

  it('confines the write to the staging directory even under traversal', () => {
    const staged = stageAttachment({
      filename: '../../../../tmp/pwned.txt',
      partId: '2',
      content,
      maxBytes: 1024,
      baseDir,
    });

    expect(resolve(staged.path).startsWith(resolve(baseDir) + sep)).toBe(true);
    expect(staged.filename).toBe('pwned.txt');
  });

  it('isolates each fetch so identical filenames never collide', () => {
    const a = stageAttachment({
      filename: 'invoice.pdf',
      partId: '2',
      content: Buffer.from('first'),
      maxBytes: 1024,
      baseDir,
    });
    const b = stageAttachment({
      filename: 'invoice.pdf',
      partId: '2',
      content: Buffer.from('second'),
      maxBytes: 1024,
      baseDir,
    });

    expect(a.path).not.toBe(b.path);
    expect(readFileSync(a.path).toString()).toBe('first');
    expect(readFileSync(b.path).toString()).toBe('second');
  });

  it('refuses a payload over the limit', () => {
    expect(() =>
      stageAttachment({
        filename: 'big.bin',
        partId: '2',
        content: Buffer.alloc(2048),
        maxBytes: 1024,
        baseDir,
      })
    ).toThrow(AttachmentTooLargeError);
  });

  it('creates the staging directory 0700', () => {
    const staged = stageAttachment({
      filename: 'a.txt',
      partId: '2',
      content,
      maxBytes: 1024,
      baseDir,
    });
    expect(statSync(dirname(staged.path)).mode & 0o777).toBe(0o700);
  });

  it('reports a TTL 7 days out', () => {
    const now = Date.UTC(2026, 6, 31);
    const staged = stageAttachment({
      filename: 'a.txt',
      partId: '2',
      content,
      maxBytes: 1024,
      baseDir,
      now,
    });
    expect(staged.expiresAt.getTime()).toBe(now + ATTACHMENT_TTL_MS);
  });
});

describe('gcAttachments', () => {
  it('removes staged directories past the TTL and keeps recent ones', () => {
    const now = Date.UTC(2026, 6, 31);
    mkdirSync(join(baseDir, '2026-06-01', 'aaa'), { recursive: true });
    mkdirSync(join(baseDir, '2026-07-30', 'bbb'), { recursive: true });

    const removed = gcAttachments({ now, baseDir });

    expect(removed).toBe(1);
    expect(existsSync(join(baseDir, '2026-06-01'))).toBe(false);
    expect(existsSync(join(baseDir, '2026-07-30'))).toBe(true);
  });

  it('ignores directories that are not dates', () => {
    mkdirSync(join(baseDir, 'not-a-date'), { recursive: true });
    expect(gcAttachments({ now: Date.UTC(2026, 6, 31), baseDir })).toBe(0);
    expect(existsSync(join(baseDir, 'not-a-date'))).toBe(true);
  });

  it('is a no-op when the staging directory does not exist', () => {
    expect(gcAttachments({ baseDir: join(baseDir, 'missing') })).toBe(0);
  });
});
