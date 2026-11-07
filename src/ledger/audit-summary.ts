import type { AuditAction } from '../types.js';

interface Target {
  account_id: string;
  uid: number;
  mailbox?: string;
}

export function buildAuditSummary(
  tool: string,
  action: AuditAction,
  params: Record<string, unknown>,
  errorDetail?: { message: string }
): Record<string, unknown> {
  const to = params.to as string | undefined;
  const subject = params.subject as string | undefined;
  const targets = params.targets as Target[] | undefined;
  const label = params.label as string | undefined;
  const dryRun = params.dry_run === true;

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

    case 'hold_messages': {
      const count = targets?.length ?? 0;
      const verb = dryRun ? 'Previewed hold of' : 'Held';
      return {
        summary: `${verb} ${count} message${count !== 1 ? 's' : ''}`,
        count,
        dry_run: dryRun,
      };
    }

    case 'hold_by_sender': {
      const from = sweepLabel(params);
      const verb = dryRun ? 'Previewed hold of messages from' : 'Held messages from';
      return {
        summary: `${verb} ${from}`,
        from,
        dry_run: dryRun,
      };
    }

    case 'restore_messages': {
      const count = targets?.length ?? 0;
      const verb = dryRun ? 'Previewed restore of' : 'Restored';
      return {
        summary: `${verb} ${count} message${count !== 1 ? 's' : ''}`,
        count,
        dry_run: dryRun,
      };
    }

    case 'get_intent': {
      const id = params.id as string | undefined;
      return {
        summary: `Read intent ${id ?? 'unknown'}`,
      };
    }

    case 'label_thread': {
      const count = targets?.length ?? 0;
      return {
        summary: `Labeled ${count} message${count !== 1 ? 's' : ''}: ${label ?? 'unknown'}`,
        label,
        count,
      };
    }

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
    case 'hold_messages': {
      const targets = params.targets as Target[] | undefined;
      const count = targets?.length ?? 0;
      const dryRun = params.dry_run === true;
      const verb = dryRun ? 'Preview hold of' : 'Hold';
      return `${verb} ${count} message${count !== 1 ? 's' : ''}`;
    }
    case 'hold_by_sender': {
      const dryRun = params.dry_run === true;
      const verb = dryRun ? 'Preview hold of messages from' : 'Hold messages from';
      return `${verb} ${sweepLabel(params)}`;
    }
    case 'restore_messages': {
      const targets = params.targets as Target[] | undefined;
      const count = targets?.length ?? 0;
      const dryRun = params.dry_run === true;
      const verb = dryRun ? 'Preview restore of' : 'Restore';
      return `${verb} ${count} message${count !== 1 ? 's' : ''}`;
    }
    case 'get_intent': {
      const id = params.id as string | undefined;
      return `Read intent ${id ?? 'unknown'}`;
    }
    case 'label_thread': {
      const targets = params.targets as Target[] | undefined;
      const count = targets?.length ?? 0;
      return `Label ${count} message${count !== 1 ? 's' : ''}: ${params.label ?? 'unknown'}`;
    }
    default:
      return tool;
  }
}

function sweepLabel(params: Record<string, unknown>): string {
  const from = params.from as string | string[] | undefined;
  if (Array.isArray(from)) return from.length === 1 ? from[0] : `${from.length} senders`;
  if (from) return from;
  return params.list_id ? `list ${params.list_id as string}` : 'unknown sender';
}
