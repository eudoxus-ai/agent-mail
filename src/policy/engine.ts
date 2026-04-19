import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { POLICY_YAML_PATH } from '../config.js';
import { DEFAULT_POLICY_YAML } from './defaults.js';
import type { PolicyConfig, PolicyResult, ToolPolicy, GateType, RiskLevel } from '../types.js';

export function loadPolicy(policyPath: string = POLICY_YAML_PATH): PolicyConfig {
  const defaults = parsePolicyConfig(yaml.load(DEFAULT_POLICY_YAML));
  try {
    const content = readFileSync(policyPath, 'utf-8');
    const user = parsePolicyConfig(yaml.load(content));
    // Layer user policy over defaults so new shipped tools get sensible
    // entries without forcing users to edit their policy.yaml.
    return {
      ...defaults,
      ...user,
      tools: { ...defaults.tools, ...user.tools },
    };
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return defaults;
    }
    throw error;
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
    return {
      decision: 'gate',
      risk: 'high',
      reason: `Tool "${toolName}" has no policy entry; gating conservatively. Add it to policy.yaml to configure.`,
      reversible: false,
      unknownTool: true,
    };
  }

  const risk = toolPolicy.risk;
  const gate: GateType = toolPolicy.gate;
  const reversible = toolPolicy.reversible ?? false;

  if (gate === 'ungated') {
    return { decision: 'execute', risk, reason: 'Policy: ungated', reversible };
  }

  if (gate === 'always_gated') {
    return { decision: 'gate', risk, reason: 'Policy: always gated', reversible };
  }

  // gate === 'configurable'
  const defaultGate = toolPolicy.default ?? 'ungated';
  const overrides = toolPolicy.override ?? {};

  // Check each override condition
  for (const [condition, result] of Object.entries(overrides)) {
    if (condition === 'when_thread_has_replies' && context?.threadHasReplies) {
      if (result === 'approval_required') {
        return { decision: 'gate', risk, reason: `Override: ${condition}`, reversible };
      }
    }
  }

  // No override triggered, use default
  if (defaultGate === 'approval_required') {
    return { decision: 'gate', risk, reason: 'Policy: configurable, default gated', reversible };
  }

  return { decision: 'execute', risk, reason: 'Policy: configurable, default ungated', reversible };
}

function parsePolicyConfig(raw: unknown): PolicyConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid policy.yaml: expected a YAML object');
  }

  const policy = raw as PolicyConfig;
  if (!policy.tools || typeof policy.tools !== 'object') {
    throw new Error('Invalid policy.yaml: missing "tools" map');
  }

  for (const [toolName, toolPolicy] of Object.entries(policy.tools)) {
    if (!toolPolicy || typeof toolPolicy !== 'object') {
      throw new Error(`Invalid policy.yaml: tool "${toolName}" must be an object`);
    }

    const risk = (toolPolicy as { risk?: RiskLevel }).risk;
    const gate = (toolPolicy as { gate?: GateType }).gate;
    if (!['none', 'low', 'medium', 'high'].includes(risk ?? '')) {
      throw new Error(`Invalid policy.yaml: tool "${toolName}" has invalid risk`);
    }
    if (!['ungated', 'configurable', 'always_gated'].includes(gate ?? '')) {
      throw new Error(`Invalid policy.yaml: tool "${toolName}" has invalid gate`);
    }

    if (gate === 'configurable') {
      const defaultVal = (toolPolicy as ToolPolicy).default;
      if (
        defaultVal !== undefined &&
        !['ungated', 'approval_required'].includes(defaultVal)
      ) {
        throw new Error(
          `Invalid policy.yaml: tool "${toolName}" has invalid default "${defaultVal}"`
        );
      }

      const overrides = (toolPolicy as ToolPolicy).override;
      if (overrides !== undefined) {
        if (typeof overrides !== 'object' || Array.isArray(overrides)) {
          throw new Error(
            `Invalid policy.yaml: tool "${toolName}" override must be an object`
          );
        }
        for (const [condition, result] of Object.entries(overrides)) {
          if (!['ungated', 'approval_required'].includes(result as string)) {
            throw new Error(
              `Invalid policy.yaml: tool "${toolName}" override condition "${condition}" has invalid value "${result as string}"`
            );
          }
        }
      }
    }
  }

  return policy;
}
