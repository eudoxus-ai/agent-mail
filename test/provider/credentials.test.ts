import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveCredentials } from '../../src/provider/credentials.js';
import * as keychain from '../../src/provider/keychain.js';
import type { AccountConfig } from '../../src/types.js';

vi.mock('../../src/provider/keychain.js', () => ({
  getPassword: vi.fn(),
  KEYCHAIN_SERVICE: 'agent-mail',
}));

const mockGetPassword = vi.mocked(keychain.getPassword);

const testAccount: AccountConfig = {
  id: 'gmail',
  email: 'user@gmail.com',
  imap: { host: 'imap.gmail.com', port: 993, tls: true },
  smtp: { host: 'smtp.gmail.com', port: 587, tls: true },
};

beforeEach(() => {
  mockGetPassword.mockReset();
});

describe('resolveCredentials', () => {
  it('returns a ResolvedAccount with auth from keychain', () => {
    mockGetPassword.mockReturnValue('app-password-123');
    const resolved = resolveCredentials(testAccount);
    expect(resolved.auth).toEqual({ user: 'user@gmail.com', pass: 'app-password-123' });
    expect(resolved.id).toBe('gmail');
    expect(resolved.email).toBe('user@gmail.com');
    expect(mockGetPassword).toHaveBeenCalledWith('agent-mail', 'gmail');
  });

  it('throws when no credentials found in keychain', () => {
    mockGetPassword.mockReturnValue(null);
    expect(() => resolveCredentials(testAccount)).toThrow(
      'No credentials found for account "gmail". Run "agent-mail add-account" to set up.'
    );
  });
});
