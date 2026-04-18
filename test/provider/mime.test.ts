import { describe, it, expect } from 'vitest';
import { extractSnippet } from '../../src/provider/mime.js';

function msg(headers: string, body: string): Buffer {
  return Buffer.from(`${headers}\r\n\r\n${body}`, 'utf-8');
}

describe('extractSnippet', () => {
  it('extracts plain text body at root', () => {
    const source = msg(
      'Content-Type: text/plain; charset=utf-8',
      'Hello world, this is the message body.'
    );
    expect(extractSnippet(source)).toBe('Hello world, this is the message body.');
  });

  it('strips quoted-reply tails', () => {
    const source = msg(
      'Content-Type: text/plain; charset=utf-8',
      'Thanks for sending that over.\r\n\r\nOn Mon, someone wrote:\r\n> previous text\r\n> more previous text'
    );
    expect(extractSnippet(source)).toBe('Thanks for sending that over.');
  });

  it('strips signatures after "-- "', () => {
    const source = msg(
      'Content-Type: text/plain; charset=utf-8',
      'The actual message.\r\n-- \r\nJane Doe\r\nSoftware Engineer'
    );
    expect(extractSnippet(source)).toBe('The actual message.');
  });

  it('decodes quoted-printable', () => {
    const source = msg(
      'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable',
      'Hello =3D world'
    );
    expect(extractSnippet(source)).toBe('Hello = world');
  });

  it('prefers text/plain part in multipart', () => {
    const source = Buffer.from(
      [
        'Content-Type: multipart/alternative; boundary="BOUNDARY"',
        '',
        '--BOUNDARY',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Plain text version of the message.',
        '--BOUNDARY',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>HTML version of the message.</p>',
        '--BOUNDARY--',
      ].join('\r\n'),
      'utf-8'
    );
    expect(extractSnippet(source)).toBe('Plain text version of the message.');
  });

  it('extracts text from HTML-only messages via htmlToText fallback', () => {
    const source = msg(
      'Content-Type: text/html; charset=utf-8',
      '<p>Hello</p>'
    );
    expect(extractSnippet(source)).toContain('Hello');
  });

  it('returns empty string on malformed input instead of throwing', () => {
    expect(() => extractSnippet(Buffer.from('garbage', 'utf-8'))).not.toThrow();
    expect(extractSnippet(Buffer.from('garbage', 'utf-8'))).toBe('');
  });

  it('truncates long bodies to ~200 chars', () => {
    const body = 'a'.repeat(500);
    const source = msg('Content-Type: text/plain; charset=utf-8', body);
    const snippet = extractSnippet(source);
    expect(snippet).toBe('a'.repeat(200));
  });

  it('accepts string input as well as Buffer', () => {
    const source = 'Content-Type: text/plain; charset=utf-8\r\n\r\nString input works.';
    expect(extractSnippet(source)).toBe('String input works.');
  });
});
