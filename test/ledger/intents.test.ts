import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from '../../src/ledger/sqlite.js';
import { openDatabase } from '../../src/ledger/db.js';
import {
  createIntent,
  getIntent,
  updateIntentStatus,
  getPendingIntents,
  getIntentsByStatus,
} from '../../src/ledger/intents.js';

let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:');
});

describe('createIntent', () => {
  it('creates an intent with pending status', () => {
    const intent = createIntent(db, {
      account_id: 'gmail',
      tool: 'queue_send',
      params: { to: 'test@example.com', subject: 'Hi', body: 'Hello' },
      risk: 'high',
      agent_id: 'claude',
    });

    expect(intent.id).toBeTruthy();
    expect(intent.status).toBe('pending');
    expect(intent.account_id).toBe('gmail');
    expect(intent.tool).toBe('queue_send');
    expect(intent.params).toEqual({
      to: 'test@example.com',
      subject: 'Hi',
      body: 'Hello',
    });
    expect(intent.risk).toBe('high');
    expect(intent.agent_id).toBe('claude');
  });

  it('generates unique IDs', () => {
    const a = createIntent(db, {
      account_id: 'gmail',
      tool: 'label_thread',
      params: {},
      risk: 'low',
    });
    const b = createIntent(db, {
      account_id: 'gmail',
      tool: 'label_thread',
      params: {},
      risk: 'low',
    });
    expect(a.id).not.toBe(b.id);
  });
});

describe('getIntent', () => {
  it('returns null for non-existent intent', () => {
    expect(getIntent(db, 'nonexistent')).toBeNull();
  });

  it('returns the intent by ID', () => {
    const created = createIntent(db, {
      account_id: 'icloud',
      tool: 'search_threads',
      params: { query: 'test' },
      risk: 'none',
    });
    const found = getIntent(db, created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.params).toEqual({ query: 'test' });
  });
});

describe('updateIntentStatus', () => {
  it('transitions pending to approved', () => {
    const intent = createIntent(db, {
      account_id: 'gmail',
      tool: 'queue_send',
      params: {},
      risk: 'high',
    });
    updateIntentStatus(db, intent.id, 'approved', { resolved_by: 'user' });
    const updated = getIntent(db, intent.id)!;
    expect(updated.status).toBe('approved');
    expect(updated.resolved_by).toBe('user');
  });

  it('transitions to executed with undo token', () => {
    const intent = createIntent(db, {
      account_id: 'gmail',
      tool: 'quarantine_thread',
      params: {},
      risk: 'medium',
    });
    updateIntentStatus(db, intent.id, 'executed', {
      resolved_by: 'policy',
      undo_token: 'token-123',
      undo_expires_at: '2026-05-10T00:00:00Z',
    });
    const updated = getIntent(db, intent.id)!;
    expect(updated.status).toBe('executed');
    expect(updated.undo_token).toBe('token-123');
    expect(updated.resolved_at).toBeTruthy();
  });

  it('transitions to failed with error detail', () => {
    const intent = createIntent(db, {
      account_id: 'gmail',
      tool: 'queue_send',
      params: {},
      risk: 'high',
    });
    updateIntentStatus(db, intent.id, 'failed', {
      error_detail: { code: 429, message: 'Rate limited' },
    });
    const updated = getIntent(db, intent.id)!;
    expect(updated.status).toBe('failed');
    expect(updated.error_detail).toEqual({
      code: 429,
      message: 'Rate limited',
    });
  });
});

describe('getPendingIntents', () => {
  it('returns only pending intents', () => {
    createIntent(db, { account_id: 'gmail', tool: 'queue_send', params: {}, risk: 'high' });
    createIntent(db, { account_id: 'gmail', tool: 'queue_send', params: {}, risk: 'high' });
    const executed = createIntent(db, {
      account_id: 'gmail',
      tool: 'label_thread',
      params: {},
      risk: 'low',
    });
    updateIntentStatus(db, executed.id, 'executed');

    const pending = getPendingIntents(db);
    expect(pending).toHaveLength(2);
  });

  it('filters by account_id', () => {
    createIntent(db, { account_id: 'gmail', tool: 'queue_send', params: {}, risk: 'high' });
    createIntent(db, { account_id: 'icloud', tool: 'queue_send', params: {}, risk: 'high' });

    const gmailPending = getPendingIntents(db, 'gmail');
    expect(gmailPending).toHaveLength(1);
    expect(gmailPending[0].account_id).toBe('gmail');
  });

  it('returns empty array when no pending intents', () => {
    expect(getPendingIntents(db)).toHaveLength(0);
  });
});

describe('getIntentsByStatus', () => {
  it('finds intents by status', () => {
    const intent = createIntent(db, {
      account_id: 'gmail',
      tool: 'queue_send',
      params: {},
      risk: 'high',
    });
    updateIntentStatus(db, intent.id, 'failed', {
      error_detail: { message: 'error' },
    });

    const failed = getIntentsByStatus(db, 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].id).toBe(intent.id);
  });
});
