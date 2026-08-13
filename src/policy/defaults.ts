import { existsSync, writeFileSync } from 'node:fs';
import { POLICY_YAML_PATH } from '../config.js';

export const DEFAULT_POLICY_YAML = `# agent-mail policy configuration
# Risk levels: none, low, medium, high
# Gate types: ungated, configurable, always_gated
# reversible: whether the action can be undone (defaults to false)

tools:
  search_threads:      { risk: none, gate: ungated, reversible: false }
  list_senders:        { risk: none, gate: ungated, reversible: false }
  list_mailboxes:      { risk: none, gate: ungated, reversible: false }
  read_thread:         { risk: none, gate: ungated, reversible: false }
  # Reading is risk: none elsewhere, but this one writes a file to disk.
  # Set gate: configurable if you want approval before attachments are saved.
  get_attachment:      { risk: low, gate: ungated, reversible: false }
  get_overview:        { risk: none, gate: ungated, reversible: false }
  draft_reply:         { risk: low, gate: ungated, reversible: false }
  label_thread:        { risk: low, gate: ungated, reversible: true }
  get_pending_actions: { risk: none, gate: ungated, reversible: false }
  get_audit_log:       { risk: none, gate: ungated, reversible: false }
  get_intent:          { risk: none, gate: ungated, reversible: false }
  get_scan_result:     { risk: none, gate: ungated, reversible: false }
  get_diagnostics:     { risk: none, gate: ungated, reversible: false }
  undo_intent:         { risk: low, gate: ungated, reversible: false }

  unsubscribe_sender:
    risk: low
    gate: ungated
    reversible: false
    note: "HTTP List-Unsubscribe only. Mailto-based unsubscribes route through queue_send."

  hold_messages:
    risk: medium
    gate: configurable
    default: ungated
    reversible: true
    override:
      when_thread_has_replies: approval_required

  hold_by_sender:
    risk: medium
    gate: configurable
    default: ungated
    reversible: true
    override:
      when_thread_has_replies: approval_required

  restore_messages:
    risk: low
    gate: configurable
    default: ungated
    reversible: true

  queue_send:
    risk: high
    gate: always_gated
    reversible: false
    auto_approve_after: null

notifications:
  channels:
    - type: system_notification
      enabled: true
`;

export function writeDefaultPolicy(path: string = POLICY_YAML_PATH): void {
  if (!existsSync(path)) {
    writeFileSync(path, DEFAULT_POLICY_YAML, { mode: 0o600 });
  }
}
