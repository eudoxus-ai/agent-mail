# Keychain Credential Management

**Date**: 2026-04-12
**Status**: Approved

## Problem

Email account passwords are stored in plaintext in `~/.agent-mail/accounts.yaml`. While the file has `0o600` permissions and data stays local, plaintext passwords on disk are poor security hygiene.

## Decision

Use the macOS `security` CLI to store and retrieve passwords from the user's login Keychain. Zero new npm dependencies. The login keychain auto-unlocks at login, so no interactive approval is needed during normal server operation.

## Scope

- macOS only
- No migration command — users re-run `add-account`
- Fail with a clear error if credentials are missing from Keychain

## Design

### Keychain module (`src/provider/keychain.ts`)

Three functions wrapping the `security` CLI via `execFileSync` (not `exec`, to avoid shell injection):

- **`storePassword(service, account, password)`** — `security add-generic-password -U -s <service> -a <account> -w <password>`
- **`getPassword(service, account)`** — `security find-generic-password -s <service> -a <account> -w` (the `-w` flag outputs just the password)
- **`deletePassword(service, account)`** — `security delete-generic-password -s <service> -a <account>`

The service name is the constant `"agent-mail"`. The account name is the account `id` (e.g. `"gmail"`). Users can inspect entries in Keychain Access.app by searching for "agent-mail".

A **`verifyKeychainAccess()`** function runs at server startup. It stores a known test value, reads it back, verifies it matches, and deletes it. If any step fails, it throws: `"Keychain integration check failed: <specific step>. The macOS 'security' CLI may have changed. Please file an issue."`

### Type changes

Remove `auth` from `AccountConfig`:

```typescript
export interface AccountConfig {
  id: string;
  email: string;
  imap: { host: string; port: number; tls: boolean };
  smtp: { host: string; port: number; tls: boolean };
}
```

Add a resolved type for use at the IMAP/SMTP connection boundary:

```typescript
export interface ResolvedAccount extends AccountConfig {
  auth: { user: string; pass: string };
}
```

A `resolveCredentials(account: AccountConfig): ResolvedAccount` function calls `getPassword("agent-mail", account.id)` for the password and uses `account.email` as the auth user. This is the single point where Keychain is accessed from application code.

If the lookup fails: `"No credentials found for account '<id>'. Run 'agent-mail add-account' to set up."` This flows back through the MCP tool response so Claude Desktop can report it.

### `accounts.yaml` changes

The file stores only connection metadata — no secrets:

```yaml
accounts:
  - id: gmail
    email: user@gmail.com
    imap: { host: imap.gmail.com, port: 993, tls: true }
    smtp: { host: smtp.gmail.com, port: 587, tls: true }
```

### `add-account` flow changes

After the user types their password and the IMAP connection test passes, the password is stored via `storePassword("agent-mail", accountId, password)` instead of being written to `accounts.yaml`. Everything else about the flow stays the same.

### Executor and provider changes

- `Executor` still receives `AccountConfig[]` (no credentials at construction time)
- In `performAction()`, before creating an IMAP/SMTP connection, it calls `resolveCredentials(account)` to get a `ResolvedAccount`
- `ImapProvider` constructor and `createSmtpTransport` change their parameter type from `AccountConfig` to `ResolvedAccount`

Passwords are fetched from Keychain per-action rather than held in memory for the server lifetime.

### Testing strategy

**Unit tests (CI):**
- `keychain.ts` — mock `execFileSync`, verify correct `security` arguments and error handling
- `resolveCredentials` — mock keychain module, verify `ResolvedAccount` construction and missing-credential error

**Integration test (local only, gated by `AGENT_MAIL_TEST_KEYCHAIN=1`):**
- Real round-trip: store, read-back, assert match, delete, assert gone
- This catches Apple changing the `security` CLI behavior

**Existing tests:**
- Executor and integration tests already mock IMAP/SMTP providers. Update mock types from `AccountConfig` to `ResolvedAccount`.
