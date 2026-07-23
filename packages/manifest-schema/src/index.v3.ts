/**
 * `kortix_version: 3` — ACP-first runtime profiles and logical agents.
 *
 * Kortix owns registration, routing, and governance. Native harness config
 * owns prompts, models, providers, hooks, modes, and permissions. The
 * compiler consumes this shape to produce a launch plan; it never translates
 * one harness's behavior format into another.
 */

import type { HarnessId } from '@kortix/shared';
import { SLUG_RE, V3_HARNESS_VALUES, WORKSPACE_MODES_V2 } from './constants';
import { isTable, type ManifestIssue, validateGrantList } from './index';
import type { GrantSetV2, WorkspaceModeV2 } from './index.v2';

/** Alias of the canonical `@kortix/shared` harness id — kept as a distinct
 * name here since v3 manifest types reference `HarnessV3` throughout. */
export type HarnessV3 = HarnessId;

export interface RuntimeBlockV3 {
  harness: HarnessV3;
  /** Repo-relative native harness config directory. */
  config_dir?: string;
}

export interface AgentBlockV3 {
  /** Name of a key in the top-level `runtimes` map. */
  runtime: string;
  /** Optional harness-native agent/profile identifier. */
  agent?: string;
  enabled?: boolean;
  connectors?: GrantSetV2;
  secrets?: GrantSetV2;
  skills?: GrantSetV2;
  kortix_cli?: GrantSetV2;
  workspace?: WorkspaceModeV2;
}

export interface ManifestV3 {
  kortix_version: 3;
  default_agent: string;
  runtimes: Record<string, RuntimeBlockV3>;
  agents: Record<string, AgentBlockV3>;
  project?: Record<string, unknown>;
  env?: Record<string, unknown>;
  sandbox?: Record<string, unknown>;
  triggers?: Array<Record<string, unknown>>;
  connectors?: Array<Record<string, unknown>>;
  apps?: Array<Record<string, unknown>>;
}

export interface RuntimesV3Scan {
  names: string[];
  harnessByName: Record<string, HarnessV3>;
}

export interface AgentsV3Scan {
  names: string[];
  disabledNames: string[];
  runtimeRefs: Array<{ agentName: string; runtimeName: string; hasNativeAgent: boolean }>;
}

function validateRelativePath(value: unknown, path: string, issues: ManifestIssue[]): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({ path, message: 'must be a non-empty repo-relative path.', severity: 'error' });
    return;
  }
  const normalized = value.trim().replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    issues.push({ path, message: 'must stay inside the project repository.', severity: 'error' });
  }
}

export function validateRuntimesV3(
  node: unknown,
  path: string,
  issues: ManifestIssue[],
): RuntimesV3Scan {
  const names: string[] = [];
  const harnessByName: Record<string, HarnessV3> = {};
  if (!isTable(node) || Object.keys(node).length === 0) {
    issues.push({
      path,
      message: 'kortix_version 3 manifests must declare at least one runtime profile.',
      severity: 'error',
    });
    return { names, harnessByName };
  }

  for (const [name, raw] of Object.entries(node)) {
    const where = `${path}.${name}`;
    if (!SLUG_RE.test(name)) {
      issues.push({
        path: where,
        message: `"${name}" is not a valid runtime name (lowercase letters, digits, dashes, underscores).`,
        severity: 'error',
      });
    } else {
      names.push(name);
    }
    if (!isTable(raw)) {
      issues.push({ path: where, message: 'must be a table/object.', severity: 'error' });
      continue;
    }
    const harness = typeof raw.harness === 'string' ? raw.harness.trim() : '';
    if (!(V3_HARNESS_VALUES as readonly string[]).includes(harness)) {
      issues.push({
        path: `${where}.harness`,
        message: `harness must be one of: ${V3_HARNESS_VALUES.join(', ')} (got ${JSON.stringify(raw.harness)}).`,
        severity: 'error',
      });
    } else if (SLUG_RE.test(name)) {
      harnessByName[name] = harness as HarnessV3;
    }
    validateRelativePath(raw.config_dir, `${where}.config_dir`, issues);
    for (const key of Object.keys(raw)) {
      if (!['harness', 'config_dir'].includes(key)) {
        issues.push({
          path: `${where}.${key}`,
          message: `Unknown runtime field "${key}". Native behavior belongs in the harness config directory.`,
          severity: 'error',
        });
      }
    }
  }
  return { names, harnessByName };
}

