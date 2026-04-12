import type { AccountConfig, ResolvedAccount } from '../types.js';
import { getPassword, KEYCHAIN_SERVICE } from './keychain.js';

export function resolveCredentials(account: AccountConfig): ResolvedAccount {
  const password = getPassword(KEYCHAIN_SERVICE, account.id);
  if (password === null) {
    throw new Error(
      `No credentials found for account "${account.id}". Run "agent-mail add-account" to set up.`
    );
  }
  return {
    ...account,
    auth: { user: account.email, pass: password },
  };
}
