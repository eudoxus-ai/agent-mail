import { describe, it, expect } from 'vitest';
import { collectAttachments, collectTextParts } from '../../src/provider/imap.js';

/**
 * BODYSTRUCTURE shapes as imapflow reports them. These drive design D1: text
 * parts get cached, attachment payloads never do — only their metadata.
 */

const simpleText = { type: 'text/plain', parameters: { charset: 'utf-8' } };

const alternative = {
  type: 'multipart/alternative',
  childNodes: [
    { type: 'text/plain', part: '1', parameters: { charset: 'utf-8' } },
    { type: 'text/html', part: '2', parameters: { charset: 'utf-8' } },
  ],
};

const withPdf = {
  type: 'multipart/mixed',
  childNodes: [
    {
      type: 'multipart/alternative',
      part: '1',
      childNodes: [
        { type: 'text/plain', part: '1.1', parameters: { charset: 'utf-8' } },
        { type: 'text/html', part: '1.2' },
      ],
    },
    {
      type: 'application/pdf',
      part: '2',
      disposition: 'attachment',
      dispositionParameters: { filename: 'q2-pricing.pdf' },
      size: 184320,
    },
  ],
};

describe('collectTextParts', () => {
  it('finds both text parts in a multipart/alternative', () => {
    expect(collectTextParts(alternative)).toEqual({
      plain: '1',
      html: '2',
      charset: 'utf-8',
    });
  });

  it('falls back to part 1 for a single-part text message', () => {
    expect(collectTextParts(simpleText)).toEqual({
      plain: '1',
      html: null,
      charset: 'utf-8',
    });
  });

  it('descends into nested multiparts', () => {
    expect(collectTextParts(withPdf)).toMatchObject({ plain: '1.1', html: '1.2' });
  });

  it('ignores a text part dispositioned as an attachment', () => {
    const structure = {
      type: 'multipart/mixed',
      childNodes: [
        { type: 'text/plain', part: '1' },
        {
          type: 'text/plain',
          part: '2',
          disposition: 'attachment',
          dispositionParameters: { filename: 'notes.txt' },
        },
      ],
    };
    // The .txt someone sent is not the message body.
    expect(collectTextParts(structure).plain).toBe('1');
  });

  it('returns nulls for a message with no text parts', () => {
    const structure = {
      type: 'multipart/mixed',
      childNodes: [{ type: 'image/png', part: '1' }],
    };
    expect(collectTextParts(structure)).toEqual({
      plain: null,
      html: null,
      charset: null,
    });
  });

  it('tolerates null and malformed structures', () => {
    expect(collectTextParts(null)).toEqual({ plain: null, html: null, charset: null });
    expect(collectTextParts(undefined)).toEqual({
      plain: null,
      html: null,
      charset: null,
    });
    expect(collectTextParts('garbage')).toEqual({
      plain: null,
      html: null,
      charset: null,
    });
  });
});

describe('collectAttachments', () => {
  it('records metadata without any payload', () => {
    expect(collectAttachments(withPdf)).toEqual([
      {
        part_id: '2',
        filename: 'q2-pricing.pdf',
        mime_type: 'application/pdf',
        size: 184320,
      },
    ]);
  });

  it('does not treat the body text parts as attachments', () => {
    expect(collectAttachments(alternative)).toEqual([]);
    expect(collectAttachments(simpleText)).toEqual([]);
  });

  it('includes inline images that carry a filename', () => {
    const structure = {
      type: 'multipart/related',
      childNodes: [
        { type: 'text/html', part: '1' },
        {
          type: 'image/png',
          part: '2',
          disposition: 'inline',
          parameters: { name: 'screenshot.png' },
          size: 4096,
        },
      ],
    };
    // "the screenshot Bob sent" should be findable.
    expect(collectAttachments(structure)).toEqual([
      { part_id: '2', filename: 'screenshot.png', mime_type: 'image/png', size: 4096 },
    ]);
  });

  it('never reports a multipart container as an attachment', () => {
    const found = collectAttachments(withPdf);
    expect(found.every((a) => !a.mime_type?.startsWith('multipart/'))).toBe(true);
  });

  it('handles an attachment with no filename', () => {
    const structure = {
      type: 'multipart/mixed',
      childNodes: [
        { type: 'text/plain', part: '1' },
        { type: 'application/octet-stream', part: '2', disposition: 'attachment', size: 10 },
      ],
    };
    expect(collectAttachments(structure)).toEqual([
      { part_id: '2', filename: null, mime_type: 'application/octet-stream', size: 10 },
    ]);
  });

  it('tolerates null and malformed structures', () => {
    expect(collectAttachments(null)).toEqual([]);
    expect(collectAttachments('garbage')).toEqual([]);
  });
});
