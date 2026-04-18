import { describe, it, expect } from 'vitest';
import { extractSnippetFromPart } from '../../src/provider/mime.js';

describe('extractSnippetFromPart', () => {
  it('returns first 500 chars of text/plain', () => {
    const plain = 'a'.repeat(600);
    expect(extractSnippetFromPart({ type: 'text/plain', content: plain })).toHaveLength(500);
  });

  it('strips tags from text/html', () => {
    expect(extractSnippetFromPart({ type: 'text/html', content: '<p>Hello <b>world</b></p>' })).toBe('Hello world');
  });

  it('strips style and script blocks from text/html', () => {
    const html = '<style>a{color:red}</style><script>x()</script><p>Hi</p>';
    expect(extractSnippetFromPart({ type: 'text/html', content: html })).toBe('Hi');
  });

  it('decodes common HTML entities', () => {
    const result = extractSnippetFromPart({ type: 'text/html', content: '<p>A &amp; B &nbsp; C</p>' });
    expect(result).toBe('A & B   C'.replace(/\s+/g, ' '));
  });

  it('returns empty string for null', () => {
    expect(extractSnippetFromPart(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(extractSnippetFromPart(undefined)).toBe('');
  });
});
