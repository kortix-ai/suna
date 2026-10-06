import { projectSessions, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { repointRetiredSessionModel } from '../../llm-gateway/resolution/session-model-repoint';
import { accountMayUseManagedModels } from '../../billing/services/entitlements';

import { db } from '../../shared/db';

import { resolveSessionSecretGrant } from './secret-grant';

import { AmbiguousSecretGrantError, intersectSecretGrants, listProjectSecretsSnapshotForUser } from '../secrets';
import { manifestPiPackages, manifestRuntime, resolveCompiledAgentConfigForSession, resolveSelectedAgentConfigForSession, selectSessionHarness } from './compile-agent-config';
import type { SessionSandboxEnvInput } from './session-sandbox-env-build';

import { isReservedSandboxEnvName } from './sandbox-env-names';

import { sessionChannelEnvFromMetadata } from './session-channel-env';

import { resolveFeatureFlag } from '../../feature-flags/registry';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { buildPlatformMetaOpenCodeConfig } from './platform-meta-agent';

import { resolveSessionPersonalOwner } from './personal-resources';

/**
 * The per-source builders behind `buildSessionSandboxEnvVars`. Each one owns
 * one input source of the sandbox env (manifest/agent scope, harness, secrets
 * policy, model pin, runtime secrets); the orchestrator in
 * session-sandbox-env-build.ts calls them in the original read order and
 * assembles the final record.
 */

/** Re-derive persisted channel env so every cold reprovision restores it. */
export async function buildSessionChannelEnv(sessionId: string): Promise<Record<string, string>> {
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

/**
 * The agent-scoped half of the env: the sealed compiled agent config, and the
 * agent's `secrets` grant resolved by IDENTIFIER off the manifest.
 */
export async function resolveSessionAgentEnvContext(
  input: SessionSandboxEnvInput,
): Promise<{
  compiledAgentConfig: string | null;
  agentGrantEnv: string[] | 'all' | undefined;
  manifestHarness: 'opencode' | 'pi' | null;
  manifestPackages: unknown[];
}> {
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
  // `pi_harness` flag (on ⇒ pi) OR the manifest's `runtime: pi`, and only
  // with the LLM gateway on (pi has no other model path). The manifest
  // is read off the SAME fetch that compiles the agent config, so selecting
  // pi costs no extra git round trip. Every provisioning path (create,
  // restart, resume, open/ensure) builds its env here, so a pi project stays
  // on pi across the session's whole life.
  let manifestHarness: 'opencode' | 'pi' | null = null;
  let manifestPackages: unknown[] = [];
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
            );

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
  return { compiledAgentConfig, agentGrantEnv, manifestHarness, manifestPackages };
}

/** Which harness the sandbox daemon boots, from the project row's flags. */
export async function resolveSessionSandboxHarness(
  input: SessionSandboxEnvInput,
  manifestHarness: 'opencode' | 'pi' | null,
): Promise<'opencode' | 'pi'> {
  {
    // One indexed read for the flag: the callers hold the project row in
    // different shapes (or not at all on the reload paths), and the flag must
    // apply on every provisioning path, not only create.
    const [projectRow] = await db
      .select({ metadata: projects.metadata })
      .from(projects)
      .where(eq(projects.projectId, input.projectId))
      .limit(1);
    // The same decision provisionSessionSandbox makes for KORTIX_LLM_BASE_URL.
    const llmGateway = projectLlmGatewayEnabled(projectRow?.metadata);
    if (input.platformMetaAgent) {
      // SUNA runs on the pi harness (the pi coding-agent path), not OpenCode,
      // whenever the LLM gateway is on — pi has no other model path, so a
      // gateway-off project falls back to OpenCode. pi reads the SAME
      // KORTIX_COMPILED_AGENT_CONFIG the OpenCode path receives
      // (harness/pi/config.ts:19-22), so the compiled agent prompt is unchanged.
      return llmGateway ? 'pi' : 'opencode';
    }
    return selectSessionHarness({
      piHarnessFlag: resolveFeatureFlag(projectRow?.metadata, 'pi_harness'),
      runtime: manifestHarness,
      llmGateway,
    });
  }
}

/**
 * The session's secret policy and the principal the secrets are resolved as:
 * the stored allowlist narrowed by the agent grant, and the session's OWNER
 * (`createdBy`) — NOT `input.userId`, which is whoever is provisioning this
 * run. On create those coincide, but restart/open/ensure-runtime provision on
 * behalf of any project manager/admin, and a per-user secret override (today
 * CODEX_AUTH_JSON) resolves per principal (`listResolvedProjectSecrets`). If a
 * manager restarted another member's session we'd inject the MANAGER's personal
 * secret at boot, which the first prompt's hot-push (`resolveOwnerRawEnv`, keyed
 * on `createdBy`) would then clobber back — a cross-principal bleed + flip-flop.
 * Deriving the principal from `createdBy` here unifies all three provisioning
 * paths with hot-push and the admin provider-migrate path. Falls back to
 * `input.userId` only if the row somehow isn't found (create races its own row
 * in some callers). The agent grant — not the human — remains the authority on
 * WHICH identifiers are eligible; this only picks the per-user override owner.
 *
 * Spec 2026-09-22 §2.3 (agent-principal model, flag ON): the override owner
 * is the session's on-behalf-of human, and only in a private session. A
 * trigger/channel run or a shared session gets shared values only.
 */
export async function resolveSessionSecretsPrincipal(
  input: SessionSandboxEnvInput,
  agentGrantEnv: string[] | 'all' | undefined,
): Promise<{
  grantEnvForSession: string[] | 'all' | undefined;
  secretsPrincipalUserId: string | null;
  sessionPolicyMetadata: unknown;
}> {
  // Per-session secret policy, read by sessionId inside the builder so all three
  // call sites (create, restart, open/ensure) are covered — no caller can
  // forget them. `secretsAllowlist` NARROWS the agent grant to (grant) ∩ (list)
  // so a backend-vouched session only receives the secrets the wrapper named
  // (null → passthrough, byte-identical to pre-KaaB).
  const [sessionPolicyRow] = await db
    .select({
      secretsAllowlist: projectSessions.secretsAllowlist,
      createdBy: projectSessions.createdBy,
      metadata: projectSessions.metadata,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, input.sessionId))
    .limit(1);
  const grantEnvForSession = input.platformMetaAgent
    ? []
    : intersectSecretGrants(agentGrantEnv, sessionPolicyRow?.secretsAllowlist ?? null);
  const secretsPrincipalUserId = await resolveSessionPersonalOwner({
    projectId: input.projectId,
    sessionId: input.sessionId,
    accountId: input.accountId,
    legacyUserId: sessionPolicyRow?.createdBy ?? input.userId,
  });
  return {
    grantEnvForSession,
    secretsPrincipalUserId,
    sessionPolicyMetadata: sessionPolicyRow?.metadata ?? null,
  };
}

/**
 * The runtime secret snapshot for this session, plus the model pin re-pointed
 * at this chokepoint. A session's stored model pin outlives any single boot —
 * the runtime managed lineup can rotate past it while the session sits open.
 * Re-pointing happens here, at the ONE chokepoint every provisioning path
 * (create, restart, open/ensure) already shares, before the box boots on a
 * dead id. No-op for native mode (no gateway, no managed catalog) and for the
 * overwhelming common case (a still-servable or non-managed pin) — see
 * llm-gateway/resolution/session-model-repoint.ts.
 */
export async function buildSessionRuntimeSecrets(
  input: SessionSandboxEnvInput,
  state: {
    agentGrantEnv: string[] | 'all' | undefined;
    grantEnvForSession: string[] | 'all' | undefined;
    secretsPrincipalUserId: string | null;
    sessionPolicyMetadata: unknown;
  },
): Promise<{
  runtimeSecrets: {
    env: Record<string, string>;
    names: string[];
    revision: string;
    capabilitiesJson: string;
  };
  opencodeModel: string | null;
}> {
  let opencodeModel = input.opencodeModel ?? null;
  if (input.llmGatewayEnabled && opencodeModel) {
    opencodeModel = await repointRetiredSessionModel(opencodeModel, {
      projectId: input.projectId,
      accountId: input.accountId,
      sessionId: input.sessionId,
      userId: state.secretsPrincipalUserId ?? input.userId,
      agentName: input.agentName,
      freeModelsOnly: !(await accountMayUseManagedModels(input.accountId)),
      metadata: state.sessionPolicyMetadata,
    });
  }

  let runtimeSecrets: {
    env: Record<string, string>;
    names: string[];
    revision: string;
    capabilitiesJson: string;
  };
  try {
    runtimeSecrets = await listProjectSecretsSnapshotForUser(
      input.projectId,
      state.secretsPrincipalUserId,
      state.grantEnvForSession,
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
  if (Array.isArray(state.agentGrantEnv) && state.agentGrantEnv.length > 0) {
    console.log(
      `[session ${input.sessionId}] agent '${input.agentName}' env-scoped to ${state.agentGrantEnv.length} granted identifier(s)`,
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
  return { runtimeSecrets, opencodeModel };
}
