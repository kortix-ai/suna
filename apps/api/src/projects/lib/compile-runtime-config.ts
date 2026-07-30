import {
  manifestCandidatePaths,
  manifestFormatForPath,
  parseManifestText,
  resolveGrantSet,
  type AgentBlockV3,
  type GrantSetV2,
  type HarnessV3,
  type ManifestV3,
  type RuntimeBlockV3,
  type WorkspaceModeV2,
} from '@kortix/manifest-schema';
import { HARNESSES } from '@kortix/shared/harnesses';

import { readManifestFromRepo, type GitBackedProject } from '../git';

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

export type CompiledRuntimeConfig = {
  kind: 'acp';
  version: 2 | 3;
  defaultAgent: string;
  runtimes: Record<string, RuntimeProfileLaunchPlan>;
  agents: Record<string, LogicalAgentLaunchPlan>;
};

export class CompileRuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompileRuntimeConfigError';
  }
}

export function syntheticLegacyRuntimeConfig(
  configDir = HARNESSES.opencode.configDir,
): CompiledRuntimeConfig {
  return {
    kind: 'acp',
    version: 2,
    defaultAgent: 'kortix',
    runtimes: {
      opencode: {
        name: 'opencode',
        harness: 'opencode',
        configDir,
      },
    },
    agents: {
      kortix: {
        name: 'kortix',
        runtime: 'opencode',
        harness: 'opencode',
        nativeAgent: null,
        enabled: true,
        connectors: 'all',
        secrets: 'all',
        skills: 'all',
        kortixCli: 'all',
        workspace: 'runtime',
      },
    },
  };
}

function schemaVersion(manifest: Record<string, unknown>): number | null {
  const value = manifest.kortix_version;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

function compileRuntimeProfile(name: string, block: RuntimeBlockV3): RuntimeProfileLaunchPlan {
  return {
    name,
    harness: block.harness,
    configDir: block.config_dir?.trim() || HARNESSES[block.harness].configDir,
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
): CompiledRuntimeConfig | null {
  const version = schemaVersion(manifest);
  if (version === 2) {
    const opencode = manifest.opencode;
    const configDir =
      opencode && typeof opencode === 'object' && !Array.isArray(opencode)
        ? (opencode as Record<string, unknown>).config_dir
        : null;
    const runtimeConfigDir =
      typeof configDir === 'string' && configDir.trim()
        ? configDir.trim()
        : HARNESSES.opencode.configDir;
    const runtimes = {
      opencode: {
        name: 'opencode',
        harness: 'opencode' as const,
        configDir: runtimeConfigDir,
      },
    };
    const rawAgents =
      manifest.agents && typeof manifest.agents === 'object' && !Array.isArray(manifest.agents)
        ? (manifest.agents as Record<string, Record<string, unknown>>)
        : {};
    const agents: Record<string, LogicalAgentLaunchPlan> = {};
    for (const [name, block] of Object.entries(rawAgents)) {
      agents[name] = {
        name,
        runtime: 'opencode',
        harness: 'opencode',
        nativeAgent: name,
        enabled: block.enabled !== false,
        connectors: resolveGrantSet(block.connectors as never, 'none'),
        secrets: resolveGrantSet(block.secrets as never, 'none'),
        skills: resolveGrantSet(block.skills as never, 'none'),
        kortixCli: resolveGrantSet(block.kortix_cli as never, 'none'),
        workspace: (block.workspace as WorkspaceModeV2 | undefined) ?? 'runtime',
      };
    }
    if (Object.keys(agents).length === 0) {
      return syntheticLegacyRuntimeConfig(runtimeConfigDir);
    }
    const declared = typeof manifest.default_agent === 'string' ? manifest.default_agent : 'kortix';
    const defaultAgent = agents[declared]?.enabled
      ? declared
      : Object.keys(agents).find((name) => agents[name]?.enabled);
    if (!defaultAgent) {
      throw new CompileRuntimeConfigError(
        `Default agent "${declared}" is not declared and enabled.`,
      );
    }
    return { kind: 'acp', version: 2, defaultAgent, runtimes, agents };
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

export async function resolveCompiledRuntimeConfigForSession(
  project: GitBackedProject,
): Promise<CompiledRuntimeConfig | null> {
  try {
    const found = await readManifestFromRepo(
      project,
      manifestCandidatePaths(project.manifestPath).map((candidate) => candidate.path),
      project.defaultBranch,
    );
    if (!found) return syntheticLegacyRuntimeConfig();
    const raw = parseManifestText(found.content, manifestFormatForPath(found.path));
    const version = schemaVersion(raw);
    if (version !== 2 && version !== 3) return syntheticLegacyRuntimeConfig();
    return compileRuntimeConfig(raw);
  } catch (error) {
    console.warn(
      `[compile-runtime-config] project ${project.projectId}: ${(error as Error).message}`,
    );
    return null;
  }
}
