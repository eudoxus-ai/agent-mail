import { describe, it, expect } from 'vitest';
import { extractListHeadersFromSource } from '../../src/provider/imap.js';
import { parseListUnsubscribe } from '../../src/lib/list-unsubscribe.js';

const SRC_WITH_HEADERS = [
  'From: promo@sender.example',
  'Subject: Deal',
  'List-Id: Promotions <promos.sender.example>',
  'List-Unsubscribe: <mailto:u@sender.example>, <https://x/u>',
  '',
  'body',
].join('\r\n');

const SRC_WITH_ONE_CLICK = [
  'From: promo@sender.example',
  'Subject: Deal',
  'List-Unsubscribe: <https://x/u>',
  'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
  '',
  'body',
].join('\r\n');

const SRC_WITHOUT = 'From: a@b\r\nSubject: hi\r\n\r\nbody';

describe('extractListHeadersFromSource', () => {
  it('returns both headers when present', () => {
    const r = extractListHeadersFromSource(SRC_WITH_HEADERS);
    expect(r.listId).toBe('Promotions <promos.sender.example>');
    expect(r.listUnsubscribe).toContain('mailto:u@sender.example');
  });

  it('returns nulls when headers are absent', () => {
    const r = extractListHeadersFromSource(SRC_WITHOUT);
    expect(r.listId).toBeNull();
    expect(r.listUnsubscribe).toBeNull();
  });
});

describe('envelope wiring: parseListUnsubscribe from extracted header', () => {
  it('produces structured ParsedUnsubscribe from raw extracted header', () => {
    const { listUnsubscribe } = extractListHeadersFromSource(SRC_WITH_HEADERS);
    expect(listUnsubscribe).not.toBeNull();
    const parsed = parseListUnsubscribe(listUnsubscribe!);
    expect(parsed.mailto).toBe('mailto:u@sender.example');
    expect(parsed.http_url).toBe('https://x/u');
    expect(parsed.one_click).toBe(false);
    expect(parsed.raw).toBe(listUnsubscribe);
  });

  it('sets one_click when List-Unsubscribe-Post header is present', () => {
    // Simulate what imap.ts does: extract both headers and parse together
    const rawUnsub = '<https://x/u>';
    const rawPost = 'List-Unsubscribe=One-Click';
    const parsed = parseListUnsubscribe(rawUnsub, rawPost);
    expect(parsed.one_click).toBe(true);
    expect(parsed.http_url).toBe('https://x/u');
  });
});
