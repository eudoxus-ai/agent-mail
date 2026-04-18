import { describe, it, expect, vi } from 'vitest';
import { runStartupMigrations } from '../../src/server/startup.js';
import type { MigrationOutcome } from '../../src/provider/folder-migration.js';

describe('runStartupMigrations', () => {
  it('invokes migrate for each account and returns per-account outcomes', async () => {
    const migrate = vi.fn(async (): Promise<MigrationOutcome> => ({ action: 'noop' }));
    const pool = {
      withConnection: vi.fn(async (_: string, fn: any) => fn({} as any)),
    };
    const accounts = [{ id: 'a@x.com' } as any, { id: 'b@y.com' } as any];
    const result = await runStartupMigrations({ pool: pool as any, accounts, migrate });
    expect(migrate).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ 'a@x.com': { action: 'noop' }, 'b@y.com': { action: 'noop' } });
  });

  it('propagates each account\'s outcome', async () => {
    let counter = 0;
    const migrate = vi.fn(async (): Promise<MigrationOutcome> => {
      counter += 1;
      return counter === 1 ? { action: 'renamed' } : { action: 'copied', moved: 5 };
    });
    const pool = { withConnection: vi.fn(async (_: string, fn: any) => fn({} as any)) };
    const result = await runStartupMigrations({
      pool: pool as any,
      accounts: [{ id: 'a' } as any, { id: 'b' } as any],
      migrate,
    });
    expect(result).toEqual({ a: { action: 'renamed' }, b: { action: 'copied', moved: 5 } });
  });
});
