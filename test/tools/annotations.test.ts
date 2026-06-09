import { describe, it, expect } from 'vitest';
import { searchThreadsTool } from '../../src/tools/search-threads.js';
import { readThreadTool } from '../../src/tools/read-thread.js';
import { listSendersTool } from '../../src/tools/list-senders.js';
import { listMailboxesTool } from '../../src/tools/list-mailboxes.js';
import { getAuditLogTool } from '../../src/tools/get-audit-log.js';
import { getOverviewTool } from '../../src/tools/get-overview.js';
import { getPendingActionsTool } from '../../src/tools/get-pending-actions.js';
import { getIntentTool } from '../../src/tools/get-intent.js';
import { getScanResultTool } from '../../src/tools/get-scan-result.js';
import { labelThreadTool } from '../../src/tools/label-thread.js';
import { holdMessagesTool } from '../../src/tools/hold-messages.js';
import { restoreMessagesTool } from '../../src/tools/restore-messages.js';
import { undoIntentTool } from '../../src/tools/undo-intent.js';
import { draftReplyTool } from '../../src/tools/draft-reply.js';
import { queueSendTool } from '../../src/tools/queue-send.js';
import { unsubscribeSenderTool } from '../../src/tools/unsubscribe-sender.js';

const cases: Array<
  [string, { annotations?: unknown }, { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean }]
> = [
  ['search_threads', searchThreadsTool, { readOnlyHint: true, destructiveHint: false, idempotentHint: true }],
  ['read_thread', readThreadTool, { readOnlyHint: true, destructiveHint: false, idempotentHint: true }],
  ['list_senders', listSendersTool, { readOnlyHint: true, destructiveHint: false, idempotentHint: true }],
  ['list_mailboxes', listMailboxesTool, { readOnlyHint: true, destructiveHint: false, idempotentHint: true }],
  ['get_audit_log', getAuditLogTool, { readOnlyHint: true, destructiveHint: false, idempotentHint: true }],
  ['get_overview', getOverviewTool, { readOnlyHint: true, destructiveHint: false, idempotentHint: true }],
  ['get_pending_actions', getPendingActionsTool, { readOnlyHint: true, destructiveHint: false, idempotentHint: true }],
  ['get_intent', getIntentTool, { readOnlyHint: true, destructiveHint: false, idempotentHint: true }],
  ['get_scan_result', getScanResultTool, { readOnlyHint: true, destructiveHint: false, idempotentHint: true }],
  ['label_thread', labelThreadTool, { readOnlyHint: false, destructiveHint: false, idempotentHint: true }],
  ['hold_messages', holdMessagesTool, { readOnlyHint: false, destructiveHint: false, idempotentHint: true }],
  ['restore_messages', restoreMessagesTool, { readOnlyHint: false, destructiveHint: false, idempotentHint: true }],
  ['undo_intent', undoIntentTool, { readOnlyHint: false, destructiveHint: false, idempotentHint: true }],
  ['draft_reply', draftReplyTool, { readOnlyHint: false, destructiveHint: false, idempotentHint: false }],
  ['queue_send', queueSendTool, { readOnlyHint: false, destructiveHint: true, idempotentHint: false }],
  ['unsubscribe_sender', unsubscribeSenderTool, { readOnlyHint: false, destructiveHint: true, idempotentHint: false }],
];

describe('tool annotations', () => {
  for (const [name, tool, expected] of cases) {
    it(`${name} has expected annotations`, () => {
      expect(tool.annotations).toMatchObject(expected);
    });
  }
});
