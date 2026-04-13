import type { Database } from './ledger/sqlite.js';
import type { ImapFlow } from 'imapflow';
import type { Transporter } from 'nodemailer';
import type { Logger } from './logger.js';

// === Account ===

export interface AccountConfig {
  id: string;
  email: string;
  imap: { host: string; port: number; tls: boolean };
  smtp: { host: string; port: number; tls: boolean };
}

export interface ResolvedAccount extends AccountConfig {
  auth: { user: string; pass: string };
}

// === Risk and gating ===

export type RiskLevel = 'none' | 'low' | 'medium' | 'high';
export type GateType = 'ungated' | 'configurable' | 'always_gated';
export type IntentStatus =
  | 'pending'
  | 'approved'
  | 'executing'
  | 'executed'
  | 'rejected'
  | 'failed'
  | 'undone';

// === Intent ===

export interface Intent {
  id: string;
  account_id: string;
  tool: string;
  params: Record<string, unknown>;
  risk: RiskLevel;
  status: IntentStatus;
  error_detail: Record<string, unknown> | null;
  agent_id: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  undo_token: string | null;
  undo_expires_at: string | null;
}

// === Audit ===

export type AuditAction =
  | 'created'
  | 'approved'
  | 'rejected'
  | 'executing'
  | 'executed'
  | 'failed'
  | 'undone';

export interface AuditEntry {
  id: number;
  intent_id: string;
  account_id: string | null;
  action: AuditAction;
  actor: string;
  detail: Record<string, unknown> | null;
  created_at: string;
}

// === Policy ===

export type PolicyDecision = 'execute' | 'gate';

export interface PolicyResult {
  decision: PolicyDecision;
  risk: RiskLevel;
  reason: string;
}

export interface ToolPolicy {
  risk: RiskLevel;
  gate: GateType;
  default?: 'ungated' | 'approval_required';
  override?: Record<string, 'approval_required' | 'ungated'>;
  note?: string;
  auto_approve_after?: number | null;
}

export interface PolicyConfig {
  tools: Record<string, ToolPolicy | { risk: RiskLevel; gate: GateType }>;
  notifications?: { channels: Array<{ type: string; enabled: boolean }> };
}

// === Tool registration ===

export interface ToolContext {
  accountId: string;
  agentId: string;
  db: Database;
  accounts: AccountConfig[];
  logger: Logger;
}

export interface ToolResult {
  type: 'immediate' | 'gated';
  content?: Array<{ type: 'text'; text: string }>;
  intentId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: import('zod').ZodObject<any>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  execute: (
    params: Record<string, unknown>,
    context: ToolContext
  ) => Promise<ToolResult>;
}

// === Email ===

export interface Participant {
  address: string; // lowercased, trimmed
  name: string | null;
}

export interface EmailMessage {
  uid: number;
  messageId: string;
  from: Participant;
  to: Participant[];
  cc: Participant[];
  date: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  inReplyTo?: string;
  references: string[];
  flags: string[];
  listUnsubscribe?: string;
  mailbox: string;
}

export interface EmailThread {
  threadId: string;
  accountId: string;
  subject: string;
  participants: Participant[];
  messageCount: number;
  messages: EmailMessage[];
}

export interface ThreadSnippet {
  threadId: string;
  accountId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  messageCount: number;
  flags: string[];
}

// === IMAP search ===

export interface SearchCriteria {
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  since?: Date;
  before?: Date;
  flagged?: boolean;
  seen?: boolean;
  mailbox?: string;
}
