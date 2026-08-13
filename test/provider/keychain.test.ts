import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { storePassword, getPassword, deletePassword, verifyKeychainAccess } from '../../src/provider/keychain.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

beforeEach(() => {
  mockExecFileSync.mockReset();
});

describe('storePassword', () => {
  it('calls security add-generic-password with correct args', () => {
    storePassword('agent-mail', 'gmail', 'my-secret');
    expect(mockExecFileSync).toHaveBeenCalledWith('security', [
      'add-generic-password',
      '-U',
      '-s', 'agent-mail',
      '-a', 'gmail',
      '-w', 'my-secret',
    ]);
  });

  it('throws a clear error on failure', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('security: SecKeychainItemCreateFromContent: error');
    });
    expect(() => storePassword('agent-mail', 'gmail', 'x')).toThrow(
      'Failed to store password in Keychain for account "gmail"'
    );
  });

  it('retries when a concurrent store wins the race', () => {
    let calls = 0;
    mockExecFileSync.mockImplementation(() => {
      if (++calls === 1) {
        const err = new Error(
          'security: SecKeychainItemCreateFromContent (<default>): The specified item already exists in the keychain.'
        );
        (err as any).status = 45;
        throw err;
      }
      return Buffer.from('');
    });
    expect(() => storePassword('agent-mail', 'gmail', 'x')).not.toThrow();
    expect(calls).toBe(2);
  });

  it('gives up if the duplicate error never clears', () => {
    mockExecFileSync.mockImplementation(() => {
      const err = new Error('The specified item already exists in the keychain.');
      (err as any).status = 45;
      throw err;
    });
    expect(() => storePassword('agent-mail', 'gmail', 'x')).toThrow(
      'Failed to store password in Keychain for account "gmail"'
    );
  });
});

describe('getPassword', () => {
  it('returns the password from security output', () => {
    mockExecFileSync.mockReturnValue(Buffer.from('my-secret\n'));
    const result = getPassword('agent-mail', 'gmail');
    expect(result).toBe('my-secret');
    expect(mockExecFileSync).toHaveBeenCalledWith('security', [
      'find-generic-password',
      '-s', 'agent-mail',
      '-a', 'gmail',
      '-w',
    ]);
  });

  it('returns null when credential not found', () => {
    mockExecFileSync.mockImplementation(() => {
      const err = new Error('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.');
      (err as any).status = 44;
      throw err;
    });
    const result = getPassword('agent-mail', 'gmail');
    expect(result).toBeNull();
  });

  it('throws on unexpected errors', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('some unexpected error');
    });
    expect(() => getPassword('agent-mail', 'unknown')).toThrow(
      'Failed to retrieve password from Keychain for account "unknown"'
    );
  });
});

describe('deletePassword', () => {
  it('calls security delete-generic-password with correct args', () => {
    deletePassword('agent-mail', 'gmail');
    expect(mockExecFileSync).toHaveBeenCalledWith('security', [
      'delete-generic-password',
      '-s', 'agent-mail',
      '-a', 'gmail',
    ]);
  });

  it('does not throw when credential not found', () => {
    mockExecFileSync.mockImplementation(() => {
      const err = new Error('not found');
      (err as any).status = 44;
      throw err;
    });
    expect(() => deletePassword('agent-mail', 'gmail')).not.toThrow();
  });
});

describe('verifyKeychainAccess', () => {
  it('passes when round-trip succeeds', () => {
    mockExecFileSync.mockImplementation((cmd, args) => {
      if (Array.isArray(args) && args[0] === 'find-generic-password') {
        return Buffer.from('agent-mail-keychain-test\n');
      }
      return Buffer.from('');
    });
    expect(() => verifyKeychainAccess()).not.toThrow();
  });

  it('throws when read-back returns wrong value', () => {
    mockExecFileSync.mockImplementation((cmd, args) => {
      if (Array.isArray(args) && args[0] === 'find-generic-password') {
        return Buffer.from('wrong-value\n');
      }
      return Buffer.from('');
    });
    expect(() => verifyKeychainAccess()).toThrow('Keychain integration check failed');
  });

  it('uses a probe account unique to this process', () => {
    const accounts: string[] = [];
    mockExecFileSync.mockImplementation((cmd, args) => {
      if (Array.isArray(args)) {
        const i = args.indexOf('-a');
        if (i !== -1) accounts.push(String(args[i + 1]));
        if (args[0] === 'find-generic-password') return Buffer.from('agent-mail-keychain-test\n');
      }
      return Buffer.from('');
    });

    verifyKeychainAccess();
    const first = [...new Set(accounts)];
    expect(first).toHaveLength(1);
    expect(first[0]).toContain(`__agent-mail-verify__${process.pid}-`);

    accounts.length = 0;
    verifyKeychainAccess();
    // A fresh probe per call, so a concurrent server's cleanup cannot delete ours.
    expect(new Set(accounts).has(first[0]!)).toBe(false);
  });

  it('throws when store fails', () => {
    mockExecFileSync.mockImplementation((cmd, args) => {
      if (Array.isArray(args) && args[0] === 'add-generic-password') {
        throw new Error('store failed');
      }
      return Buffer.from('');
    });
    expect(() => verifyKeychainAccess()).toThrow('Keychain integration check failed');
  });
});
