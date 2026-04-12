# Keychain Credential Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move email account passwords from plaintext in `accounts.yaml` to the macOS Keychain via the `security` CLI, keeping zero new npm dependencies.

**Architecture:** A new `src/provider/keychain.ts` module wraps the macOS `security` binary via `execFileSync`. The `AccountConfig` type drops its `auth` field; a new `ResolvedAccount` type extends it with credentials fetched from Keychain at the point of use. The `add-account` CLI stores passwords directly to Keychain instead of writing them to YAML.

**Tech Stack:** Node.js `child_process.execFileSync`, macOS `security` CLI, vitest

---

### Task 1: Create keychain module with tests

**Files:**
- Create: `src/provider/keychain.ts`
- Create: `test/provider/keychain.test.ts`

- [ ] **Step 1: Write the failing tests for keychain operations**

Create `test/provider/keychain.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/provider/keychain.test.ts`
Expected: FAIL — module `../../src/provider/keychain.js` does not exist

- [ ] **Step 3: Implement the keychain module**

Create `src/provider/keychain.ts`:

```typescript
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
    deletePassword(KEYCHAIN_SERVICE, VERIFY_ACCOUNT);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/provider/keychain.test.ts`
Expected: PASS — all 8 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/provider/keychain.ts test/provider/keychain.test.ts
git commit -m "feat: add keychain module for macOS credential storage"
```

---

### Task 2: Update types — remove auth from AccountConfig, add ResolvedAccount

**Files:**
- Modify: `src/types.ts:8-14`

- [ ] **Step 1: Write a type-level check that verifies the new types**

This task is a pure type change. We'll verify via the type checker after modifying. No separate test file needed — the existing test suite will confirm the types flow correctly once all tasks are done.

- [ ] **Step 2: Remove auth from AccountConfig and add ResolvedAccount**

In `src/types.ts`, replace the `AccountConfig` interface (lines 8-14) with:

```typescript
export interface AccountConfig {
  id: string;
  email: string;
  imap: { host: string; port: number; tls: boolean };
  smtp: { host: string; port: number; tls: boolean };
}

export interface ResolvedAccount extends AccountConfig {
  auth: { user: string; pass: string };
}
```

- [ ] **Step 3: Run type checker to see what breaks**

Run: `npx tsc --noEmit 2>&1 | head -50`
Expected: Multiple type errors in files that still reference `account.auth` — this is expected. We'll fix them in subsequent tasks.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts
git commit -m "refactor: remove auth from AccountConfig, add ResolvedAccount type"
```

---

### Task 3: Add resolveCredentials function with tests

**Files:**
- Create: `src/provider/credentials.ts`
- Create: `test/provider/credentials.test.ts`

- [ ] **Step 1: Write failing tests for resolveCredentials**

Create `test/provider/credentials.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/provider/credentials.test.ts`
Expected: FAIL — module `../../src/provider/credentials.js` does not exist

- [ ] **Step 3: Implement resolveCredentials**

Create `src/provider/credentials.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/provider/credentials.test.ts`
Expected: PASS — both tests pass

- [ ] **Step 5: Commit**

```bash
git add src/provider/credentials.ts test/provider/credentials.test.ts
git commit -m "feat: add resolveCredentials to bridge AccountConfig and Keychain"
```

---

### Task 4: Update IMAP and SMTP providers to use ResolvedAccount

**Files:**
- Modify: `src/provider/imap.ts:2,6,8`
- Modify: `src/provider/smtp.ts:3,5`

- [ ] **Step 1: Update ImapProvider to accept ResolvedAccount**

In `src/provider/imap.ts`, change the import on line 2:

```typescript
import type { ResolvedAccount, EmailMessage, SearchCriteria } from '../types.js';
```

Change the `account` field type on line 6:

```typescript
  private account: ResolvedAccount;
```

Change the constructor parameter on line 8:

```typescript
  constructor(account: ResolvedAccount) {
```

No other changes needed — `account.auth.user` and `account.auth.pass` still exist on `ResolvedAccount`.

- [ ] **Step 2: Update createSmtpTransport to accept ResolvedAccount**

In `src/provider/smtp.ts`, change the import on line 3:

```typescript
import type { ResolvedAccount } from '../types.js';
```

Change the function parameter on line 5:

```typescript
export function createSmtpTransport(account: ResolvedAccount): Transporter {
```

No other changes needed — `account.auth.user` and `account.auth.pass` still exist on `ResolvedAccount`.

- [ ] **Step 3: Run type checker**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: Errors in `executor.ts` and `add-account.ts` where `AccountConfig` is passed to providers — we'll fix those next.

- [ ] **Step 4: Commit**

```bash
git add src/provider/imap.ts src/provider/smtp.ts
git commit -m "refactor: update IMAP/SMTP providers to accept ResolvedAccount"
```

---

### Task 5: Update Executor to resolve credentials at point of use

**Files:**
- Modify: `src/executor/executor.ts:1-12,270-271,364,424-425`

- [ ] **Step 1: Add resolveCredentials import and update performAction**

