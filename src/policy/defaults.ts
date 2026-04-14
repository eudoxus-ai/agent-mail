import { existsSync, writeFileSync } from 'node:fs';
import { POLICY_YAML_PATH } from '../config.js';

export const DEFAULT_POLICY_YAML = `# agent-mail policy configuration
# Risk levels: none, low, medium, high
# Gate types: ungated, configurable, always_gated

tools:
  search_threads:      { risk: none, gate: ungated }
  read_thread:         { risk: none, gate: ungated }
  get_overview:        { risk: none, gate: ungated }
  draft_reply:         { risk: low, gate: ungated }
  label_thread:        { risk: low, gate: ungated }
  get_pending_actions: { risk: none, gate: ungated }
  get_audit_log:       { risk: none, gate: ungated }
  undo_intent:         { risk: low, gate: ungated }

  unsubscribe_sender:
    risk: low
    gate: ungated
    note: "HTTP List-Unsubscribe only. Mailto-based unsubscribes route through queue_send."

  quarantine_thread:
    risk: medium
    gate: configurable
    default: ungated
    override:
      when_thread_has_replies: approval_required

  queue_send:
    risk: high
    gate: always_gated
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
