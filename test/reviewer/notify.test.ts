import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { buildMacOsNotificationArgs, notifyIntent } from '../../src/reviewer/notify.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);

beforeEach(() => {
  mockExecFile.mockReset();
});

describe('buildMacOsNotificationArgs', () => {
  it('builds an osascript invocation without shell escaping', () => {
    expect(
      buildMacOsNotificationArgs('Review "Quarterly plan"', 4242, 'intent-abc')
    ).toEqual([
      '-e',
      'on run argv',
      '-e',
      'display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)',
      '-e',
      'end run',
      'Review "Quarterly plan"',
      'agent-mail',
      'http://127.0.0.1:4242/intents/intent-abc',
    ]);
  });
});

describe('notifyIntent', () => {
  it('posts notifications through osascript on macOS', () => {
    notifyIntent(
      {
        id: 'intent-123',
        account_id: 'test@example.com',
        tool: 'queue_send',
        params: { to: 'alice@example.com', subject: 'Quarterly plan' },
        risk: 'high',
        status: 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        agent_id: null,
      },
      4343,
      'darwin'
    );

    expect(mockExecFile).toHaveBeenCalledWith(
      'osascript',
      expect.arrayContaining([
        'agent-mail',
        'http://127.0.0.1:4343/intents/intent-123',
      ]),
      { timeout: 5000 },
      expect.any(Function)
    );
  });

  it('skips notifications on non-macOS platforms', () => {
    notifyIntent(
      {
        id: 'intent-123',
        account_id: 'test@example.com',
        tool: 'queue_send',
        params: { to: 'alice@example.com', subject: 'Quarterly plan' },
        risk: 'high',
        status: 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        agent_id: null,
      },
      4242,
      'linux'
    );

    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('logs a warning if osascript fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockExecFile.mockImplementation((_file, _args, _options, callback) => {
      callback?.(new Error('osascript failed'));
      return {} as never;
    });

    notifyIntent(
      {
        id: 'intent-123',
        account_id: 'test@example.com',
        tool: 'queue_send',
        params: { to: 'alice@example.com', subject: 'Quarterly plan' },
        risk: 'high',
        status: 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        agent_id: null,
      },
      4242,
      'darwin'
    );

    expect(warn).toHaveBeenCalledWith(
      'Failed to post macOS notification for intent intent-123: osascript failed'
    );

    warn.mockRestore();
  });
});