In `src/executor/executor.ts`, add the import after line 10:

```typescript
import { resolveCredentials } from '../provider/credentials.js';
```

In `performAction` (line 270-271), change:

```typescript
    const account = getAccount(this.accounts, intent.account_id);
    const imap = new ImapProvider(account);
```

to:

```typescript
    const account = getAccount(this.accounts, intent.account_id);
    const resolved = resolveCredentials(account);
    const imap = new ImapProvider(resolved);
```

In the `queue_send` case (line 364), change:

```typescript
          const transport = createSmtpTransport(account);
```

to:

```typescript
          const transport = createSmtpTransport(resolved);
```

In `performUndo` (lines 424-425), change:

```typescript
    const account = getAccount(this.accounts, intent.account_id);
    const imap = new ImapProvider(account);
```

to:

```typescript
    const account = getAccount(this.accounts, intent.account_id);
    const resolved = resolveCredentials(account);
    const imap = new ImapProvider(resolved);
```

- [ ] **Step 2: Run type checker**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: Errors only in `add-account.ts` and test files — those are next.

- [ ] **Step 3: Commit**

```bash
git add src/executor/executor.ts
git commit -m "refactor: resolve credentials from Keychain in executor"
```

---

### Task 6: Update add-account CLI to store password in Keychain

**Files:**
- Modify: `src/cli/add-account.ts:1-2,68-85,119-124`

- [ ] **Step 1: Update the add-account flow**

In `src/cli/add-account.ts`, add the keychain import at the top (after line 1):

```typescript
import { storePassword, KEYCHAIN_SERVICE } from '../provider/keychain.js';
```

Replace the account construction block (lines 68-85) with:

```typescript
  const account: AccountConfig = {
    id: hostAnswers.accountId,
    email: answers.email,
    imap: {
      host: hostAnswers.imapHost,
      port: hostAnswers.imapPort,
      tls: true,
    },
    smtp: {
      host: hostAnswers.smtpHost,
      port: hostAnswers.smtpPort,
      tls: true,
    },
  };
```

The IMAP connection test (lines 88-102) needs a `ResolvedAccount` now. Add the import for `ResolvedAccount` to the types import, and for `ImapProvider` change the test block to pass a temporary resolved account:

Update the import on line 12:

```typescript
import type { AccountConfig, ResolvedAccount } from '../types.js';
```

Replace the IMAP test block (lines 88-102) with:

```typescript
  // Test IMAP connection
  console.log('\nTesting IMAP connection...');
  const testResolved: ResolvedAccount = {
    ...account,
    auth: { user: answers.email, pass: hostAnswers.password },
  };
  const imap = new ImapProvider(testResolved);
  try {
    await imap.connect();
    await imap.disconnect();
    console.log('IMAP connection successful!\n');
  } catch (error) {
    console.error(
      `IMAP connection failed: ${error instanceof Error ? error.message : error}`
    );
    console.error(
      'Check your host, port, and credentials. For Gmail/iCloud, use an app-specific password.'
    );
    process.exit(1);
  }
```

After the IMAP test succeeds, store the password in Keychain. Add this right after the IMAP test `try/catch` block and before the "Load or create accounts.yaml" section:

```typescript
  // Store password in Keychain
  storePassword(KEYCHAIN_SERVICE, account.id, hostAnswers.password);
  console.log(`Password stored in macOS Keychain (service: "${KEYCHAIN_SERVICE}", account: "${account.id}")`);
```

The `accounts.push(account)` and `writeFileSync` block (lines 119-124) stay as-is — they now write the `AccountConfig` without `auth`, which is exactly what we want.

- [ ] **Step 2: Run type checker**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: Errors only in test files now.

- [ ] **Step 3: Commit**

```bash
git add src/cli/add-account.ts
git commit -m "feat: store account password in Keychain during add-account"
```

---

### Task 7: Update accounts.yaml loading and tests

**Files:**
- Modify: `src/provider/accounts.ts:4,6-8`
- Modify: `test/provider/accounts.test.ts:13-19,38-39,53-54`

- [ ] **Step 1: Update loadAccounts to not expect auth in YAML**

