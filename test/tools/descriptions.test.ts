import { describe, it, expect } from 'vitest';
import { holdMessagesTool } from '../../src/tools/hold-messages.js';
import { restoreMessagesTool } from '../../src/tools/restore-messages.js';
import { labelThreadTool } from '../../src/tools/label-thread.js';
import { queueSendTool } from '../../src/tools/queue-send.js';
import { draftReplyTool } from '../../src/tools/draft-reply.js';
import { unsubscribeSenderTool } from '../../src/tools/unsubscribe-sender.js';
import { undoIntentTool } from '../../src/tools/undo-intent.js';

describe('mutation tool descriptions lead with reversibility', () => {
  it('hold_messages', () => {
    expect(holdMessagesTool.description).toMatch(/REVERSIBLE for 30 days/);
    expect(holdMessagesTool.description).toMatch(/cannot permanently delete/);
  });
  it('restore_messages', () => {
    expect(restoreMessagesTool.description).toMatch(/Fully reversible/);
  });
  it('label_thread', () => {
    expect(labelThreadTool.description).toMatch(/Fully reversible via `undo_intent` within 30 days/);
  });
  it('queue_send', () => {
    expect(queueSendTool.description).toMatch(/This server cannot send mail/);
  });
  it('draft_reply mentions no send', () => {
    expect(draftReplyTool.description).toMatch(/This server cannot send mail/);
  });
  it('unsubscribe_sender states limitations', () => {
    expect(unsubscribeSenderTool.description).toMatch(/cannot be automatically undone|best-effort/i);
  });
  it('undo_intent leads with what it does', () => {
    expect(undoIntentTool.description).toMatch(/Reverses a previously executed mutation/);
  });
});
