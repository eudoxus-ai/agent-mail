import type { ImapConnectionPool } from '../provider/imap-pool.js';
import type { ImapProvider } from '../provider/imap.js';

export interface FanOutResult<T> {
  accounts_searched: string[];
  per_account: Record<string, T>;
  errors: Record<string, string>;
}

export async function fanOut<T>(opts: {
  pool: ImapConnectionPool;
  accountIds: string[];
  fn: (accountId: string, imap: ImapProvider) => Promise<T>;
}): Promise<FanOutResult<T>> {
  const { pool, accountIds, fn } = opts;

  const settled = await Promise.allSettled(
    accountIds.map(async (accountId) => ({
      accountId,
      value: await pool.withConnection(accountId, (imap) => fn(accountId, imap)),
    }))
  );

  const per_account: Record<string, T> = {};
  const errors: Record<string, string> = {};

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    const accountId = accountIds[i];
    if (outcome.status === 'fulfilled') {
      per_account[outcome.value.accountId] = outcome.value.value;
    } else {
      errors[accountId] =
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason);
    }
  }

  return {
    accounts_searched: [...accountIds],
    per_account,
    errors,
  };
}
