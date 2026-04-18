import { describe, it, expect } from 'vitest';
import { parseListUnsubscribe } from '../../src/lib/list-unsubscribe.js';

describe('parseListUnsubscribe', () => {
  it('decodes RFC 2047 quoted-printable wrapper', () => {
    const raw = '=?us-ascii?Q?<https://example.com/u=3Fid=3D42>,_<mailto:u@example.com>?=';
    const r = parseListUnsubscribe(raw);
    expect(r.http_url).toBe('https://example.com/u?id=42');
    expect(r.mailto).toBe('mailto:u@example.com');
    expect(r.raw).toBe(raw);
  });

  it('parses bare RFC 2369 header', () => {
    const r = parseListUnsubscribe('<https://x.com/u>, <mailto:a@x.com>');
    expect(r.http_url).toBe('https://x.com/u');
    expect(r.mailto).toBe('mailto:a@x.com');
    expect(r.one_click).toBe(false);
  });

  it('detects RFC 8058 one-click via post header', () => {
    const r = parseListUnsubscribe('<https://x.com/u>', 'List-Unsubscribe=One-Click');
    expect(r.one_click).toBe(true);
  });

  it('returns raw with no fields when unparseable', () => {
    const raw = 'garbage not a header';
    const r = parseListUnsubscribe(raw);
    expect(r.raw).toBe(raw);
    expect(r.http_url).toBeUndefined();
    expect(r.mailto).toBeUndefined();
    expect(r.one_click).toBe(false);
  });

  it('http_url-only header', () => {
    const r = parseListUnsubscribe('<https://only-http.example/u>');
    expect(r.http_url).toBe('https://only-http.example/u');
    expect(r.mailto).toBeUndefined();
  });

  it('mailto-only header', () => {
    const r = parseListUnsubscribe('<mailto:only-mail@example.com>');
    expect(r.mailto).toBe('mailto:only-mail@example.com');
    expect(r.http_url).toBeUndefined();
  });
});
