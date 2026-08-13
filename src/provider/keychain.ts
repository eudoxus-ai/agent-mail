import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const KEYCHAIN_SERVICE = 'agent-mail';
const VERIFY_VALUE = 'agent-mail-keychain-test';

// Exit code 45 = errSecDuplicateItem
const DUPLICATE_ITEM_STATUS = 45;

function isDuplicateItem(error: any): boolean {
  return error?.status === DUPLICATE_ITEM_STATUS || !!error?.message?.includes('already exists');
}

export function storePassword(service: string, account: string, password: string): void {
  // `security add-generic-password -U` is check-then-act, not atomic: it looks for
  // an existing item and only falls back to a plain add when it finds none. Two
  // processes storing the same account can both miss, and the loser's add fails with
  // errSecDuplicateItem. Retrying makes the winner's item visible, so -U updates it.
  for (let attempt = 0; ; attempt++) {
    try {
      execFileSync('security', [
        'add-generic-password',
        '-U',
        '-s', service,
        '-a', account,
        '-w', password,
      ]);
      return;
    } catch (error) {
      if (isDuplicateItem(error) && attempt < 2) {
        continue;
      }
      throw new Error(
        `Failed to store password in Keychain for account "${account}": ${error instanceof Error ? error.message : error}`
      );
    }
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
  // Every concurrently running server runs this check. A fixed probe account would
  // make them collide on one item: one process's cleanup delete can land between
  // another's write and read-back, reporting a mismatch that says nothing about
  // whether the Keychain works. Scope the probe to this process instead.
  const verifyAccount = `__agent-mail-verify__${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    storePassword(KEYCHAIN_SERVICE, verifyAccount, VERIFY_VALUE);
    const readBack = getPassword(KEYCHAIN_SERVICE, verifyAccount);
    try {
      deletePassword(KEYCHAIN_SERVICE, verifyAccount);
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
