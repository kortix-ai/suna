/**
 * The single manifest runtime compiler entrypoint.
 *
 * v2 remains a compatibility input and produces the existing OpenCode-native
 * config. v3 produces an ACP launch plan without reading or translating any
 * harness-native behavior files.
 */

import {
  resolveGrantSet,
  type AgentBlockV3,
  type GrantSetV2,
  type HarnessV3,
  type ManifestV3,
  type RuntimeBlockV3,
  type WorkspaceModeV2,
} from '@kortix/manifest-schema';

import {
  compileAgentConfig,
  type OpencodeConfig,
} from './compile-agent-config';

export type RuntimeProfileLaunchPlan = {
  name: string;
  harness: HarnessV3;
  configDir: string;
};

export type LogicalAgentLaunchPlan = {
  name: string;
  runtime: string;
  harness: HarnessV3;
  nativeAgent: string | null;
  enabled: boolean;
  connectors: GrantSetV2;
  secrets: GrantSetV2;
  skills: GrantSetV2;
  kortixCli: GrantSetV2;
  workspace: WorkspaceModeV2;
};

export type AcpRuntimeLaunchPlan = {
  kind: 'acp';
  version: 3;
  defaultAgent: string;
  runtimes: Record<string, RuntimeProfileLaunchPlan>;
  agents: Record<string, LogicalAgentLaunchPlan>;
};

export type LegacyOpenCodeLaunchPlan = {
  kind: 'opencode-legacy';
  version: 2;
  config: OpencodeConfig;
};

export type CompiledRuntimeConfig = AcpRuntimeLaunchPlan | LegacyOpenCodeLaunchPlan;

const DEFAULT_CONFIG_DIR: Record<HarnessV3, string> = {
  claude: '.claude',
  codex: '.codex',
  opencode: '.kortix/opencode',
  pi: '.pi',
};

export class CompileRuntimeConfigError extends Error {}

function schemaVersion(manifest: Record<string, unknown>): number | null {
  const value = manifest.kortix_version;
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function compileRuntimeProfile(name: string, block: RuntimeBlockV3): RuntimeProfileLaunchPlan {
  return {
    name,
    harness: block.harness,
    configDir: block.config_dir?.trim() || DEFAULT_CONFIG_DIR[block.harness],
  };
}

function compileLogicalAgent(
  name: string,
  block: AgentBlockV3,
  runtimes: Record<string, RuntimeProfileLaunchPlan>,
): LogicalAgentLaunchPlan {
  const runtime = runtimes[block.runtime];
  if (!runtime) {
    throw new CompileRuntimeConfigError(
      `Agent "${name}" references unknown runtime profile "${block.runtime}".`,
    );
  }
  return {
    name,
    runtime: runtime.name,
    harness: runtime.harness,
    nativeAgent: block.agent?.trim() || null,
    enabled: block.enabled !== false,
    connectors: resolveGrantSet(block.connectors, 'none'),
    secrets: resolveGrantSet(block.secrets, 'none'),
    skills: resolveGrantSet(block.skills, 'none'),
    kortixCli: resolveGrantSet(block.kortix_cli, 'none'),
    workspace: block.workspace ?? 'runtime',
  };
}

export function compileRuntimeConfig(
  manifest: Record<string, unknown>,
  nativeAgentFiles: Record<string, string> = {},
): CompiledRuntimeConfig | null {
  const version = schemaVersion(manifest);
  if (version === 2) {
    const config = compileAgentConfig(manifest, 'opencode', nativeAgentFiles);
    return config ? { kind: 'opencode-legacy', version: 2, config } : null;
  }
  if (version !== 3) return null;

  const v3 = manifest as unknown as ManifestV3;
  const runtimes: Record<string, RuntimeProfileLaunchPlan> = {};
  for (const [name, block] of Object.entries(v3.runtimes ?? {})) {
    runtimes[name] = compileRuntimeProfile(name, block);
  }

  const agents: Record<string, LogicalAgentLaunchPlan> = {};
  for (const [name, block] of Object.entries(v3.agents ?? {})) {
    agents[name] = compileLogicalAgent(name, block, runtimes);
  }

  const defaultAgent = v3.default_agent;
  if (!agents[defaultAgent]) {
    throw new CompileRuntimeConfigError(
      `Default agent "${defaultAgent}" is not declared in the v3 agents map.`,
    );
  }
  if (!agents[defaultAgent].enabled) {
    throw new CompileRuntimeConfigError(`Default agent "${defaultAgent}" is disabled.`);
  }

  return { kind: 'acp', version: 3, defaultAgent, runtimes, agents };
}