export function validateAgentsV3(
  node: unknown,
  path: string,
  issues: ManifestIssue[],
): AgentsV3Scan {
  const names: string[] = [];
  const disabledNames: string[] = [];
  const runtimeRefs: Array<{ agentName: string; runtimeName: string; hasNativeAgent: boolean }> = [];
  if (!isTable(node) || Object.keys(node).length === 0) {
    issues.push({
      path,
      message: 'kortix_version 3 manifests must declare at least one logical agent.',
      severity: 'error',
    });
    return { names, disabledNames, runtimeRefs };
  }

  for (const [name, raw] of Object.entries(node)) {
    const where = `${path}.${name}`;
    if (!SLUG_RE.test(name)) {
      issues.push({
        path: where,
        message: `"${name}" is not a valid agent name (lowercase letters, digits, dashes, underscores).`,
        severity: 'error',
      });
    } else {
      names.push(name);
    }
    if (!isTable(raw)) {
      issues.push({ path: where, message: 'must be a table/object.', severity: 'error' });
      continue;
    }

    const runtimeName = typeof raw.runtime === 'string' ? raw.runtime.trim() : '';
    if (!runtimeName) {
      issues.push({ path: `${where}.runtime`, message: 'runtime is required.', severity: 'error' });
    } else {
      runtimeRefs.push({ agentName: name, runtimeName, hasNativeAgent: typeof raw.agent === 'string' && raw.agent.trim() !== '' });
    }
    if (raw.agent !== undefined && (typeof raw.agent !== 'string' || raw.agent.trim() === '')) {
      issues.push({
        path: `${where}.agent`,
        message: 'agent must be a non-empty harness-native identifier when provided.',
        severity: 'error',
      });
    }
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
      issues.push({ path: `${where}.enabled`, message: 'must be a boolean.', severity: 'error' });
    }
    if (raw.enabled === false) disabledNames.push(name);
    validateGrantList(raw.connectors, `${where}.connectors`, 'connectors', issues, false, 3);
    validateGrantList(raw.secrets, `${where}.secrets`, 'secrets', issues, false, 3);
    validateGrantList(raw.skills, `${where}.skills`, 'skills', issues, false, 3);
    validateGrantList(raw.kortix_cli, `${where}.kortix_cli`, 'kortix_cli', issues, true, 3);

    if (raw.workspace !== undefined) {
      const workspace = typeof raw.workspace === 'string' ? raw.workspace.trim() : '';
      if (!(WORKSPACE_MODES_V2 as readonly string[]).includes(workspace)) {
        issues.push({
          path: `${where}.workspace`,
          message: `workspace must be one of: ${WORKSPACE_MODES_V2.join(', ')}.`,
          severity: 'error',
        });
      }
    }

    const allowed = new Set([
      'runtime',
      'agent',
      'enabled',
      'connectors',
      'secrets',
      'skills',
      'kortix_cli',
      'workspace',
    ]);
    for (const key of Object.keys(raw)) {
      if (!allowed.has(key)) {
        issues.push({
          path: `${where}.${key}`,
          message: `Unknown logical-agent field "${key}". Prompts, models, providers, modes, and permissions belong to the native harness config.`,
          severity: 'error',
        });
      }
    }
  }
  return { names, disabledNames, runtimeRefs };
}

export function validateManifestCrossRefsV3(
  defaultAgent: unknown,
  agents: AgentsV3Scan,
  runtimes: RuntimesV3Scan,
  issues: ManifestIssue[],
): void {
  if (typeof defaultAgent !== 'string' || defaultAgent.trim() === '') {
    issues.push({ path: 'default_agent', message: 'default_agent is required.', severity: 'error' });
  } else if (!agents.names.includes(defaultAgent.trim())) {
    issues.push({
      path: 'default_agent',
      message: `default_agent "${defaultAgent}" does not match a declared logical agent.`,
      severity: 'error',
    });
  } else if (agents.disabledNames.includes(defaultAgent.trim())) {
    issues.push({ path: 'default_agent', message: 'default_agent cannot be disabled.', severity: 'error' });
  }

  for (const ref of agents.runtimeRefs) {
    if (!runtimes.names.includes(ref.runtimeName)) {
      issues.push({
        path: `agents.${ref.agentName}.runtime`,
        message: `runtime "${ref.runtimeName}" does not match a declared runtime profile.`,
        severity: 'error',
      });
    }
  }
}
