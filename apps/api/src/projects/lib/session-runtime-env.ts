import type { WorkspaceModeV2 } from '@kortix/manifest-schema';
import { agentConfigEtag } from './compile-agent-config';
import { workspaceModeAllowsFullRepository } from './session-sandbox-metadata';

export interface SessionRuntimeEnvInput {
  projectId: string;
  sessionId: string;
  repoUrl: string;
  baseRef: string;
  agentName: string;
  apiUrl: string;
  /** Frontend base URL (no /v1) the sandbox surfaces as user-facing links. */
  frontendUrl?: string;
  opencodeModel?: string | null;
  /** Project file delivery mode selected by the session's agent. */
  workspaceMode?: WorkspaceModeV2 | null;
  /** Enables the rollback-safe fresh-session Git fast path. */
  fastColdBootEnabled?: boolean;
  /** Experimental compiled checkout and OpenCode launcher rollout mode. */
  compiledBootMode?: 'off' | 'shadow' | 'prefer' | 'required';
  /** True only for a newly-created session branch that still equals base. */
  freshSession?: boolean;
  /** Replacement runtime must fetch the existing remote session branch once. */
  restoreSessionBranch?: boolean;
  /** Server-resolved base tip used to validate the image-baked scaffold. */
  baseSha?: string;
  /** Bounded Git bundle containing the exact base-tip commit above the baked scaffold. */
  gitDeltaBundleBase64?: string;
  /** Exact parent commit required by the thin Git bundle. */
  gitDeltaParentSha?: string;
  /** Raw parent commit object. Its tree already exists in the baked scaffold. */
  gitDeltaParentCommitBase64?: string;
  /** Delta too large for the env: daemon downloads it with one authenticated GET. */
  gitDeltaBundleRemote?: boolean;
  /**
   * OpenCode config dir at `baseSha` (repo-relative), `null` when the tip ships
   * none, undefined when unknown. The daemon spawns OpenCode on it BEFORE the
   * checkout exists and only falls back to the serial boot without a hint.
   */
  opencodeConfigDir?: string | null;
  /** Server-compiled OpenCode agent config (JSON string) for a `kortix_version:
   *  2` project — see `compile-agent-config.ts`. `null`/omitted for a v1
   *  project: no key is emitted, so v1 sandbox env is byte-for-byte unchanged. */
  compiledAgentConfig?: string | null;
}

/**
 * The sandbox audit relay's emission contract
 * (apps/kortix-sandbox-agent-server/src/opencode-audit-relay.ts) is read from
 * the SANDBOX environment. A self-host operator can set these in compose; a
 * hosted sandbox has no such file, so the API forwards its own values when an
 * operator sets them. Only these four names cross, and only when non-empty —
 * an unset knob leaves the sandbox env byte-for-byte unchanged.
 *
 * This is the lever that retunes audit POST volume during an incident without
 * a daemon release.
 */
const AUDIT_RELAY_ENV_KEYS = [
  'KORTIX_AUDIT_RELAY_BATCH_SIZE',
  'KORTIX_AUDIT_RELAY_FLUSH_MS',
  'KORTIX_AUDIT_RELAY_DROP_TYPES',
  'KORTIX_AUDIT_RELAY_COALESCE',
] as const;

export function auditRelayEnvPassthrough(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const key of AUDIT_RELAY_ENV_KEYS) {
    const value = env[key];
    // `KORTIX_AUDIT_RELAY_DROP_TYPES=''` is a MEANINGFUL value (drop nothing),
    // so only an absent variable is skipped.
    if (typeof value === 'string') forwarded[key] = value;
  }
  return forwarded;
}

