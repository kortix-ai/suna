/**
 * The single manifest runtime compiler entrypoint.
 *
 * Both v2 and v3 produce an ACP launch plan. V2 is mapped to one OpenCode ACP
 * runtime so existing projects keep their native files without reviving the
 * removed OpenCode HTTP session protocol.
 */

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
} from "@kortix/manifest-schema";

import { readManifestFromRepo } from "../git/files";
import type { GitBackedProject } from "../git/types";

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
  kind: "acp";
  version: 2 | 3;
  defaultAgent: string;
  runtimes: Record<string, RuntimeProfileLaunchPlan>;
  agents: Record<string, LogicalAgentLaunchPlan>;
};

export type CompiledRuntimeConfig = AcpRuntimeLaunchPlan;

const DEFAULT_CONFIG_DIR: Record<HarnessV3, string> = {
  claude: ".claude",
  codex: ".codex",
  opencode: ".kortix/opencode",
  pi: ".pi",
};

export class CompileRuntimeConfigError extends Error {}

/**
 * Legacy/OpenCode compatibility plan: projects with no manifest, a v1
 * manifest, or a v2 manifest that never declared `agents:` still run — as one
 * fully-granted OpenCode runtime whose native config owns all behavior
 * (exactly the pre-ACP contract). `nativeAgent` stays null so OpenCode
 * resolves its own configured default agent.
 */
export function syntheticLegacyRuntimeConfig(
  configDir: string = DEFAULT_CONFIG_DIR.opencode,
): CompiledRuntimeConfig {
  const runtimeName = "opencode";
  return {
    kind: "acp",
    version: 2,
    defaultAgent: "kortix",
    runtimes: {
      [runtimeName]: { name: runtimeName, harness: "opencode", configDir },
    },
    agents: {
      kortix: {
        name: "kortix",
        runtime: runtimeName,
        harness: "opencode",
        nativeAgent: null,
        enabled: true,
        connectors: "all",
        secrets: "all",
        skills: "all",
        kortixCli: "all",
        workspace: "runtime",
      },
    },
  };
}

function schemaVersion(manifest: Record<string, unknown>): number | null {
  const value = manifest.kortix_version;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function compileRuntimeProfile(
  name: string,
  block: RuntimeBlockV3,
): RuntimeProfileLaunchPlan {
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
    connectors: resolveGrantSet(block.connectors, "none"),
    secrets: resolveGrantSet(block.secrets, "none"),
    skills: resolveGrantSet(block.skills, "none"),
    kortixCli: resolveGrantSet(block.kortix_cli, "none"),
    workspace: block.workspace ?? "runtime",
  };
}

export function compileRuntimeConfig(
  manifest: Record<string, unknown>,
  _nativeAgentFiles: Record<string, string> = {},
): CompiledRuntimeConfig | null {
  const version = schemaVersion(manifest);
  if (version === 2) {
    const runtimeName = "opencode";
    const configDir =
      typeof (manifest.opencode as Record<string, unknown> | undefined)
        ?.config_dir === "string"
        ? String((manifest.opencode as Record<string, unknown>).config_dir)
        : DEFAULT_CONFIG_DIR.opencode;
    const runtimes = {
      [runtimeName]: {
        name: runtimeName,
        harness: "opencode" as const,
        configDir,
      },
    };
    const rawAgents =
      manifest.agents &&
      typeof manifest.agents === "object" &&
      !Array.isArray(manifest.agents)
        ? (manifest.agents as Record<string, Record<string, unknown>>)
        : {};
    const agents: Record<string, LogicalAgentLaunchPlan> = {};
    for (const [name, block] of Object.entries(rawAgents)) {
      agents[name] = {
        name,
        runtime: runtimeName,
        harness: "opencode",
        nativeAgent: name,
        enabled: block.enabled !== false,
        connectors: resolveGrantSet(block.connectors as never, "none"),
        secrets: resolveGrantSet(block.secrets as never, "none"),
        skills: resolveGrantSet(block.skills as never, "none"),
        kortixCli: resolveGrantSet(block.kortix_cli as never, "none"),
        workspace:
          (block.workspace as WorkspaceModeV2 | undefined) ?? "runtime",
      };
    }
    // A v2 project that never adopted the `agents:` map keeps the legacy
    // contract: one fully-granted OpenCode runtime, native config in charge.
    if (Object.keys(agents).length === 0) {
      return syntheticLegacyRuntimeConfig(configDir);
    }
    const declaredDefault =
      typeof manifest.default_agent === "string"
        ? manifest.default_agent
        : "kortix";
    // No usable default_agent: fall back to the first enabled agent instead of
    // refusing to compile (mirrors resolveGovernedAgentGrant's sentinel rule).
    const defaultAgent =
      agents[declaredDefault]?.enabled
        ? declaredDefault
        : Object.keys(agents).find((name) => agents[name].enabled);
    if (!defaultAgent) {
      throw new CompileRuntimeConfigError(
        `Default agent "${declaredDefault}" is not declared and enabled.`,
      );
    }
    return { kind: "acp", version: 2, defaultAgent, runtimes, agents };
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
    throw new CompileRuntimeConfigError(
      `Default agent "${defaultAgent}" is disabled.`,
    );
  }

  return { kind: "acp", version: 3, defaultAgent, runtimes, agents };
}

/**
 * Read and compile the runtime contract for a session directly from the
 * project's git source of truth. Native behavior files are never translated;
 * the selected ACP adapter reads its harness-native config directory directly.
 */
export async function resolveCompiledRuntimeConfigForSession(
  project: GitBackedProject,
): Promise<CompiledRuntimeConfig | null> {
  try {
    const candidates = manifestCandidatePaths(project.manifestPath).map(
      (candidate) => candidate.path,
    );
    const found = await readManifestFromRepo(
      project,
      candidates,
      project.defaultBranch,
    );
    // No manifest or a pre-v2 one: legacy OpenCode project — synthesize the
    // compatibility plan so it still boots instead of failing "not declared".
    if (!found) return syntheticLegacyRuntimeConfig();

    const raw = parseManifestText(
      found.content,
      manifestFormatForPath(found.path),
    );
    const version = schemaVersion(raw);
    if (version !== 2 && version !== 3) return syntheticLegacyRuntimeConfig();

    return compileRuntimeConfig(raw);
  } catch (error) {
    console.warn(
      `[compile-runtime-config] project ${project.projectId}: compile failed: ${(error as Error).message}`,
    );
    return null;
  }
}
