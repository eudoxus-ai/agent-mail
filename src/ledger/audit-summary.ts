import type { AuditAction } from '../types.js';

export function buildAuditSummary(
  tool: string,
  action: AuditAction,
  params: Record<string, unknown>,
  errorDetail?: { message: string }
): Record<string, unknown> {
  const to = params.to as string | undefined;
  const subject = params.subject as string | undefined;
  const uids = params.uids as number[] | undefined;
  const mailbox = params.mailbox as string | undefined;
  const label = params.label as string | undefined;

  if (action === 'failed') {
    const base = describeIntent(tool, params);
    return {
      summary: `Failed: ${base}`,
      error: errorDetail?.message ?? 'Unknown error',
    };
  }

  if (action === 'approved') {
    const base = describeIntent(tool, params);
    return { summary: `Approved: ${base}` };
  }

  if (action === 'rejected') {
    const base = describeIntent(tool, params);
    return { summary: `Rejected: ${base}` };
  }

  if (action === 'created') {
    const base = describeIntent(tool, params);
    return { summary: `Pending: ${base}` };
  }

  if (action === 'executing') {
    const base = describeIntent(tool, params);
    return { summary: `Executing: ${base}` };
  }

  if (action === 'undone') {
    const base = describeIntent(tool, params);
    return { summary: `Undone: ${base}` };
  }

  // 'executed'
  switch (tool) {
    case 'queue_send':
      return {
        summary: `Sent email to ${to ?? 'unknown'}: ${subject ?? '(no subject)'}`,
        to,
        subject,
      };

    case 'quarantine_thread': {
      const count = uids?.length ?? 0;
      return {
        summary: `Quarantined ${count} message${count !== 1 ? 's' : ''} from ${mailbox ?? 'INBOX'}`,
        count,
        mailbox: mailbox ?? 'INBOX',
      };
    }

    case 'label_thread':
      return {
        summary: `Labeled thread: ${label ?? 'unknown'}`,
        label,
      };

    default:
      return {
        summary: `Executed: ${tool}`,
      };
  }
}

export function describeIntent(tool: string, params: Record<string, unknown>): string {
  const to = params.to as string | undefined;
  const subject = params.subject as string | undefined;

  switch (tool) {
    case 'queue_send':
      return `Send email to ${to ?? 'unknown'}: ${subject ?? '(no subject)'}`;
    case 'quarantine_thread': {
      const uids = params.uids as number[] | undefined;
      const count = uids?.length ?? 0;
      return `Quarantine ${count} message${count !== 1 ? 's' : ''}`;
    }
    case 'label_thread':
      return `Label thread: ${params.label ?? 'unknown'}`;
    default:
      return tool;
  }
}
