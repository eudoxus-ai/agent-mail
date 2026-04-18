export interface MigrationImap {
  mailboxExists(name: string): Promise<boolean>;
  renameMailbox(from: string, to: string): Promise<void>;
  ensureMailbox(name: string): Promise<void>;
  listMessageUids(mailbox: string): Promise<number[]>;
  moveMessages(uids: number[], from: string, to: string): Promise<void>;
  deleteMailbox(name: string): Promise<void>;
}

export type MigrationOutcome =
  | { action: 'noop' }
  | { action: 'renamed' }
  | { action: 'copied'; moved: number };

const OLD = 'agent-mail-quarantine';
const NEW = 'agent-mail-holding';

export async function migrateHoldingFolder(imap: MigrationImap): Promise<MigrationOutcome> {
  if (await imap.mailboxExists(NEW)) return { action: 'noop' };
  if (!(await imap.mailboxExists(OLD))) return { action: 'noop' };
  try {
    await imap.renameMailbox(OLD, NEW);
    return { action: 'renamed' };
  } catch {
    await imap.ensureMailbox(NEW);
    const uids = await imap.listMessageUids(OLD);
    if (uids.length > 0) await imap.moveMessages(uids, OLD, NEW);
    await imap.deleteMailbox(OLD);
    return { action: 'copied', moved: uids.length };
  }
}
