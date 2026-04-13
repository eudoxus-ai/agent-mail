/**
 * Extract a short, readable snippet from a (possibly partial) message source.
 *
 * Handles text/plain root, multipart with text/plain first part, quoted-printable,
 * and strips quoted-reply tails and signatures. Returns empty string on any failure
 * (including HTML-only messages — that is a documented MVP limitation).
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
    if (/^multipart\//i.test(contentType)) {
      const boundary = extractBoundary(contentType);
      if (!boundary) return '';
      const plainPart = findTextPlainPart(body, boundary);
      if (!plainPart) return '';
      rawBody = decodePart(plainPart);
    } else if (/^text\/plain/i.test(contentType)) {
      const encoding = getHeader(headers, 'content-transfer-encoding') ?? '7bit';
      rawBody = decodeEncoding(body, encoding);
    } else {
      // HTML-only or unknown — documented Y limitation
      return '';
    }

    const cleaned = stripQuotedReply(stripSignature(rawBody)).trim();
    if (!cleaned) return '';
    return cleaned.length > maxLength
      ? cleaned.slice(0, maxLength)
      : cleaned;
  } catch {
    return '';
  }
}

function splitHeadersBody(source: string): { headers: string; body: string } {
  const idx = source.search(/\r?\n\r?\n/);
  if (idx === -1) return { headers: source, body: '' };
  const sep = source[idx] === '\r' ? 4 : 2;
  return {
    headers: source.slice(0, idx),
    body: source.slice(idx + sep),
  };
}

function getHeader(headers: string, name: string): string | null {
  const regex = new RegExp(`^${name}:\\s*(.+?)(?:\\r?\\n(?!\\s)|$)`, 'im');
  const match = headers.match(regex);
  return match ? match[1].trim() : null;
}

function extractBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary="?([^";\s]+)"?/i);
  return match ? match[1] : null;
}

/** Given a multipart body and its boundary, return the raw text of the first text/plain part. */
function findTextPlainPart(body: string, boundary: string): string | null {
  const delimiter = `--${boundary}`;
  const parts = body.split(delimiter).slice(1); // drop preamble
  for (const part of parts) {
    if (part.trim() === '--' || part.trim() === '') continue;
    const trimmed = part.replace(/^\r?\n/, '');
    const { headers, body: partBody } = splitHeadersBody(trimmed);
    const partCt = getHeader(headers, 'content-type') ?? '';
    if (/^text\/plain/i.test(partCt)) {
      const enc = getHeader(headers, 'content-transfer-encoding') ?? '7bit';
      return decodeEncoding(partBody, enc);
    }
  }
  return null;
}

function decodePart(text: string): string {
  return text;
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
