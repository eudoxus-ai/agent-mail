/**
 * Extract a short, readable snippet from a (possibly partial) message source.
 *
 * Handles text/plain root, multipart with text/plain first part, quoted-printable,
 * base64, and the part's declared charset, and strips quoted-reply tails and
 * signatures. Falls back to text/html parts when no text/plain alternative is
 * available. Returns empty string on any failure.
 *
 * A string source is taken to be text and encoded as UTF-8 first; a Buffer is
 * the message as the server sent it.
 *
 * Never throws.
 */
export function extractSnippet(source: Buffer | string, maxLength = 200): string {
  try {
    const bytes = typeof source === 'string' ? Buffer.from(source, 'utf-8') : source;
    // One latin1 character per byte. Headers are ASCII, and the body has to
    // stay undecoded until the chosen part's charset is known: decoding it as
    // UTF-8 here turns a windows-1252 body into replacement characters, and
    // decoding quoted-printable escapes as characters splits every multibyte
    // UTF-8 sequence into Latin-1 garbage.
    const entity = splitHeadersBody(bytes.toString('latin1'));
    if (!entity.body) return '';

    const part = chooseTextPart(entity);
    if (!part) return '';

    let text = decodePart(part);
    if (part.html) text = htmlToText(text);

    const cleaned = stripQuotedReply(stripSignature(text)).trim();
    if (!cleaned) return '';
    return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
  } catch {
    return '';
  }
}

export function splitHeadersBody(source: string): { headers: string; body: string } {
  const idx = source.search(/\r?\n\r?\n/);
  if (idx === -1) return { headers: source, body: '' };
  const sep = source[idx] === '\r' ? 4 : 2;
  return {
    headers: source.slice(0, idx),
    body: source.slice(idx + sep),
  };
}

/**
 * Read one header from a header block, joining folded continuation lines.
 * Long values (List-Unsubscribe, References, a multipart Content-Type) are
 * routinely folded, and the part after the fold is the part that matters: the
 * HTTPS unsubscribe URL, the parent Message-Id, the boundary.
 */
export function getHeader(headers: string, name: string): string | null {
  const regex = new RegExp(`^${name}:[ \\t]*(.*(?:\\r?\\n[ \\t].*)*)`, 'im');
  const match = headers.match(regex);
  if (!match) return null;
  return match[1].replace(/\r?\n[ \t]+/g, ' ').trim() || null;
}

function extractBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary="?([^";\s]+)"?/i);
  return match ? match[1] : null;
}

interface Entity {
  headers: string;
  body: string;
}

/** The part a snippet is read from: the first text/plain, else the first text/html. */
function chooseTextPart(entity: Entity): (Entity & { html: boolean }) | null {
  const contentType = getHeader(entity.headers, 'content-type') ?? 'text/plain';
  if (/^text\/plain/i.test(contentType)) return { ...entity, html: false };
  if (/^text\/html/i.test(contentType)) return { ...entity, html: true };
  if (!/^multipart\//i.test(contentType)) return null;

  const boundary = extractBoundary(contentType);
  if (!boundary) return null;
  const parts = entity.body
    .split(`--${boundary}`)
    .slice(1) // drop preamble
    .filter((part) => part.trim() !== '--' && part.trim() !== '')
    .map((part) => splitHeadersBody(part.replace(/^\r?\n/, '')));
  const typed = (pattern: RegExp) =>
    parts.find((part) => pattern.test(getHeader(part.headers, 'content-type') ?? ''));

  const plain = typed(/^text\/plain/i);
  if (plain) return { ...plain, html: false };
  const html = typed(/^text\/html/i);
  return html ? { ...html, html: true } : null;
}

/** Undo the transfer encoding, then read the bytes in the part's own charset. */
function decodePart(part: Entity): string {
  const encoding = getHeader(part.headers, 'content-transfer-encoding') ?? '7bit';
  const charset = getHeader(part.headers, 'content-type')?.match(/charset="?([^";\s]+)"?/i)?.[1];
  // The preview is cut at a byte count, so its last character can be
  // incomplete. That shows up as trailing replacement characters.
  return decodeCharset(transferDecode(part.body, encoding), charset).replace(/\uFFFD+$/, '');
}

/** `body` holds one latin1 character per byte, so latin1 turns it back into those bytes. */
function transferDecode(body: string, encoding: string): Buffer {
  switch (encoding.trim().toLowerCase()) {
    case 'quoted-printable':
      return Buffer.from(
        body
          .replace(/=\r?\n/g, '')
          // An escape cut short by the preview limit.
          .replace(/=[0-9A-Fa-f]?$/, '')
          .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))),
        'latin1'
      );
    case 'base64':
      return Buffer.from(body.replace(/\s+/g, ''), 'base64');
    default:
      // 7bit / 8bit / binary / unknown
      return Buffer.from(body, 'latin1');
  }
}

function decodeCharset(bytes: Buffer, charset: string | undefined): string {
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    // An unknown label gets the same reading as a part that names none.
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function stripQuotedReply(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;
    if (/^On .+ wrote:\s*$/.test(line)) break;
    out.push(line);
  }
  return out.join('\n');
}

function stripSignature(text: string): string {
  const match = text.match(/^-- \s*$/m);
  if (!match) return text;
  return text.slice(0, match.index ?? text.length);
}

// ─── Part-based snippet extraction ───────────────────────────────────────────
// Used by fetchSnippet to strip and truncate a fetched body part.

export interface SnippetSource { type: 'text/plain' | 'text/html'; content: string }

/**
 * Extract a ~500-char text preview from a pre-fetched body part.
 * Strips HTML tags/entities when type is text/html.
 * Returns '' for null/undefined input. Never throws.
 */
export function extractSnippetFromPart(src: SnippetSource | null | undefined): string {
  if (!src) return '';
  try {
    const text = src.type === 'text/html'
      ? src.content.replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/\s+/g, ' ')
          .trim()
      : src.content.replace(/\s+/g, ' ').trim();
    return text.slice(0, 500);
  } catch {
    return '';
  }
}

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (entity, code: string) => {
      const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : parseInt(code, 10);
      return point > 0 && point < 0x110000 ? String.fromCodePoint(point) : entity;
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}