export function buildSessionRuntimeEnv(input: SessionRuntimeEnvInput): Record<string, string> {
  const allowsFullRepository = workspaceModeAllowsFullRepository(input.workspaceMode);
  const compiledBootMode = input.compiledBootMode ?? 'off';
  const compiledBootEnabled = compiledBootMode !== 'off';
  const projectGitEnv: Record<string, string> = allowsFullRepository
    ? {
        KORTIX_REPO_URL: input.repoUrl,
        KORTIX_DEFAULT_BRANCH: input.baseRef,
        KORTIX_BASE_REF: input.baseRef,
        KORTIX_BRANCH_NAME: input.sessionId,
      }
    : {};
  // A brand-new session's branch IS the base tip: the daemon creates it
  // locally and materializes from the baked scaffold + the API's delta, so no
  // in-sandbox `git fetch` runs at all. This used to hide behind the
  // fast-cold-boot / compiled-boot experiments; measured 2026-08-27 on dev,
  // the two proxied fetches it removes cost 5.4 s + 2.6 s of a 7.9 s
  // `repo-materialized`, measured on dev 2026-08-27.
  const fastGitBootEnv: Record<string, string> =
    allowsFullRepository && input.freshSession
      ? {
          KORTIX_SESSION_FRESH: '1',
          ...(compiledBootEnabled ? { KORTIX_COMPILED_BOOT_MODE: compiledBootMode } : {}),
          ...(input.baseSha ? { KORTIX_BASE_SHA: input.baseSha } : {}),
          ...(input.gitDeltaBundleBase64
            ? { KORTIX_GIT_DELTA_BUNDLE_BASE64: input.gitDeltaBundleBase64 }
            : {}),
          ...(input.gitDeltaBundleRemote ? { KORTIX_GIT_DELTA_BUNDLE_REMOTE: '1' } : {}),
          ...(input.gitDeltaParentSha
            ? { KORTIX_GIT_DELTA_PARENT_SHA: input.gitDeltaParentSha }
            : {}),
          ...(input.gitDeltaParentCommitBase64
            ? { KORTIX_GIT_DELTA_PARENT_COMMIT_BASE64: input.gitDeltaParentCommitBase64 }
            : {}),
        }
      : {};
  // Known for fresh sessions only (resolved at the same tip as the clone).
  // '' = "this revision has no project OpenCode config"; the daemon then
  // spawns on its baked default dir without waiting for the checkout.
  const opencodeConfigDirHintEnv: Record<string, string> =
    allowsFullRepository && input.freshSession && input.opencodeConfigDir !== undefined
      ? { KORTIX_OPENCODE_CONFIG_DIR_HINT: input.opencodeConfigDir ?? '' }
      : {};
  const restoreGitEnv: Record<string, string> =
    allowsFullRepository && input.restoreSessionBranch
      ? { KORTIX_SESSION_BRANCH_RESTORE: '1' }
      : {};
  return {
    ...projectGitEnv,
    ...fastGitBootEnv,
    ...opencodeConfigDirHintEnv,
    ...restoreGitEnv,
    ...auditRelayEnvPassthrough(),
    ...(input.fastColdBootEnabled ? { KORTIX_OPENCODE_BINARY_PREFETCH: '1' } : {}),
    KORTIX_PROJECT_ID: input.projectId,
    KORTIX_SESSION_ID: input.sessionId,
    KORTIX_SERVICE_PORT: '8000',
    KORTIX_AGENT_NAME: input.agentName,
    KORTIX_API_URL: input.apiUrl,
    KORTIX_PROJECT_AUTO_CLONE: allowsFullRepository ? '1' : '0',
    ...(input.workspaceMode ? { KORTIX_WORKSPACE_MODE: input.workspaceMode } : {}),
    // Frontend base for user-facing dashboard links — the agent/CLI must never
    // surface KORTIX_API_URL (the API host) to a human. See sandboxFrontendBaseUrl().
    ...(input.frontendUrl ? { KORTIX_FRONTEND_URL: input.frontendUrl } : {}),
    // The sandbox daemon owns OpenCode root creation for every cold session.
    // The API adopts/persists that root; it must not create a competing one.
    KORTIX_BOOTSTRAP_OPENCODE_SESSION: '1',
    ...(input.opencodeModel ? { KORTIX_OPENCODE_MODEL: input.opencodeModel } : {}),
    // The sandbox daemon merges this as the BASE of its own composed opencode
    // config (connector MCP / gateway provider / Slack overlays still apply on
    // top — see apps/kortix-sandbox-agent-server/src/opencode.ts). Per-call
    // The resolved session model (KORTIX_OPENCODE_MODEL above), or an explicit
    // model on a prompt request, still wins over this compiled fallback.
    ...(input.compiledAgentConfig
      ? {
          KORTIX_COMPILED_AGENT_CONFIG: input.compiledAgentConfig,
          // Content hash of the line above, echoed by the daemon's /kortix/health.
          // It is what makes "is this session running the latest config?" a
          // question anyone can answer — the box reports what it actually
          // spawned with, rather than the API guessing from what it last sent.
          KORTIX_COMPILED_AGENT_CONFIG_ETAG: agentConfigEtag(input.compiledAgentConfig) ?? '',
        }
      : {}),
  };
}

