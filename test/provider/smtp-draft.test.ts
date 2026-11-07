import { describe, it, expect } from 'vitest';
import { buildDraftMessage } from '../../src/provider/smtp.js';
import { splitHeadersBody } from '../../src/provider/mime.js';

const base = { from: 'a@example.com', to: 'b@example.com', subject: 'Hi' };

describe('buildDraftMessage', () => {
  it('separates headers from the body', () => {
    const raw = buildDraftMessage({ ...base, text: 'One paragraph.' }).toString();
    const { headers, body } = splitHeadersBody(raw);
    expect(headers).toContain('Subject: Hi');
    expect(headers).not.toContain('One paragraph.');
    expect(body).toBe('One paragraph.');
  });

  it('keeps the first paragraph of a longer body', () => {
    const raw = buildDraftMessage({ ...base, text: 'First.\n\nSecond.' }).toString();
    expect(splitHeadersBody(raw).body).toBe('First.\r\n\r\nSecond.');
  });

  it('leaves out threading headers that were not supplied', () => {
    const raw = buildDraftMessage({ ...base, text: 'x' }).toString();
    expect(raw).not.toContain('In-Reply-To');
    expect(raw).not.toContain('References');
  });
});
