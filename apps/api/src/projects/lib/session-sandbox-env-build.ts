import { config } from '../../config';

import { piPackageBundleForSession } from '../../pi-packages/bundle';

import { SECRET_CAPABILITIES_ENV_NAME } from '../secret-capabilities';
import { RESERVED_SANDBOX_ENV_NAMES, isReservedSandboxEnvName } from './sandbox-env-names';
import { deriveKortixApiRoot, proxyGitUrl } from './serializers';

export { proxyGitUrl };

import { buildSessionRuntimeContextEnv } from './session-runtime-context';
import { buildSessionRuntimeEnv } from './session-runtime-env';
import { sandboxFrontendBaseUrl } from '../../platform/sandbox-frontend-url';

import {
  buildSessionChannelEnv,
  buildSessionRuntimeSecrets,
  resolveSessionAgentEnvContext,
  resolveSessionSandboxHarness,
  resolveSessionSecretsPrincipal,
} from './session-sandbox-env-sources';

export { RESERVED_SANDBOX_ENV_NAMES, isReservedSandboxEnvName };

export type SessionSandboxEnvInput = {
  accountId: string;
  projectId: string;
  sessionId: string;
  userId: string;
  repoUrl: string;
  baseRef: string;
  agentName: string;
  opencodeModel?: string | null;
  /** Resolved per-project `llm_gateway` feature flag. Gateway ON →
   *  opencode is locked to the gateway and native provider keys are withheld;
   *  OFF (default) → native BYOK providers must reach opencode, so the deny
   *  list is empty. Mirrors the conditional KORTIX_LLM_* injection at provision. */
  llmGatewayEnabled: boolean;
  /** New session (brand-new branch == base, no remote commits). Lets the
   *  daemon create the session branch LOCALLY instead of a redundant network
   *  fetch of a branch that's identical to base — that fetch cost up to ~10s
   *  through the dev tunnel (2026-06-13). Restart/resume omit it (their branch
   *  may carry the agent's pushed commits → real fetch needed). */
  freshSession?: boolean;
  /** Replacement runtime must fetch the existing remote session branch once. */
  restoreSessionBranch?: boolean;
  /** The project's base-branch tip SHA, resolved from the API's Git mirror. */
  baseSha?: string;
  /** Bounded exact commit delta from the API mirror. The daemon imports it on
   *  top of the baked scaffold and verifies `baseSha` before use. */
  gitDeltaBundleBase64?: string;
  /** Parent commit SHA required by the thin delta bundle. */
  gitDeltaParentSha?: string;
  /** Raw parent commit object used when the provider changed only commit metadata. */
  gitDeltaParentCommitBase64?: string;
  /** The delta exceeds the env cap; the daemon downloads it with one GET. */
  gitDeltaBundleRemote?: boolean;
  /** S3 config provider mode + prepared-archive pin — see session-runtime-env.ts. */
  projectSnapshotMode?: 'git' | 'prefer-s3' | 'require-s3';
  projectSnapshotPin?: string | null;
  projectSnapshotDescriptor?: string | null;
  /** Project git context, so the running agent's `secrets` grant in `agents:`
   *  can be resolved and applied by IDENTIFIER — secrets the agent isn't
   *  granted are dropped from the injected env (a prompt-injected agent then
   *  can't read another scope's keys out of $ENV). Optional: when absent, the
   *  grant defaults to 'all' (back-compat, no narrowing). */
  defaultBranch?: string;
  manifestPath?: string;
  /** The reserved platform coordinator receives no project checkout or secrets. */
  platformMetaAgent?: boolean;
  repositoryAccess?: boolean;
};

