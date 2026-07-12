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
  runtimeModel?: string | null;
  /** Discriminated v2 compatibility config or v3 ACP launch plan. */
  compiledRuntimeConfig?: CompiledRuntimeConfig | null;
}

export function buildSessionRuntimeEnv(input: SessionRuntimeEnvInput): Record<string, string> {
  const compiled = input.compiledRuntimeConfig;
  const acpAgent = compiled?.kind === 'acp' ? compiled.agents[input.agentName] : null;
  if (compiled?.kind === 'acp' && (!acpAgent || !acpAgent.enabled)) {
    throw new Error(`ACP agent "${input.agentName}" is not declared and enabled in kortix.yaml`);
  }

  return {
    KORTIX_REPO_URL: input.repoUrl,
    KORTIX_DEFAULT_BRANCH: input.baseRef,
    KORTIX_BASE_REF: input.baseRef,
    KORTIX_BRANCH_NAME: input.sessionId,
    KORTIX_PROJECT_ID: input.projectId,
    KORTIX_SESSION_ID: input.sessionId,
    KORTIX_SERVICE_PORT: '8000',
    KORTIX_AGENT_NAME: input.agentName,
    KORTIX_API_URL: input.apiUrl,
    // Frontend base for user-facing dashboard links — the agent/CLI must never
    // surface KORTIX_API_URL (the API host) to a human. See sandboxFrontendBaseUrl().
    ...(input.frontendUrl ? { KORTIX_FRONTEND_URL: input.frontendUrl } : {}),
    // V1/v2 compatibility keeps the old root bootstrap. V3 is ACP-native and
    // must never create a parallel OpenCode HTTP session.
    ...(!compiled ? { KORTIX_BOOTSTRAP_OPENCODE_SESSION: '1' } : {}),
    ...(input.initialPrompt ? { KORTIX_INITIAL_PROMPT: input.initialPrompt } : {}),
    ...(input.runtimeModel && !compiled
      ? { KORTIX_OPENCODE_MODEL: input.runtimeModel }
      : {}),
    // The sandbox daemon merges this as the BASE of its own composed opencode
    // config (executor MCP / gateway provider / Slack overlays still apply on
    // top — see apps/kortix-sandbox-agent-server/src/opencode.ts). Per-call
    // model overrides (KORTIX_OPENCODE_MODEL above, or an explicit model on a
    // prompt request) still win over whatever default model this bakes in —
    // this only sets the manifest agent's/DEFAULT agent's fallback.
    ...(compiled?.kind === 'acp'
      ? {
          KORTIX_COMPILED_RUNTIME_PLAN: JSON.stringify(compiled),
          KORTIX_RUNTIME_NAME: acpAgent!.runtime,
          KORTIX_RUNTIME_HARNESS: acpAgent!.harness,
          KORTIX_RUNTIME_CONFIG_DIR: compiled.runtimes[acpAgent!.runtime].configDir,
          ...(acpAgent!.nativeAgent ? { KORTIX_NATIVE_AGENT: acpAgent!.nativeAgent } : {}),
        }
      : {}),
  };
}
