import { describe, it, expect } from 'vitest';
import { extractSnippet } from '../../src/provider/mime.js';

const HTML_ONLY = [
  'Content-Type: text/html; charset=utf-8',
  '',
  '<html><body><p>Save <b>30%</b> today!</p><a href="x">Shop</a></body></html>',
].join('\r\n');

const MULTIPART_HTML_ONLY = [
  'Content-Type: multipart/alternative; boundary="B"',
  '',
  '--B',
  'Content-Type: text/html',
  '',
  '<p>Hello <b>Cameron</b>, your order shipped.</p>',
  '--B--',
].join('\r\n');

describe('extractSnippet HTML fallback', () => {
  it('returns decoded text for HTML-only messages', () => {
    expect(extractSnippet(HTML_ONLY)).toContain('Save 30% today');
  });

  it('falls back to text/html part when no text/plain alternative', () => {
    expect(extractSnippet(MULTIPART_HTML_ONLY)).toContain('Hello Cameron');
  });

  it('strips tags and collapses whitespace', () => {
    const s = extractSnippet(HTML_ONLY);
    expect(s).not.toMatch(/<[^>]+>/);
  });
});
