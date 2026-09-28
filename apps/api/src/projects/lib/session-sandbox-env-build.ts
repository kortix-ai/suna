
import { projectSessions, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';





import { config } from '../../config';











import { sandboxFrontendBaseUrl } from '../../platform/sandbox-frontend-url';





import { db } from '../../shared/db';





import { resolveSessionSecretGrant } from './secret-grant';

import { AmbiguousSecretGrantError, intersectSecretGrants, listProjectSecretsSnapshotForUser } from '../secrets';
import { SECRET_CAPABILITIES_ENV_NAME } from '../secret-capabilities';
import { piPackageBundleForSession } from '../../pi-packages/bundle';
import { manifestPiPackages, manifestRuntime, resolveCompiledAgentConfigForSession, resolveSelectedAgentConfigForSession, selectSessionHarness } from './compile-agent-config';




import { RESERVED_SANDBOX_ENV_NAMES, isReservedSandboxEnvName } from './sandbox-env-names';
import { deriveKortixApiRoot } from './serializers';



import { sessionChannelEnvFromMetadata } from './session-channel-env';







import { buildSessionRuntimeContextEnv } from './session-runtime-context';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { buildSessionRuntimeEnv } from './session-runtime-env';
import { buildPlatformMetaOpenCodeConfig } from './platform-meta-agent';

import { resolveSessionPersonalOwner } from './personal-resources';


export { RESERVED_SANDBOX_ENV_NAMES, isReservedSandboxEnvName };

/** Re-derive persisted channel env so every cold reprovision restores it. */
async function buildSessionChannelEnv(sessionId: string): Promise<Record<string, string>> {
  try {
    const [row] = await db
      .select({ metadata: projectSessions.metadata })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1);
    return sessionChannelEnvFromMetadata(row?.metadata);
  } catch (err) {
    console.warn('[session-env] failed to restore channel binding', {
      sessionId,
      err: (err as Error).message,
    });
    return {};
  }
}

