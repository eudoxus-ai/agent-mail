import { describe, it, expect } from 'vitest';
import { buildAuditSummary } from '../../src/ledger/audit-summary.js';

describe('buildAuditSummary', () => {
  it('summarizes queue_send execution', () => {
    const detail = buildAuditSummary('queue_send', 'executed', {
      to: 'alice@example.com',
      subject: 'Re: Meeting notes',
      body: 'Thanks for the update.',
    });
    expect(detail.summary).toBe('Sent email to alice@example.com: Re: Meeting notes');
    expect(detail.to).toBe('alice@example.com');
    expect(detail.subject).toBe('Re: Meeting notes');
  });

  it('summarizes queue_send approval', () => {
    const detail = buildAuditSummary('queue_send', 'approved', {
      to: 'alice@example.com',
      subject: 'Re: Meeting notes',
    });
    expect(detail.summary).toBe('Approved: Send email to alice@example.com: Re: Meeting notes');
  });

  it('summarizes queue_send rejection', () => {
    const detail = buildAuditSummary('queue_send', 'rejected', {
      to: 'alice@example.com',
      subject: 'Re: Meeting notes',
    });
    expect(detail.summary).toBe('Rejected: Send email to alice@example.com: Re: Meeting notes');
  });

  it('summarizes hold_messages execution', () => {
    const detail = buildAuditSummary('hold_messages', 'executed', {
      targets: [
        { account_id: 'a@x.com', uid: 1 },
        { account_id: 'a@x.com', uid: 2 },
        { account_id: 'b@y.com', uid: 3 },
      ],
    });
    expect(detail.summary).toBe('Held 3 messages');
    expect(detail.count).toBe(3);
    expect(detail.dry_run).toBe(false);
  });

  it('summarizes hold_messages dry-run', () => {
    const detail = buildAuditSummary('hold_messages', 'executed', {
      targets: [{ account_id: 'a@x.com', uid: 1 }],
      dry_run: true,
    });
    expect(detail.summary).toBe('Previewed hold of 1 message');
    expect(detail.dry_run).toBe(true);
  });

  it('summarizes restore_messages execution', () => {
    const detail = buildAuditSummary('restore_messages', 'executed', {
      targets: [
        { account_id: 'a@x.com', uid: 1 },
        { account_id: 'a@x.com', uid: 2 },
      ],
    });
    expect(detail.summary).toBe('Restored 2 messages');
    expect(detail.count).toBe(2);
    expect(detail.dry_run).toBe(false);
  });

  it('summarizes restore_messages dry-run', () => {
    const detail = buildAuditSummary('restore_messages', 'executed', {
      targets: [{ account_id: 'a@x.com', uid: 1 }],
      dry_run: true,
    });
    expect(detail.summary).toBe('Previewed restore of 1 message');
    expect(detail.dry_run).toBe(true);
  });

  it('summarizes get_intent execution', () => {
    const detail = buildAuditSummary('get_intent', 'executed', {
      id: 'intent-42',
    });
    expect(detail.summary).toBe('Read intent intent-42');
  });

  it('summarizes label_thread execution', () => {
    const detail = buildAuditSummary('label_thread', 'executed', {
      label: 'Important',
      thread_id: 'abc123',
    });
    expect(detail.summary).toContain('Important');
  });

  it('summarizes unknown tool execution', () => {
    const detail = buildAuditSummary('unknown_tool', 'executed', {});
    expect(detail.summary).toBe('Executed: unknown_tool');
  });

  it('summarizes created action as pending', () => {
    const detail = buildAuditSummary('queue_send', 'created', {
      to: 'alice@example.com',
      subject: 'Hello',
    });
    expect(detail.summary).toBe('Pending: Send email to alice@example.com: Hello');
  });

  it('summarizes executing action with prefix', () => {
    const detail = buildAuditSummary('hold_messages', 'executing', {
      targets: [
        { account_id: 'a@x.com', uid: 1 },
        { account_id: 'a@x.com', uid: 2 },
      ],
    });
    expect(detail.summary).toBe('Executing: Hold 2 messages');
  });

  it('summarizes undone action with prefix', () => {
    const detail = buildAuditSummary('queue_send', 'undone', {
      to: 'alice@example.com',
      subject: 'Test',
    });
    expect(detail.summary).toBe('Undone: Send email to alice@example.com: Test');
  });

  it('includes error in failed summary', () => {
    const detail = buildAuditSummary('queue_send', 'failed', {
      to: 'alice@example.com',
      subject: 'Test',
    }, { message: 'SMTP connection refused' });
    expect(detail.summary).toContain('Failed');
    expect(detail.error).toBe('SMTP connection refused');
  });
});
