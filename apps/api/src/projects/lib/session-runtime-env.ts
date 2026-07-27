import { isAgiAgentName } from '../agents';

/**
 * `KORTIX_PROJECT_AUTO_CLONE` for one session: `'0'` for the platform AGI,
 * `'1'` for everything else.
 *
 * This is what makes R-36 ("the AGI MUST NOT require a checkout to start")
 * literally true rather than aspirational. Boot AWAITS `materializeRepo`, which
 * runs only `if (cfg.autoClone)` (sandbox daemon main.ts:162), and health's
 * `repoRequired = sessionWantsRepo(cfg.autoClone)` (routes/health.ts:88) — so
 * with auto-clone off `repo_ready` is immediate and `runtimeReady` gates on the
 * opencode spawn alone. Flipping this flag, not any daemon change, is what
 * removes the clone from the AGI's boot critical path. It is honored by
 * already-baked daemons because they read it from env at boot; no image rebake.
 *
 * Two things a clone-less boot must NOT lose, both verified to be independent
 * of `autoClone`:
 *
 *  - The AGI's behavior arrives via `KORTIX_COMPILED_AGENT_CONFIG`, read from
 *    ENV (opencode.ts:127), not from the repo's `.kortix/opencode` config dir.
 *    `resolveOpencodeConfigDir` falls back to the baked default dir, which is
 *    exactly right for an agent that has no manifest entry.
 *  - `configureGitCredentialHelper` runs BEFORE the clone and regardless of
 *    `autoClone` (main.ts:115), so the AGI's later lazy `kortix projects clone`
 *    / `git push` still authenticates against the project remote.
 *
 * The AGI is not repo-less, only checkout-less: when it needs to write it
 * clones on demand and lands the change through a change request (R-9.6). See
 * the "How you change the repo" section of its behavior file.
 */
export function sessionAutoCloneFlag(agentName: string): '0' | '1' {
  return isAgiAgentName(agentName) ? '0' : '1';
}

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
  /** The wrapper's opaque end-user this backend session acts for (Kortix-as-a-
   *  Backend). Surfaced to the sandbox as KORTIX_ORIGIN_REF so the agent knows
   *  WHO it's acting for — attribution only, never an auth principal. Null/absent
   *  for non-backend sessions → no key emitted. */
  originRef?: string | null;
  /** Server-compiled OpenCode agent config (JSON string) for a `kortix_version:
   *  2` project — see `compile-agent-config.ts`. `null`/omitted for a v1
   *  project: no key is emitted, so v1 sandbox env is byte-for-byte unchanged. */
  compiledAgentConfig?: string | null;
}

export function buildSessionRuntimeEnv(input: SessionRuntimeEnvInput): Record<string, string> {
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
    // Both names carry the same value: KORTIX_END_USER_REF is the name, and
    // KORTIX_ORIGIN_REF stays set because agent code inside sandboxes may
    // already read it and we cannot migrate other people's code.
    ...(input.originRef
      ? { KORTIX_END_USER_REF: input.originRef, KORTIX_ORIGIN_REF: input.originRef }
      : {}),
    KORTIX_API_URL: input.apiUrl,
    // Frontend base for user-facing dashboard links — the agent/CLI must never
    // surface KORTIX_API_URL (the API host) to a human. See sandboxFrontendBaseUrl().
    ...(input.frontendUrl ? { KORTIX_FRONTEND_URL: input.frontendUrl } : {}),
    // The sandbox daemon owns OpenCode root creation for every cold session.
    // The API adopts/persists that root; it must not create a competing one.
    KORTIX_BOOTSTRAP_OPENCODE_SESSION: '1',
    ...(input.initialPrompt ? { KORTIX_INITIAL_PROMPT: input.initialPrompt } : {}),
    ...(input.opencodeModel ? { KORTIX_OPENCODE_MODEL: input.opencodeModel } : {}),
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
