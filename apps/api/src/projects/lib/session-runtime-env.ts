import { HARNESSES, isHarnessId } from '@kortix/shared/harnesses';

import type { CompiledRuntimeConfig } from './compile-runtime-config';

export interface SessionRuntimeEnvInput {
  projectId: string;
  sessionId: string;
  repoUrl: string;
  baseRef: string;
  agentName: string;
  apiUrl: string;
  /** Frontend base URL (no /v1) the sandbox surfaces as user-facing links. */
  frontendUrl?: string;
  initialPrompt?: string | null;
  opencodeModel?: string | null;
  opencodeProcessTransport: 'acp' | 'rest';
  /** Server-compiled OpenCode agent config (JSON string) for a `kortix_version:
   *  2` project — see `compile-agent-config.ts`. `null`/omitted for a v1
   *  project: no key is emitted, so v1 sandbox env is byte-for-byte unchanged. */
  compiledAgentConfig?: string | null;
  /** Runtime-neutral v2/v3 launch plan. */
  compiledRuntimeConfig?: CompiledRuntimeConfig | null;
  /** Provider-neutral model selected for the runtime. */
  runtimeModel?: string | null;
}

export function shouldResolvePlatformDefaultModel(
  acpRuntimeEnabled: boolean,
  harness: string | null | undefined,
): boolean {
  if (!acpRuntimeEnabled) return true;
  return !isHarnessId(harness) || !HARNESSES[harness].ownsDefaultModel;
}

export function runtimeModelForHarness(
  model: string | null | undefined,
  harness: string | null | undefined,
): string | null {
  const trimmed = model?.trim();
  if (!trimmed) return null;
  if (isHarnessId(harness) && HARNESSES[harness].modelNamespacing === 'gateway-prefixed') {
    return trimmed;
  }
  return trimmed.replace(/^kortix\//, '');
}

export function buildSessionRuntimeEnv(input: SessionRuntimeEnvInput): Record<string, string> {
  const compiled = input.compiledRuntimeConfig;
  const selected =
    compiled?.agents[input.agentName] ??
    (input.agentName === 'default' ? compiled?.agents[compiled.defaultAgent] : undefined) ??
    null;
  if (compiled?.version === 3 && (!selected || !selected.enabled)) {
    throw new Error(`ACP agent "${input.agentName}" is not declared and enabled in kortix.yaml`);
  }
  const selectedRuntime = selected ? compiled?.runtimes[selected.runtime] : undefined;
  if (compiled && selected && !selectedRuntime) {
    throw new Error(
      `ACP agent "${input.agentName}" references unknown runtime profile "${selected.runtime}"`,
    );
  }
  const harness = selected?.harness ?? 'opencode';
  const runtimeModel = runtimeModelForHarness(input.runtimeModel ?? input.opencodeModel, harness);
  const bootstrapOpenCode = !compiled || harness === 'opencode';

  return {
    KORTIX_REPO_URL: input.repoUrl,
    KORTIX_DEFAULT_BRANCH: input.baseRef,
    KORTIX_BASE_REF: input.baseRef,
    KORTIX_BRANCH_NAME: input.sessionId,
    KORTIX_PROJECT_ID: input.projectId,
    KORTIX_SESSION_ID: input.sessionId,
    KORTIX_SERVICE_PORT: '8000',
    KORTIX_AGENT_NAME: input.agentName,
    KORTIX_OPENCODE_PROCESS_TRANSPORT: input.opencodeProcessTransport,
    KORTIX_API_URL: input.apiUrl,
    // Frontend base for user-facing dashboard links — the agent/CLI must never
    // surface KORTIX_API_URL (the API host) to a human. See sandboxFrontendBaseUrl().
    ...(input.frontendUrl ? { KORTIX_FRONTEND_URL: input.frontendUrl } : {}),
    // The sandbox daemon owns OpenCode root creation for every cold session.
    // The API adopts/persists that root; it must not create a competing one.
    ...(bootstrapOpenCode ? { KORTIX_BOOTSTRAP_OPENCODE_SESSION: '1' } : {}),
    ...(input.initialPrompt ? { KORTIX_INITIAL_PROMPT: input.initialPrompt } : {}),
    ...(input.opencodeModel ? { KORTIX_OPENCODE_MODEL: input.opencodeModel } : {}),
    ...(compiled && selected && selectedRuntime
      ? {
          KORTIX_COMPILED_RUNTIME_PLAN: JSON.stringify(compiled),
          KORTIX_ACP_SERVER_ID: input.sessionId,
          KORTIX_RUNTIME_NAME: selected.runtime,
          KORTIX_RUNTIME_HARNESS: selected.harness,
          KORTIX_RUNTIME_CONFIG_DIR: selectedRuntime.configDir,
          ...(runtimeModel ? { KORTIX_RUNTIME_MODEL: runtimeModel } : {}),
          ...(selected.nativeAgent ? { KORTIX_NATIVE_AGENT: selected.nativeAgent } : {}),
        }
      : {}),
    // The sandbox daemon merges this as the BASE of its own composed opencode
    // config (executor MCP / gateway provider / Slack overlays still apply on
    // top — see apps/kortix-sandbox-agent-server/src/opencode.ts). Per-call
    // The resolved session model (KORTIX_OPENCODE_MODEL above), or an explicit
    // model on a prompt request, still wins over this compiled fallback.
    ...(input.compiledAgentConfig
      ? { KORTIX_COMPILED_AGENT_CONFIG: input.compiledAgentConfig }
      : {}),
  };
}