In `src/provider/accounts.ts`, the `AccountsFile` interface (line 6-8) already references `AccountConfig[]`. Since we removed `auth` from `AccountConfig`, this will just work — YAML files with `auth` fields will have them silently ignored by the type system (JS doesn't strip extra properties), and files without `auth` will load fine.

No code change needed in `accounts.ts` itself.

- [ ] **Step 2: Update accounts test data to remove auth**

In `test/provider/accounts.test.ts`, update the YAML string in the `loadAccounts` test (lines 13-19):

```typescript
    writeFileSync(
      path,
      `accounts:
  - id: gmail
    email: test@gmail.com
    imap: { host: imap.gmail.com, port: 993, tls: true }
    smtp: { host: smtp.gmail.com, port: 587, tls: true }
`
    );
```

Update the `getAccount` test data (lines 38-39):

```typescript
  const accounts: AccountConfig[] = [
    { id: 'gmail', email: 'a@gmail.com', imap: { host: '', port: 993, tls: true }, smtp: { host: '', port: 587, tls: true } },
    { id: 'icloud', email: 'b@icloud.com', imap: { host: '', port: 993, tls: true }, smtp: { host: '', port: 587, tls: true } },
  ];
```

Update the `getDefaultAccount` test data (lines 53-54):

```typescript
  it('returns first account', () => {
    const accounts: AccountConfig[] = [
      { id: 'first', email: 'a@test.com', imap: { host: '', port: 993, tls: true }, smtp: { host: '', port: 587, tls: true } },
    ];
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `npx vitest run test/provider/accounts.test.ts`
Expected: PASS — all 7 tests pass

- [ ] **Step 4: Commit**

```bash
git add test/provider/accounts.test.ts
git commit -m "test: update accounts tests for auth-less AccountConfig"
```

---

### Task 8: Update executor and integration tests

**Files:**
- Modify: `test/executor/executor.test.ts:8,31-37`
- Modify: `test/integration/full-flow.test.ts:8,37-43`

- [ ] **Step 1: Add credentials mock to both test files**

Both test files need to mock `resolveCredentials` so it doesn't hit the real Keychain.

In `test/executor/executor.test.ts`, add after the SMTP mock (line 29):

```typescript
vi.mock('../../src/provider/credentials.js', () => ({
  resolveCredentials: vi.fn().mockImplementation((account: any) => ({
    ...account,
    auth: { user: account.email, pass: 'mock-password' },
  })),
}));
```

Remove `auth` from `testAccount` (lines 31-37):

```typescript
const testAccount: AccountConfig = {
  id: 'test',
  email: 'test@example.com',
  imap: { host: 'imap.example.com', port: 993, tls: true },
  smtp: { host: 'smtp.example.com', port: 587, tls: true },
};
```

In `test/integration/full-flow.test.ts`, add after the SMTP mock (line 35):

```typescript
vi.mock('../../src/provider/credentials.js', () => ({
  resolveCredentials: vi.fn().mockImplementation((account: any) => ({
    ...account,
    auth: { user: account.email, pass: 'mock-password' },
  })),
}));
```

Remove `auth` from `testAccount` (lines 37-43):

```typescript
const testAccount: AccountConfig = {
  id: 'gmail',
  email: 'cameron@gmail.com',
  imap: { host: 'imap.gmail.com', port: 993, tls: true },
  smtp: { host: 'smtp.gmail.com', port: 587, tls: true },
};
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: PASS — all 54 tests pass

- [ ] **Step 3: Run type checker**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add test/executor/executor.test.ts test/integration/full-flow.test.ts
git commit -m "test: mock resolveCredentials in executor and integration tests"
```

---

### Task 9: Add Keychain verification to server startup

**Files:**
- Modify: `src/server/server.ts:3,41-50`

- [ ] **Step 1: Add verifyKeychainAccess call at server startup**

In `src/server/server.ts`, add the import after line 3:

```typescript
import { verifyKeychainAccess } from '../provider/keychain.js';
```

Add the verification call right after the logger creation (after line 39, before the accounts loading):

```typescript
  // Verify Keychain access
  try {
    verifyKeychainAccess();
  } catch (error) {
    logger.error(
      `Keychain verification failed: ${error instanceof Error ? error.message : error}`
    );
    process.exit(1);
  }
```

- [ ] **Step 2: Run type checker**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run full test suite one final time**

Run: `npx vitest run`
Expected: PASS — all tests pass (server.ts is not directly unit-tested; it's covered by the integration flow)

- [ ] **Step 4: Commit**

```bash
git add src/server/server.ts
git commit -m "feat: verify Keychain access on server startup"
```

---

### Task 10: Create Keychain integration test (local-only)

**Files:**
- Create: `test/provider/keychain.integration.test.ts`

- [ ] **Step 1: Write the integration test**

Create `test/provider/keychain.integration.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the test (skipped by default)**

Run: `npx vitest run test/provider/keychain.integration.test.ts`
Expected: PASS — test is skipped (no `AGENT_MAIL_TEST_KEYCHAIN` env var)

- [ ] **Step 3: Run the test for real (optional, local only)**

Run: `AGENT_MAIL_TEST_KEYCHAIN=1 npx vitest run test/provider/keychain.integration.test.ts`
Expected: PASS — real Keychain round-trip succeeds

- [ ] **Step 4: Commit**

```bash
git add test/provider/keychain.integration.test.ts
git commit -m "test: add local-only Keychain integration test"
```

---

### Task 11: Final verification

- [ ] **Step 1: Run full type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 3: Run npm audit**

Run: `npm audit`
Expected: 0 vulnerabilities (unchanged from prior fix)

- [ ] **Step 4: Verify accounts.yaml no longer contains auth**

Manually inspect that `accounts.yaml` would no longer store `auth` fields. This is verified by the updated `add-account.ts` which constructs `AccountConfig` without `auth`.

- [ ] **Step 5: Final commit (if any remaining changes)**

If any files were missed, stage and commit them now.
