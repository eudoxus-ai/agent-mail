export interface ParsedUnsubscribe {
  http_url?: string;
  mailto?: string;
  one_click: boolean;
  raw: string;
}

function decodeRfc2047(input: string): string {
  return input.replace(/=\?([^?]+)\?([QBqb])\?([^?]*)\?=/g, (_m, _charset, enc, payload) => {
    if (enc.toUpperCase() === 'Q') {
      return payload
        .replace(/_/g, ' ')
        .replace(/=([0-9A-Fa-f]{2})/g, (_x: string, h: string) => String.fromCharCode(parseInt(h, 16)));
    }
    try {
      return Buffer.from(payload, 'base64').toString('utf8');
    } catch {
      return payload;
    }
  });
}

export function parseListUnsubscribe(raw: string, postHeader?: string): ParsedUnsubscribe {
  const decoded = decodeRfc2047(raw);
  const uris = [...decoded.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  const http_url = uris.find((u) => /^https?:/i.test(u));
  const mailto = uris.find((u) => /^mailto:/i.test(u));
  const one_click = !!postHeader && /List-Unsubscribe=One-Click/i.test(postHeader);
  return { http_url, mailto, one_click, raw };
}
