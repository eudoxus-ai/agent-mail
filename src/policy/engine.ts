import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { POLICY_YAML_PATH } from '../config.js';
import { DEFAULT_POLICY_YAML } from './defaults.js';
import type { PolicyConfig, PolicyResult, ToolPolicy, GateType, RiskLevel } from '../types.js';

export function loadPolicy(policyPath: string = POLICY_YAML_PATH): PolicyConfig {
  try {
    const content = readFileSync(policyPath, 'utf-8');
    return yaml.load(content) as PolicyConfig;
  } catch {
    return yaml.load(DEFAULT_POLICY_YAML) as PolicyConfig;
  }
}

export interface PolicyContext {
  threadHasReplies?: boolean;
}

export function evaluatePolicy(
  policy: PolicyConfig,
  toolName: string,
  context?: PolicyContext
): PolicyResult {
  const toolPolicy = policy.tools[toolName] as ToolPolicy | undefined;

  if (!toolPolicy) {
    // Unknown tool defaults to gated for safety
    return { decision: 'gate', risk: 'high', reason: 'Unknown tool, gating by default' };
  }

  const risk = toolPolicy.risk;
  const gate: GateType = toolPolicy.gate;

  if (gate === 'ungated') {
    return { decision: 'execute', risk, reason: 'Policy: ungated' };
  }

  if (gate === 'always_gated') {
    return { decision: 'gate', risk, reason: 'Policy: always gated' };
  }

  // gate === 'configurable'
  const defaultGate = toolPolicy.default ?? 'ungated';
  const overrides = toolPolicy.override ?? {};

  // Check each override condition
  for (const [condition, result] of Object.entries(overrides)) {
    if (condition === 'when_thread_has_replies' && context?.threadHasReplies) {
      if (result === 'approval_required') {
        return { decision: 'gate', risk, reason: `Override: ${condition}` };
      }
    }
  }

  // No override triggered, use default
  if (defaultGate === 'approval_required') {
    return { decision: 'gate', risk, reason: 'Policy: configurable, default gated' };
  }

  return { decision: 'execute', risk, reason: 'Policy: configurable, default ungated' };
}
