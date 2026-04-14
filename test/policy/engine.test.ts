import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { evaluatePolicy, loadPolicy } from '../../src/policy/engine.js';
import { DEFAULT_POLICY_YAML } from '../../src/policy/defaults.js';
import type { PolicyConfig } from '../../src/types.js';

const policy = yaml.load(DEFAULT_POLICY_YAML) as PolicyConfig;

describe('evaluatePolicy', () => {
  it('ungated tools always execute', () => {
    for (const tool of [
      'search_threads',
      'read_thread',
      'draft_reply',
      'label_thread',
      'get_pending_actions',
      'get_audit_log',
      'undo_intent',
      'unsubscribe_sender',
    ]) {
      const result = evaluatePolicy(policy, tool);
      expect(result.decision).toBe('execute');
    }
  });

  it('always_gated tools always gate', () => {
    const result = evaluatePolicy(policy, 'queue_send');
    expect(result.decision).toBe('gate');
    expect(result.risk).toBe('high');
  });

  it('quarantine_thread is ungated by default (no replies)', () => {
    const result = evaluatePolicy(policy, 'quarantine_thread', {
      threadHasReplies: false,
    });
    expect(result.decision).toBe('execute');
  });

  it('quarantine_thread is gated when thread has replies', () => {
    const result = evaluatePolicy(policy, 'quarantine_thread', {
      threadHasReplies: true,
    });
    expect(result.decision).toBe('gate');
    expect(result.reason).toContain('when_thread_has_replies');
  });

  it('quarantine_thread is ungated when no context provided', () => {
    const result = evaluatePolicy(policy, 'quarantine_thread');
    expect(result.decision).toBe('execute');
  });

  it('unknown tools are gated by default', () => {
    const result = evaluatePolicy(policy, 'nonexistent_tool');
    expect(result.decision).toBe('gate');
    expect(result.risk).toBe('high');
  });

  it('throws on malformed policy files instead of silently defaulting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-mail-policy-'));
    const path = join(dir, 'policy.yaml');
    writeFileSync(path, 'tools: 42\n');

    expect(() => loadPolicy(path)).toThrow('Invalid policy.yaml');
  });

  it('throws when a configurable tool has an invalid default value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-mail-policy-'));
    const path = join(dir, 'policy.yaml');
    writeFileSync(
      path,
      'tools:\n  some_tool:\n    risk: medium\n    gate: configurable\n    default: always_approve\n'
    );

    expect(() => loadPolicy(path)).toThrow('invalid default');
  });

  it('throws when a configurable tool has an invalid override value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-mail-policy-'));
    const path = join(dir, 'policy.yaml');
    writeFileSync(
      path,
      'tools:\n  some_tool:\n    risk: medium\n    gate: configurable\n    override:\n      when_thread_has_replies: maybe\n'
    );

    expect(() => loadPolicy(path)).toThrow('invalid value');
  });
});
