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

  it('summarizes quarantine_thread execution', () => {
    const detail = buildAuditSummary('quarantine_thread', 'executed', {
      uids: [1, 2, 3],
      mailbox: 'INBOX',
    });
    expect(detail.summary).toBe('Quarantined 3 messages from INBOX');
    expect(detail.count).toBe(3);
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

  it('includes error in failed summary', () => {
    const detail = buildAuditSummary('queue_send', 'failed', {
      to: 'alice@example.com',
      subject: 'Test',
    }, { message: 'SMTP connection refused' });
    expect(detail.summary).toContain('Failed');
    expect(detail.error).toBe('SMTP connection refused');
  });
});
