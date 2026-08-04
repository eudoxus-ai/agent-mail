import { mkdirSync, writeFileSync, lstatSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ATTACHMENTS_DIR } from '../config.js';

/**
 * Staging area for on-demand attachment payloads.
 *
 * An attachment is attacker-controlled bytes that arrived from the network, and
 * the filename is attacker-controlled text. Everything here assumes both are
 * hostile. Same posture as provider/url-safety.ts.
 */

export const ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Windows reserved device names; harmless on macOS but free to exclude. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export class AttachmentTooLargeError extends Error {
  constructor(readonly size: number, readonly limit: number) {
    super(`Attachment is ${size} bytes, which exceeds the ${limit} byte limit`);
    this.name = 'AttachmentTooLargeError';
  }
}

/**
 * Reduce an attacker-controlled MIME filename to something safe to write.
 *
 * Path separators and traversal sequences are the attack: a filename of
 * `../../../../.ssh/authorized_keys` must not escape the staging directory.
 * basename() alone is insufficient because it doesn't handle backslashes on
 * POSIX, null bytes, or a name that reduces to empty.
 */
export function sanitizeFilename(raw: string | null | undefined, fallback: string): string {
  if (!raw) return fallback;

  // Strip null bytes first — they truncate paths in some syscalls.
  let name = raw.replace(/\0/g, '');

  // Normalize Windows separators before basename so "a\\..\\b" can't survive.
  name = name.replace(/\\/g, '/');
  name = basename(name);

  // basename('..') is '..'; basename('.') is '.'. Neither is a filename.
  name = name.replace(/^\.+/, '');

  // Control characters and shell-hostile punctuation.
  name = name.replace(/[\x00-\x1f\x7f]/g, '');
  name = name.replace(/^[-\s]+/, '').trim();

  if (RESERVED.test(name)) name = `_${name}`;

  // Leave room for the extension while bounding total length.
  if (name.length > 200) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = name.slice(0, 200 - ext.length) + ext;
  }

  return name.length > 0 ? name : fallback;
}

export interface StagedAttachment {
  path: string;
  filename: string;
  size: number;
  expiresAt: Date;
}

export interface StageOptions {
  filename: string | null;
  partId: string;
  content: Buffer;
  maxBytes: number;
  now?: number;
  baseDir?: string;
}

/**
 * Write an attachment into an isolated directory and return its path.
 *
 * Each call gets a fresh random subdirectory: two fetches of `invoice.pdf`
 * never collide, and one message's attachment can never overwrite another's.
 */
export function stageAttachment(options: StageOptions): StagedAttachment {
  const now = options.now ?? Date.now();
  const baseDir = options.baseDir ?? ATTACHMENTS_DIR;

  if (options.content.byteLength > options.maxBytes) {
    throw new AttachmentTooLargeError(options.content.byteLength, options.maxBytes);
  }

  const filename = sanitizeFilename(options.filename, `attachment-${options.partId}`);

  const day = new Date(now).toISOString().slice(0, 10);
  const dir = join(baseDir, day, randomBytes(12).toString('hex'));
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const path = join(dir, filename);

  // The directory is freshly created with a random name, so nothing should
  // exist at this path. If something does, it's a symlink plant or a
  // sanitization failure — refuse rather than follow it.
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Refusing to write attachment over a non-regular file');
    }
  }

  // 0600 and never executable, whatever the MIME type claims.
  writeFileSync(path, options.content, { mode: 0o600 });

  return {
    path,
    filename,
    size: options.content.byteLength,
    expiresAt: new Date(now + ATTACHMENT_TTL_MS),
  };
}

/**
 * Delete staged attachments past their TTL. Run by the daemon — the staging
 * area is a staging area, not an archive.
 */
export function gcAttachments(options: { now?: number; baseDir?: string } = {}): number {
  const now = options.now ?? Date.now();
  const baseDir = options.baseDir ?? ATTACHMENTS_DIR;
  if (!existsSync(baseDir)) return 0;

  let removed = 0;
  for (const day of readdirSync(baseDir)) {
    const dayMs = Date.parse(`${day}T00:00:00Z`);
    if (Number.isNaN(dayMs)) continue;
    if (now - dayMs <= ATTACHMENT_TTL_MS) continue;

    rmSync(join(baseDir, day), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
