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
  /** Server-compiled OpenCode agent config (JSON string) for a `kortix_version:
   *  2` project — see `compile-agent-config.ts`. `null`/omitted for a v1
   *  project: no key is emitted, so v1 sandbox env is byte-for-byte unchanged. */
  compiledAgentConfig?: string | null;
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
  const fastGitBootEnv: Record<string, string> =
    allowsFullRepository && (input.fastColdBootEnabled || compiledBootEnabled) && input.freshSession
      ? {
          KORTIX_SESSION_FRESH: '1',
          ...(compiledBootEnabled ? { KORTIX_COMPILED_BOOT_MODE: compiledBootMode } : {}),
          ...(input.baseSha ? { KORTIX_BASE_SHA: input.baseSha } : {}),
          ...(input.gitDeltaBundleBase64
            ? { KORTIX_GIT_DELTA_BUNDLE_BASE64: input.gitDeltaBundleBase64 }
            : {}),
          ...(input.gitDeltaParentSha
            ? { KORTIX_GIT_DELTA_PARENT_SHA: input.gitDeltaParentSha }
            : {}),
          ...(input.gitDeltaParentCommitBase64
            ? { KORTIX_GIT_DELTA_PARENT_COMMIT_BASE64: input.gitDeltaParentCommitBase64 }
            : {}),
        }
      : {};
  const restoreGitEnv: Record<string, string> =
    allowsFullRepository && input.restoreSessionBranch
      ? { KORTIX_SESSION_BRANCH_RESTORE: '1' }
      : {};
  return {
    ...projectGitEnv,
    ...fastGitBootEnv,
    ...restoreGitEnv,
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
