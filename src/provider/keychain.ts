import { execFileSync } from 'node:child_process';

const KEYCHAIN_SERVICE = 'agent-mail';
const VERIFY_ACCOUNT = '__agent-mail-verify__';
const VERIFY_VALUE = 'agent-mail-keychain-test';

export function storePassword(service: string, account: string, password: string): void {
  try {
    execFileSync('security', [
      'add-generic-password',
      '-U',
      '-s', service,
      '-a', account,
      '-w', password,
    ]);
  } catch (error) {
    throw new Error(
      `Failed to store password in Keychain for account "${account}": ${error instanceof Error ? error.message : error}`
    );
  }
}

export function getPassword(service: string, account: string): string | null {
  try {
    const result = execFileSync('security', [
      'find-generic-password',
      '-s', service,
      '-a', account,
      '-w',
    ]);
    return result.toString().trim();
  } catch (error: any) {
    // Exit code 44 = item not found
    if (error?.status === 44 || error?.message?.includes('could not be found')) {
      return null;
    }
    throw new Error(
      `Failed to retrieve password from Keychain for account "${account}": ${error instanceof Error ? error.message : error}`
    );
  }
}

export function deletePassword(service: string, account: string): void {
  try {
    execFileSync('security', [
      'delete-generic-password',
      '-s', service,
      '-a', account,
    ]);
  } catch (error: any) {
    // Ignore "not found" — idempotent delete
    if (error?.status === 44 || error?.message?.includes('could not be found')) {
      return;
    }
    throw new Error(
      `Failed to delete password from Keychain for account "${account}": ${error instanceof Error ? error.message : error}`
    );
  }
}

export function verifyKeychainAccess(): void {
  try {
    storePassword(KEYCHAIN_SERVICE, VERIFY_ACCOUNT, VERIFY_VALUE);
    const readBack = getPassword(KEYCHAIN_SERVICE, VERIFY_ACCOUNT);
    try {
      deletePassword(KEYCHAIN_SERVICE, VERIFY_ACCOUNT);
    } catch {
      // Best effort — don't let a delete failure mask the real result
    }
    if (readBack !== VERIFY_VALUE) {
      throw new Error(`read-back mismatch: expected "${VERIFY_VALUE}", got "${readBack}"`);
    }
  } catch (error) {
    // Re-throw if already our formatted error
    if (error instanceof Error && error.message.startsWith('Keychain integration check failed')) {
      throw error;
    }
    throw new Error(
      `Keychain integration check failed: ${error instanceof Error ? error.message : error}. The macOS 'security' CLI may have changed. Please file an issue.`
    );
  }
}

export { KEYCHAIN_SERVICE };
