import { describe, it, expect } from 'vitest';
import { isSentMailbox } from '../../src/lib/sent-mailboxes.js';

describe('isSentMailbox', () => {
  it.each([
    ['INBOX.Sent Messages', null, '.'],
    ['Sent', null, '/'],
    ['Sent Items', null, '/'],
    ['[Gmail]/Sent Mail', '\\Sent', '/'],
    ['Gesendet', '\\Sent', '/'],
  ])('accepts %s', (path, specialUse, delimiter) => {
    expect(isSentMailbox({ path, specialUse, delimiter })).toBe(true);
  });

  it.each([
    ['INBOX', '\\Inbox'],
    ['Sent to accountant', null],
    ['Presents', null],
    ['INBOX.Sent.Old Receipts', null],
  ])('rejects %s', (path, specialUse) => {
    expect(isSentMailbox({ path, specialUse, delimiter: '.' })).toBe(false);
  });
});
