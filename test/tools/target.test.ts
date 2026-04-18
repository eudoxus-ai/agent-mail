import { describe, it, expect } from 'vitest';
import { TargetSchema, TargetsSchema, parseTargets } from '../../src/tools/target.js';

describe('TargetSchema', () => {
  it('accepts a minimal target', () => {
    expect(TargetSchema.parse({ account_id: 'a@x.com', uid: 1 })).toEqual({
      account_id: 'a@x.com',
      uid: 1,
    });
  });

  it('accepts target with mailbox', () => {
    expect(
      TargetSchema.parse({ account_id: 'a@x.com', uid: 1, mailbox: 'INBOX' })
    ).toEqual({ account_id: 'a@x.com', uid: 1, mailbox: 'INBOX' });
  });

  it('rejects empty account_id', () => {
    expect(() => TargetSchema.parse({ account_id: '', uid: 1 })).toThrow();
  });

  it('rejects non-positive uid', () => {
    expect(() => TargetSchema.parse({ account_id: 'a@x.com', uid: 0 })).toThrow();
  });
});

describe('TargetsSchema', () => {
  it('rejects empty array', () => {
    expect(() => TargetsSchema.parse([])).toThrow();
  });

  it('accepts mixed-account targets', () => {
    const targets = [
      { account_id: 'a@x.com', uid: 1 },
      { account_id: 'b@y.com', uid: 2 },
    ];
    expect(TargetsSchema.parse(targets)).toEqual(targets);
  });
});

describe('parseTargets (groupByAccount)', () => {
  it('groups targets by account_id with mailbox default', () => {
    const grouped = parseTargets([
      { account_id: 'a@x.com', uid: 1 },
      { account_id: 'a@x.com', uid: 2, mailbox: 'Archive' },
      { account_id: 'b@y.com', uid: 5 },
    ]);
    expect(grouped).toEqual({
      'a@x.com': [
        { uid: 1, mailbox: 'INBOX' },
        { uid: 2, mailbox: 'Archive' },
      ],
      'b@y.com': [{ uid: 5, mailbox: 'INBOX' }],
    });
  });
});
