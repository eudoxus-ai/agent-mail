import { describe, it, expect } from 'vitest';
import {
  normalizeDate,
  htmlToText,
  deriveSnippet,
  toMessageRow,
  toFtsRow,
  type IngestInput,
} from '../../src/cache/ingest.js';
import type { EmailMessage } from '../../src/types.js';

function message(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    uid: 42,
    messageId: '<a@example.com>',
    from: { address: 'alice@example.com', name: 'Alice' },
    to: [{ address: 'you@example.com', name: null }],
    cc: [],
    date: '2026-06-01T10:00:00Z',
    subject: 'Q2 pricing',
    bodyText: 'We decided to hold the price.',
    references: [],
    flags: [],
    mailbox: 'INBOX',
    ...overrides,
  };
}

function input(overrides: Partial<IngestInput> = {}): IngestInput {
  return {
    accountId: 'work',
    message: message(),
    uidvalidity: 1,
    ...overrides,
  };
}

describe('normalizeDate', () => {
  const now = Date.UTC(2026, 6, 31);

  it('uses a plausible Date header', () => {
    expect(normalizeDate('2026-06-01T10:00:00Z', null, now)).toBe(
      Date.parse('2026-06-01T10:00:00Z')
    );
  });

  it('falls back to INTERNALDATE when the header is missing', () => {
    const internal = new Date(Date.UTC(2026, 5, 2));
    expect(normalizeDate(null, internal, now)).toBe(internal.getTime());
  });

  it('falls back to INTERNALDATE when the header is unparseable', () => {
    const internal = new Date(Date.UTC(2026, 5, 2));
    expect(normalizeDate('not a date', internal, now)).toBe(internal.getTime());
  });

  it('rejects far-future dates used to pin mail to the top of an inbox', () => {
    const internal = new Date(Date.UTC(2026, 5, 2));
    expect(normalizeDate('2099-01-01T00:00:00Z', internal, now)).toBe(internal.getTime());
  });

  it('rejects absurdly old dates', () => {
    const internal = new Date(Date.UTC(2026, 5, 2));
    expect(normalizeDate('1970-01-01T00:00:00Z', internal, now)).toBe(internal.getTime());
  });

  it('clamps a server date that is ahead of our clock rather than rejecting it', () => {
    const skewed = new Date(now + 60 * 60 * 1000);
    expect(normalizeDate(null, skewed, now)).toBe(skewed.getTime());
  });

  it('returns 0 when nothing usable is available', () => {
    expect(normalizeDate(null, null, now)).toBe(0);
  });
});

describe('htmlToText', () => {
  it('drops script and style contents entirely', () => {
    const text = htmlToText(
      '<style>.a{color:red}</style><p>Hello</p><script>var secret=1</script>'
    );
    expect(text).toContain('Hello');
    expect(text).not.toContain('color');
    expect(text).not.toContain('secret');
  });

  it('decodes entities and preserves word boundaries', () => {
    expect(htmlToText('<p>Tom&nbsp;&amp;&nbsp;Jerry</p>')).toBe('Tom & Jerry');
  });

  it('does not run words together across tags', () => {
    expect(htmlToText('<td>alpha</td><td>beta</td>')).toBe('alpha beta');
  });

  it('handles numeric entities', () => {
    expect(htmlToText('caf&#233;')).toBe('café');
  });

  it('returns empty string for empty input', () => {
    expect(htmlToText('')).toBe('');
  });
});

describe('deriveSnippet', () => {
  it('collapses whitespace', () => {
    expect(deriveSnippet('a\n\n  b\tc')).toBe('a b c');
  });

  it('truncates to the limit', () => {
    expect(deriveSnippet('x'.repeat(500)).length).toBe(200);
  });
});

describe('toMessageRow', () => {
  it('denormalizes flags into hot columns, case-insensitively', () => {
    const row = toMessageRow(
      input({ message: message({ flags: ['\\seen', '\\FLAGGED'] }) })
    );
    expect(row.seen).toBe(1);
    expect(row.flagged).toBe(1);
    expect(row.answered).toBe(0);
  });

  it('keeps a missing Message-Id as null rather than empty string', () => {
    const row = toMessageRow(input({ message: message({ messageId: '  ' }) }));
    expect(row.message_id).toBeNull();
  });

  it('derives body text from HTML when there is no plain part', () => {
    const row = toMessageRow(
      input({
        message: message({ bodyText: '', bodyHtml: '<p>Hello <b>there</b></p>' }),
      })
    );
    expect(row.snippet).toBe('Hello there');
    expect(row.body_state).toBe('fetched');
  });

  it('marks envelope-only ingest as pending', () => {
    const row = toMessageRow(input({ message: message({ bodyText: '' }) }));
    expect(row.body_state).toBe('pending');
    expect(row.snippet).toBe('');
  });

  it('marks list mail and classifies it', () => {
    const row = toMessageRow(
      input({
        listId: '<news.example.com>',
        message: message({ subject: 'Weekly digest' }),
      })
    );
    expect(row.is_list_mail).toBe(1);
    expect(row.category).toBe('newsletter');
  });

  it('flags attachments', () => {
    const row = toMessageRow(
      input({
        attachments: [
          { part_id: '2', filename: 'deck.pdf', mime_type: 'application/pdf', size: 10 },
        ],
      })
    );
    expect(row.has_attach).toBe(1);
  });
});

describe('toFtsRow', () => {
  it('indexes participants as name and address', () => {
    const fts = toFtsRow(input());
    expect(fts.participants).toContain('Alice <alice@example.com>');
    expect(fts.participants).toContain('you@example.com');
  });

  it('indexes attachment filenames', () => {
    const fts = toFtsRow(
      input({
        attachments: [
          { part_id: '2', filename: 'q2-pricing.pdf', mime_type: null, size: null },
        ],
      })
    );
    expect(fts.attachment_names).toBe('q2-pricing.pdf');
  });

  it('accepts a body supplied later', () => {
    const fts = toFtsRow(input({ message: message({ bodyText: '' }) }), 'late body');
    expect(fts.body).toBe('late body');
  });
});
