import { describe, it, expect } from 'vitest';
import { projectResult, ALLOWED_FIELDS } from '../../src/lib/envelope-projection.js';

const sample = {
  account_id: 'a', mailbox: 'INBOX', uid: 7,
  envelope: {
    message_id: '<m>',
    subject: 'S',
    from: { address: 'x@y', name: 'X' },
    date: '2026-04-18T00:00:00Z',
  },
  snippet: 's', flags: [],
  list_id: null, list_unsubscribe: null, is_list_mail: false,
  category: 'personal',
  target: { account_id: 'a', uid: 7, mailbox: 'INBOX' },
};

describe('projectResult', () => {
  it('returns full shape when fields omitted', () => {
    expect(projectResult(sample, undefined)).toEqual(sample);
  });
  it('returns full shape when fields is empty array', () => {
    expect(projectResult(sample, [])).toEqual(sample);
  });
  it('keeps only requested top-level fields', () => {
    expect(projectResult(sample, ['uid', 'subject', 'from_address'])).toEqual({
      uid: 7, subject: 'S', from_address: 'x@y',
    });
  });
  it('exposes flat from_address and from_name projections', () => {
    expect(projectResult(sample, ['from_address', 'from_name'])).toEqual({
      from_address: 'x@y', from_name: 'X',
    });
  });
  it('ALLOWED_FIELDS lists core projectable fields', () => {
    for (const f of ['uid', 'subject', 'from_address', 'from_name', 'date', 'target', 'category']) {
      expect(ALLOWED_FIELDS).toContain(f);
    }
  });
  it('projects category field when requested', () => {
    expect(projectResult(sample, ['uid', 'category'])).toEqual({
      uid: 7, category: 'personal',
    });
  });
});