export async function buildSessionSandboxEnvVars(
  input: SessionSandboxEnvInput,
): Promise<Record<string, string>> {
  const { compiledAgentConfig, agentGrantEnv, manifestHarness, manifestPackages } =
    await resolveSessionAgentEnvContext(input);
  const harness = await resolveSessionSandboxHarness(input, manifestHarness);
  // The prebuilt bundle of the project's pi packages (one S3 HEAD + presign; none without npm packages).
  const piPackagesBundle =
    harness === 'pi' && manifestPackages.length > 0
      ? await piPackageBundleForSession(manifestPackages, { projectId: input.projectId, sessionId: input.sessionId })
      : null;
  const { grantEnvForSession, secretsPrincipalUserId, sessionPolicyMetadata } =
    await resolveSessionSecretsPrincipal(input, agentGrantEnv);
  const { runtimeSecrets, opencodeModel } = await buildSessionRuntimeSecrets(input, {
    agentGrantEnv,
    grantEnvForSession,
    secretsPrincipalUserId,
    sessionPolicyMetadata,
  });
  // Restore the session's channel binding on EVERY (re)provision. A session
  // created from a chat channel (e.g. Slack) persists its binding in
  // metadata.slack; the in-box relay gates turn-end/answer on SLACK_THREAD_TS /
  // SLACK_CHANNEL_ID, so a box rebuilt from scratch (archived → cold-reprovision)
  // must get these back or the resurrected agent can't talk to its thread. The
  // session is the durable source of truth; the first boot got these via
  // extraEnvVars, every later rebuild gets them here.
  const channelEnv = await buildSessionChannelEnv(input.sessionId);
  const sessionContextEnv = await buildSessionRuntimeContextEnv(input.sessionId);
  return {
    ...runtimeSecrets.env,
    // Fleet default for the `kortix-connectors` OpenCode MCP server. Set here
    // rather than in the daemon so it is one operator switch
    // (CONNECTORS_MCP_ENABLED) instead of a rebuilt sandbox image.
    //
    // Written BEFORE channelEnv on purpose: the email channel sets this same
    // variable from durable session metadata (session-channel-env.ts), and it
    // must stay authoritative. Spreading it after means switching the fleet
    // default OFF cannot strip the MCP face from an email session that depends
    // on it — the operator switch withdraws the default, never a channel's
    // explicit contract.
    ...(config.CONNECTORS_MCP_ENABLED ? { KORTIX_CONNECTORS_MCP_ENABLED: '1' } : {}),
    ...channelEnv,
    ...sessionContextEnv,
    KORTIX_PROJECT_SECRET_NAMES: runtimeSecrets.names.join(','),
    KORTIX_PROJECT_SECRETS_REVISION: runtimeSecrets.revision,
    [SECRET_CAPABILITIES_ENV_NAME]: runtimeSecrets.capabilitiesJson,
    // No partial-clone filter. Blobless (`blob:none`) defers file blobs to
    // on-demand fetches, which stall through the Kortix git proxy when its
    // partial-clone capability isn't advertised consistently — the clone then
    // never finishes and the session never reaches runtimeReady. It is also
    // simply slower: measured on kortix-ai/company, blobless 6161ms vs a full
    // clone's 4288ms.
    //
    // Shallowness is the safe lever instead (KORTIX_CLONE_DEPTH=1, the daemon
    // default): one pack, one commit, no on-demand fetches, with history
    // restored in the background right after boot (scheduleHistoryBackfill).
    // It is worth ~1.5x on the clone, no more — the dominant cost is the
    // working tree plus the transatlantic git-proxy hop (sandbox US → API
    // eu-west-2 → GitHub US).
    KORTIX_CLONE_FILTER: '',
    ...buildSessionRuntimeEnv({
      projectId: input.projectId,
      sessionId: input.sessionId,
      // Every sandbox clones through the Kortix Git proxy with KORTIX_TOKEN.
      // Direct upstream origins are never delivered to the guest because they
      // require exposing a provider credential to the sandbox.
      repoUrl: proxyGitUrl(input.projectId),
      baseRef: input.baseRef,
      agentName: input.agentName,
      apiUrl: deriveKortixApiBase(),
      frontendUrl: sandboxFrontendBaseUrl(),
      // Concrete session model after explicit → agent → project → account →
      // platform resolution — re-pointed above when the runtime lineup
      // retired it. The sandbox uses it for the first OpenCode turn and as
      // the session's OpenCode config default.
      opencodeModel,
      compiledAgentConfig,
      harness,
      piPackages: manifestPackages,
      piPackagesBundle,
      repositoryAccess: input.repositoryAccess,
      freshSession: input.freshSession,
      restoreSessionBranch: input.restoreSessionBranch,
      baseSha: input.baseSha,
      gitDeltaBundleBase64: input.gitDeltaBundleBase64,
      gitDeltaParentSha: input.gitDeltaParentSha,
      gitDeltaParentCommitBase64: input.gitDeltaParentCommitBase64,
      gitDeltaBundleRemote: input.gitDeltaBundleRemote,
      projectSnapshotMode: input.projectSnapshotMode,
      projectSnapshotPin: input.projectSnapshotPin,
      projectSnapshotDescriptor: input.projectSnapshotDescriptor,
    }),
    // The platform coordinator uses API-level delegation and never receives a
    // project checkout. Keep this override after buildSessionRuntimeEnv so the
    // agent workspace mode cannot re-enable the daemon's automatic clone.
    ...(input.platformMetaAgent
      ? { KORTIX_PROJECT_AUTO_CLONE: '0', KORTIX_META_AGENT: '1' }
      : {}),
  };
}

/** Derive the API v1 base URL sandboxes call as `$KORTIX_API_URL`. */
export function deriveKortixApiBase(): string {
  return `${deriveKortixApiRoot(config.KORTIX_URL)}/v1`;
}
