/**
 * Extract a short, readable snippet from a (possibly partial) message source.
 *
 * Handles text/plain root, multipart with text/plain first part, quoted-printable,
 * and strips quoted-reply tails and signatures. Falls back to text/html parts
 * when no text/plain alternative is available. Returns empty string on any failure.
 *
 * Never throws.
 */
export function extractSnippet(source: Buffer | string, maxLength = 200): string {
  try {
    const text = typeof source === 'string' ? source : source.toString('utf-8');

    const { headers, body } = splitHeadersBody(text);
    if (!body) return '';

    const contentType = getHeader(headers, 'content-type') ?? 'text/plain';

    let rawBody: string;
    let isHtml = false;
    if (/^multipart\//i.test(contentType)) {
      const boundary = extractBoundary(contentType);
      if (!boundary) return '';
      const plain = findTextPart(body, boundary, /^text\/plain/i);
      if (plain) {
        rawBody = plain;
      } else {
        const html = findTextPart(body, boundary, /^text\/html/i);
        if (!html) return '';
        rawBody = html;
        isHtml = true;
      }
    } else if (/^text\/plain/i.test(contentType)) {
      const encoding = getHeader(headers, 'content-transfer-encoding') ?? '7bit';
      rawBody = decodeEncoding(body, encoding);
    } else if (/^text\/html/i.test(contentType)) {
      const encoding = getHeader(headers, 'content-transfer-encoding') ?? '7bit';
      rawBody = decodeEncoding(body, encoding);
      isHtml = true;
    } else {
      return '';
    }

    if (isHtml) rawBody = htmlToText(rawBody);

    const cleaned = stripQuotedReply(stripSignature(rawBody)).trim();
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

/** Given a multipart body, its boundary, and a content-type regex, return the decoded text of the first matching part. */
function findTextPart(body: string, boundary: string, ctRegex: RegExp): string | null {
  const delimiter = `--${boundary}`;
  const parts = body.split(delimiter).slice(1); // drop preamble
  for (const part of parts) {
    if (part.trim() === '--' || part.trim() === '') continue;
    const trimmed = part.replace(/^\r?\n/, '');
    const { headers, body: partBody } = splitHeadersBody(trimmed);
    const partCt = getHeader(headers, 'content-type') ?? '';
    if (ctRegex.test(partCt)) {
      const enc = getHeader(headers, 'content-transfer-encoding') ?? '7bit';
      return decodeEncoding(partBody, enc);
    }
  }
  return null;
}

function decodeEncoding(body: string, encoding: string): string {
  const enc = encoding.trim().toLowerCase();
  if (enc === 'quoted-printable') {
    return body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16))
      );
  }
  if (enc === 'base64') {
    try {
      return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf-8');
    } catch {
      return '';
    }
  }
  // 7bit / 8bit / binary / unknown → pass through
  return body;
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
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}