export async function buildSessionSandboxEnvVars(input: {
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
  /** OpenCode config dir at `baseSha`; lets the daemon spawn OpenCode pre-checkout. */
  opencodeConfigDir?: string | null;
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
}): Promise<Record<string, string>> {
  // Only user runtime secrets belong here. The sandbox-scoped KORTIX_TOKEN is
  // minted by provisionSessionSandbox() and injected at the provider boundary,
  // then reused by the daemon for both API calls and proxy HMAC validation.
  // Resolved AS the session's OWNER (createdBy, read below). This keeps personal
  // override selection consistent for server consumers without delivering the
  // value to the sandbox. Every OTHER secret is project-wide (secret
  // sharing was retired — authorization is centralized on the running agent's
  // `secrets` grant, applied below by identifier).
  let agentGrantEnv: string[] | 'all' | undefined;

  // v2-only: compile the manifest's `agents:` map into an OpenCode-native
  // config the sandbox receives sealed (see compile-agent-config.ts). `null`
  // for a v1 project (no `kortix_version: 2`) or any read/parse failure — no
  // KORTIX_COMPILED_AGENT_CONFIG key is emitted below in that case, so a v1
  // project's sandbox env is byte-for-byte unaffected by this. Gated on the
  // same `defaultBranch` presence as the `agents:` grant resolution below
  // (both need git context; optional call sites that omit it get neither).
  let compiledAgentConfig: string | null = input.platformMetaAgent
    ? buildPlatformMetaOpenCodeConfig()
    : null;
  // The harness the daemon boots — `selectSessionHarness`: the project's
  // `pi_harness` flag (on ⇒ pi) OR the manifest's `runtime: pi`. The manifest
  // is read off the SAME fetch that compiles the agent config, so selecting
  // pi costs no extra git round trip. Every provisioning path (create,
  // restart, resume, open/ensure) builds its env here, so a pi project stays
  // on pi across the session's whole life. The `pi_worker` feature flag is
  // the one exception: it routes `runtime: pi` to the split worker topology
  // BEFORE this builder runs (createSession), and never reaches it.
  let manifestHarness: 'opencode' | 'pi' | null = null;
  let manifestPackages: unknown[] = [];
  let harness: 'opencode' | 'pi' = 'opencode';
  if (input.defaultBranch && !input.platformMetaAgent) {
    const gitProject = {
      projectId: input.projectId,
      repoUrl: input.repoUrl,
      defaultBranch: input.defaultBranch,
      manifestPath: input.manifestPath ?? 'kortix.yaml',
      gitAuthToken: null,
    };
    const onManifest = (raw: Record<string, unknown>) => {
      manifestHarness = manifestRuntime(raw);
      manifestPackages = manifestPiPackages(raw, input.agentName);
    };
    compiledAgentConfig =
      !(input.repositoryAccess ?? true)
        ? await resolveSelectedAgentConfigForSession(
            gitProject,
            input.agentName,
            input.baseRef,
            { onManifest },
          )
          : await resolveCompiledAgentConfigForSession(
              gitProject,
              input.baseRef,
              { onManifest },
            ).catch(() => null);

    // Per-agent secret scoping: an agent declared in `agents:` with a `secrets`
    // allowlist receives ONLY those IDENTIFIERS — so a narrowly-scoped agent
    // can't read another scope's API keys/payment creds straight out of $ENV.
    // No-op (undefined → 'all') for back-compat grants and projects without
    // an `agents:` map or git context. This is the ONLY gate on agent secret
    // access — there is no resource-side allow-list on the secret itself.
    //
    // FAIL CLOSED: this used to `.catch(() => null)`, which collapsed a loader
    // throw into an unrestricted grant — a transient git/parse failure silently
    // handed the session every project secret. It now throws
    // SecretGrantResolutionError and the provision fails instead. Shares one
    // resolver with the per-prompt hot push (lib/secret-grant.ts) so the two
    // paths can no longer disagree about what this agent may read.
    agentGrantEnv = await resolveSessionSecretGrant({
      projectId: input.projectId,
      repoUrl: input.repoUrl,
      defaultBranch: input.defaultBranch,
      manifestPath: input.manifestPath,
      sessionAgent: input.agentName,
    });
  }
  if (!input.platformMetaAgent) {
    // One indexed read for the flag: the callers hold the project row in
    // different shapes (or not at all on the reload paths), and the flag must
    // apply on every provisioning path, not only create.
    const [projectRow] = await db
      .select({ metadata: projects.metadata })
      .from(projects)
      .where(eq(projects.projectId, input.projectId))
      .limit(1);
    harness = selectSessionHarness({
      piHarnessFlag: resolveFeatureFlag(projectRow?.metadata, 'pi_harness'),
      runtime: manifestHarness,
    });
  }
  // The prebuilt bundle of the project's pi packages (one S3 HEAD + presign; none without npm packages).
  const piPackagesBundle =
    harness === 'pi' && manifestPackages.length > 0
      ? await piPackageBundleForSession(manifestPackages, { projectId: input.projectId, sessionId: input.sessionId })
      : null;

  // Per-session secret policy, read by sessionId inside the builder so all three
  // call sites (create, restart, open/ensure) are covered — no caller can
  // forget them. `secretsAllowlist` NARROWS the agent grant to (grant) ∩ (list)
  // so a backend-vouched session only receives the secrets the wrapper named
  // (null → passthrough, byte-identical to pre-KaaB).
  const [sessionPolicyRow] = await db
    .select({
      secretsAllowlist: projectSessions.secretsAllowlist,
      createdBy: projectSessions.createdBy,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, input.sessionId))
    .limit(1);
  const grantEnvForSession = input.platformMetaAgent
    ? []
    : intersectSecretGrants(agentGrantEnv, sessionPolicyRow?.secretsAllowlist ?? null);

  // The secrets principal is the session's OWNER (`createdBy`), read here by
  // sessionId — NOT `input.userId`, which is whoever is provisioning this run.
  // On create those coincide, but restart/open/ensure-runtime provision on
  // behalf of any project manager/admin, and a per-user secret override (today
  // CODEX_AUTH_JSON) resolves per principal (`listResolvedProjectSecrets`). If a
  // manager restarted another member's session we'd inject the MANAGER's personal
  // secret at boot, which the first prompt's hot-push (`resolveOwnerRawEnv`, keyed
  // on `createdBy`) would then clobber back — a cross-principal bleed + flip-flop.
  // Deriving the principal from `createdBy` here unifies all three provisioning
  // paths with hot-push and the admin provider-migrate path. Falls back to
  // `input.userId` only if the row somehow isn't found (create races its own row
  // in some callers). The agent grant — not the human — remains the authority on
  // WHICH identifiers are eligible; this only picks the per-user override owner.
  //
  // Spec 2026-09-22 §2.3 (agent-principal model, flag ON): the override owner
  // is the session's on-behalf-of human, and only in a private session. A
  // trigger/channel run or a shared session gets shared values only.
  const secretsPrincipalUserId = await resolveSessionPersonalOwner({
    projectId: input.projectId,
    sessionId: input.sessionId,
    accountId: input.accountId,
    legacyUserId: sessionPolicyRow?.createdBy ?? input.userId,
  });

  let runtimeSecrets: {
    env: Record<string, string>;
    names: string[];
    revision: string;
    capabilitiesJson: string;
  };
  try {
    runtimeSecrets = await listProjectSecretsSnapshotForUser(
      input.projectId,
      secretsPrincipalUserId,
      grantEnvForSession,
      // Non-`runtime` rows are delivered as a per-session handle, so the
      // chokepoint needs the session this env is being built FOR. Without it it
      // withholds them rather than falling back to plaintext.
      input.sessionId,
    );
  } catch (err) {
    if (err instanceof AmbiguousSecretGrantError) {
      console.error(
        `[session ${input.sessionId}] agent '${input.agentName}' secrets grant is ambiguous: ${err.message}`,
      );
    }
    throw err;
  }
  if (Array.isArray(agentGrantEnv) && agentGrantEnv.length > 0) {
    console.log(
      `[session ${input.sessionId}] agent '${input.agentName}' env-scoped to ${agentGrantEnv.length} granted identifier(s)`,
    );
  }
  // The Slack signing secret only verifies inbound webhooks (an apps/api job).
  // The in-sandbox agent never needs it — keep it out of the sandbox env.
  delete runtimeSecrets.env.SLACK_SIGNING_SECRET;
  // The Slack BOT TOKEN no longer belongs in the sandbox either: the `slack`
  // shim now runs every Web API call through the Connector (server-side token)
  // and its file ops through the server-side file proxy. Keeping it out means a
  // compromised/prompt-injected agent can't exfiltrate the raw bot token — only
  // make scoped, audited, policy-gated channel calls. (KORTIX-206 Phase C2.)
  delete runtimeSecrets.env.SLACK_BOT_TOKEN;
  // Guardrail: drop any project secret whose name would clobber the sandbox's
  // own runtime env (PORT/PATH/KORTIX_*/…). Without this, one stray secret
  // silently breaks every session — and `kortix env push` of a server .env
  // makes that a one-command footgun.
  const droppedReserved = Object.keys(runtimeSecrets.env).filter(isReservedSandboxEnvName);
  for (const name of droppedReserved) delete runtimeSecrets.env[name];
  if (droppedReserved.length > 0) {
    console.warn(
      `[session ${input.sessionId}] ignored ${droppedReserved.length} project secret(s) with reserved env names: ${droppedReserved.join(', ')}`,
    );
  }
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
      // platform resolution. The sandbox uses it for the first OpenCode turn
      // and as the session's OpenCode config default.
      opencodeModel: input.opencodeModel,
      compiledAgentConfig,
      harness,
      piPackages: manifestPackages,
      piPackagesBundle,
      repositoryAccess: input.repositoryAccess,
      compiledBootMode: config.KORTIX_COMPILED_BOOT_MODE,
      freshSession: input.freshSession,
      restoreSessionBranch: input.restoreSessionBranch,
      baseSha: input.baseSha,
      gitDeltaBundleBase64: input.gitDeltaBundleBase64,
      gitDeltaParentSha: input.gitDeltaParentSha,
      gitDeltaParentCommitBase64: input.gitDeltaParentCommitBase64,
      gitDeltaBundleRemote: input.gitDeltaBundleRemote,
      opencodeConfigDir: input.opencodeConfigDir,
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

/**
 * The Kortix git-proxy origin for a project — the UNIVERSAL client-facing git
 * URL. Clients clone/push this with a Kortix token; the API resolves the real
 * upstream + mints the host credential server-side.
 */

export function proxyGitUrl(projectId: string): string {
  return `${deriveKortixApiRoot(config.KORTIX_URL)}/v1/git/${projectId}.git`;
}
