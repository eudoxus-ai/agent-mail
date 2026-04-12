import { describe, it, expect } from 'vitest';
import { storePassword, getPassword, deletePassword, KEYCHAIN_SERVICE } from '../../src/provider/keychain.js';

const TEST_ACCOUNT = '__agent-mail-integration-test__';

describe.skipIf(!process.env.AGENT_MAIL_TEST_KEYCHAIN)('Keychain integration (real macOS Keychain)', () => {
  it('round-trips a password through the real Keychain', () => {
    // Clean up any leftover from a previous failed run
    deletePassword(KEYCHAIN_SERVICE, TEST_ACCOUNT);

    // Store
    storePassword(KEYCHAIN_SERVICE, TEST_ACCOUNT, 'integration-test-password');

    // Read back
    const password = getPassword(KEYCHAIN_SERVICE, TEST_ACCOUNT);
    expect(password).toBe('integration-test-password');

    // Update (store with -U flag overwrites)
    storePassword(KEYCHAIN_SERVICE, TEST_ACCOUNT, 'updated-password');
    const updated = getPassword(KEYCHAIN_SERVICE, TEST_ACCOUNT);
    expect(updated).toBe('updated-password');

    // Delete
    deletePassword(KEYCHAIN_SERVICE, TEST_ACCOUNT);

    // Verify gone
    const gone = getPassword(KEYCHAIN_SERVICE, TEST_ACCOUNT);
    expect(gone).toBeNull();
  });
});
