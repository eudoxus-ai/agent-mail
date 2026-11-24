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

describe('extractSnippet reads the part in its own charset', () => {
  it('decodes UTF-8 quoted-printable as UTF-8, not one character per byte', () => {
    const source = msg(
      'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable',
      'I=E2=80=99m on my way =E2=80=94 see you soon'
    );
    expect(extractSnippet(source)).toBe('I’m on my way — see you soon');
  });

  it('decodes ISO-8859-1 quoted-printable', () => {
    const source = msg(
      'Content-Type: text/plain; charset="ISO-8859-1"\r\nContent-Transfer-Encoding: quoted-printable',
      'Caf=E9 cr=E8me, =E0 bient=F4t'
    );
    expect(extractSnippet(source)).toBe('Café crème, à bientôt');
  });

  it('decodes a raw 8bit UTF-8 body passed as bytes', () => {
    const source = msg(
      'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit',
      'Grüße aus München 🎉'
    );
    expect(extractSnippet(source)).toBe('Grüße aus München 🎉');
  });

  it('decodes a raw 8bit windows-1252 body passed as bytes', () => {
    const source = Buffer.concat([
      Buffer.from('Content-Type: text/plain; charset=windows-1252\r\n\r\n'),
      Buffer.from([0x93, 0x51, 0x75, 0x6f, 0x74, 0x65, 0x94, 0x20, 0x80, 0x35]),
    ]);
    expect(extractSnippet(source)).toBe('“Quote” €5');
  });

  it('decodes base64 UTF-8', () => {
    const source = msg(
      'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64',
      Buffer.from('Ça marche — merci', 'utf-8').toString('base64')
    );
    expect(extractSnippet(source)).toBe('Ça marche — merci');
  });

  it('uses the charset of the chosen part of a multipart message', () => {
    const source = Buffer.from(
      [
        'Content-Type: multipart/alternative; boundary="b"',
        '',
        '--b',
        'Content-Type: text/plain; charset=iso-8859-1',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        'R=E9sum=E9 attached',
        '--b',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>ignored</p>',
        '--b--',
      ].join('\r\n'),
      'utf-8'
    );
    expect(extractSnippet(source)).toBe('Résumé attached');
  });

  it('falls back to UTF-8 for a charset label it does not know', () => {
    const source = msg('Content-Type: text/plain; charset=x-made-up', 'naïve');
    expect(extractSnippet(source)).toBe('naïve');
  });

  it('decodes decimal and hex numeric entities in HTML, including astral ones', () => {
    const source = msg(
      'Content-Type: text/html; charset=utf-8',
      '<p>Party &#127881; tonight &#x2019;n&#X2019; more</p>'
    );
    expect(extractSnippet(source)).toBe('Party 🎉 tonight ’n’ more');
  });

  it('drops a character cut in half by the preview limit', () => {
    const full = Buffer.from('Content-Type: text/plain; charset=utf-8\r\n\r\nSee you at the café', 'utf-8');
    // é is two bytes; keep only the first.
    expect(extractSnippet(full.subarray(0, full.length - 1))).toBe('See you at the caf');
  });

  it('drops a quoted-printable escape cut short by the preview limit', () => {
    const source = msg(
      'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable',
      'Thanks =E2=80=94 I=E2=80=9'
    );
    expect(extractSnippet(source)).toBe('Thanks — I');
  });
});
