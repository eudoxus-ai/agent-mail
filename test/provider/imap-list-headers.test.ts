import { describe, it, expect } from 'vitest';
import { extractListHeadersFromSource } from '../../src/provider/imap.js';

const SRC_WITH_HEADERS = [
  'From: promo@sender.example',
  'Subject: Deal',
  'List-Id: Promotions <promos.sender.example>',
  'List-Unsubscribe: <mailto:u@sender.example>, <https://x/u>',
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