/**
 * The minimal env for a pi worker boot. The per-commit compiled artifact
 * already carries the agent map (its etag is what /kortix/health reports), the
 * v0 worker receives no project secrets (the gateway resolves BYOK server-side
 * per request), and nothing clones — so none of buildSessionRuntimeEnv's
 * git/scaffold work and none of buildSessionSandboxEnvVars' secret work
 * applies. Synchronous on purpose: this map must never put a network read on
 * the provision critical path (the OpenCode env chain it replaces cost
 * 1.1–2.4 s per cold boot, measured on dev 2026-08-27).
 *
 * KORTIX_TOKEN and KORTIX_LLM_BASE_URL are injected by
 * provisionSessionSandbox(); KORTIX_PI_RUNTIME_REF/SHA are threaded by the
 * session-create call; KORTIX_API_URL/KORTIX_FRONTEND_URL are also guaranteed
 * at the provider boundary (daytona.ts) — set here too so the map is
 * self-sufficient.
 */
export function buildPiWorkerSessionEnvVars(input: {
  projectId: string;
  sessionId: string;
  agentName: string;
  apiUrl: string;
  frontendUrl?: string;
  opencodeModel?: string | null;
}): Record<string, string> {
  return {
    KORTIX_PROJECT_ID: input.projectId,
    KORTIX_SESSION_ID: input.sessionId,
    KORTIX_SERVICE_PORT: '8000',
    // Both names: KORTIX_AGENT_NAME is the fleet convention (daemon,
    // dashboards); KORTIX_AGENT is what the worker's baked-config overlay
    // reads to select a non-default agent (apps/kortix-worker/src/main.ts).
    KORTIX_AGENT_NAME: input.agentName,
    KORTIX_AGENT: input.agentName,
    KORTIX_API_URL: input.apiUrl,
    ...(input.frontendUrl ? { KORTIX_FRONTEND_URL: input.frontendUrl } : {}),
    // No repo checkout exists on a worker box.
    KORTIX_PROJECT_AUTO_CLONE: '0',
    // The worker defaults to its scripted `faux` provider when this is unset
    // (`KORTIX_MODEL_MODE ?? 'faux'`, apps/kortix-worker/src/worker.ts). That
    // default belongs to the benchmarks, which measure infrastructure with no
    // credentials — a REAL session that inherits it answers every prompt with
    // an empty assistant turn and no error anywhere, which reads as "pi never
    // replies". A session is always real; only a bench opts into faux.
    KORTIX_MODEL_MODE: 'real',
    // P1.8 — the durable transcript log is NOT activated yet. The server side
    // (kortix.session_worker_log + the /log routes) is live and inert; setting
    // KORTIX_STORE_URL here is what turns it on. Every session that booted with
    // it set died before listening (sandbox_url 502, engine never reported), and
    // guarding the store open did not fix it — so the cause is upstream of the
    // store and is not yet isolated. Left off until a session is PROVEN to boot
    // with it, because an unbootable session is worse than a non-durable one.
    // The resolved session model override. The worker maps it onto the
    // gateway exactly like a baked model ref (env wins over bake). Absent, the
    // compiled artifact's own baked model is used — which is why this stays
    // conditional and must not fall back to the platform resolution.
    ...(input.opencodeModel ? { KORTIX_MODEL: input.opencodeModel } : {}),
  };
}
