import { eq } from 'drizzle-orm';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { db } from '../../lib/db';
import { resolveSandboxIngress } from '../../sandbox-proxy/backend';
import { projectLlmGatewayEnabledById } from '../../llm-gateway/enablement';
import type { ProviderName } from '../../platform/providers';
import {
  agentConfigEtag,
  resolveCompiledAgentConfigForSession,
  resolveSelectedAgentConfigForSession,
} from '../../projects/lib/compile-agent-config';
import { repositoryAccessFromSessionMetadata } from '../sessions/session-sandbox-metadata';
import { hasConfigReleaseCapability } from '../sessions/session-config-release';
import { resolveSandboxEnvSnapshot } from './sandbox-env-snapshot';
import {
  SANDBOX_SERVICE_PORT,
  llmGatewayBaseUrlForProvider,
  markSandboxLlmGatewayMode,
  postEnvToDaemon,
} from './sandbox-env-push';

/**
 * A push target that exists but is not `active` is a control-plane DIVERGENCE,
 * not an ordinary miss, and it must say so.
 *
 * Every push below used to filter the lookup on `status = 'active'` and return a
 * bare `'no active sandbox'`, which no caller logged. A session whose row said
 * `stopped` while its VM was genuinely running — serving prompts the whole time
 * — therefore received no secret, model or scope push for HOURS, and the only
 * visible symptom was an agent that could not see a secret the UI insisted it
 * had (a prod session, 2026-08-27). `backend.ts` deliberately refuses to
 * heal a row whose deadline has expired, so nothing else reconciles this and
 * nothing else reports it.
 *
 * `sessionSandboxes.status` is NOT NULL, so callers guard on a truthy value
 * only to stay compatible with test doubles that select a narrower row shape.
 */
function nonActiveSandboxSkip(
  what: string,
  input: { sessionId: string; projectId?: string },
  status: string,
): { applied: false; reason: string } {
  console.warn(`[env-sync] skipping ${what} — sandbox row is not active`, {
    sessionId: input.sessionId,
    projectId: input.projectId,
    sandboxStatus: status,
  });
  return { applied: false, reason: `sandbox row is '${status}', not active` };
}

/**
 * Is a config release ACTUALLY governing this box? `true`, `false`, or `null`
 * when health did not answer.
 *
 * Such a box receives compiled governance inside its config release. A separate
 * `KORTIX_COMPILED_AGENT_CONFIG` push through `/kortix/env` would restart
 * OpenCode on governance that does not match the release it runs — and the box
 * drops it anyway (`releaseGovernanceActive`, daemon `harness/open-code/control.ts`).
 *
 * This reads the box's STATE (`config.release_id`), not the binary's
 * `config.release.v1` capability. The capability is compiled in and is present
 * whatever the project chose, so gating on it withheld the push from every box
 * that runs NO release — `config_releases` off for the project, or a release
 * chain that stepped down to the image default. Those boxes are exactly the
 * pre-release case the push exists for. `releaseGovernanceActive` is the same
 * `running.release_id !== null` the daemon applies on its own side.
 */
export async function daemonHasConfigReleases(
  baseUrl: string,
  headers: Record<string, string>,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
): Promise<boolean | null> {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/kortix/health`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { capabilities?: unknown; config?: unknown };
    // An old daemon has neither the capability nor a `config` block.
    if (!hasConfigReleaseCapability(body.capabilities)) return false;
    const config = (body.config ?? null) as { release_id?: unknown } | null;
    return typeof config?.release_id === 'string' && config.release_id.length > 0;
  } catch {
    return null;
  }
}

/**
 * Recompile this session's agent config from git and deliver it to the running box.
 *
 * The compiled agent config — agents, their prompts, permissions, model — is the
 * one part of a session's configuration with no runtime source. It is compiled
 * once at provision and handed down as `KORTIX_COMPILED_AGENT_CONFIG`, so a
 * session merged past days ago keeps running the agents it booted with. Pulling
 * the branch inside the sandbox does not help (the compiled bytes never came
 * from the working tree) and neither did restarting opencode (the daemon's env
 * was unchanged, so a respawn rebuilt the same config).
 *
 * Recompiles from `baseRef` — the ref the SESSION runs on, which is not always
 * the project default.
 *
 * Costs an opencode restart, because opencode reads its config only at spawn.
 * Callers that are already restarting the box pay nothing extra; a caller doing
 * this mid-session is interrupting a turn and must say so.
 */
export async function pushSessionAgentConfigToSandbox(input: {
  projectId: string;
  sessionId: string;
  repoUrl: string;
  defaultBranch: string;
  manifestPath?: string | null;
  baseRef?: string | null;
  /** Reports real operation boundaries to callers that expose progress. */
  onPhase?: (phase: 'compiling-config' | 'applying-config') => void;
}): Promise<{
  applied: boolean;
  reason?: string;
  opencodeReload?: 'disposed' | 'restarted' | 'kept-old' | null;
  opencodeTurnEnded?: boolean | null;
}> {
  try {
    input.onPhase?.('compiling-config');
    const [session] = await db
      .select({
        agentName: projectSessions.agentName,
        metadata: projectSessions.metadata,
      })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, input.sessionId))
      .limit(1);
    const gitProject = {
      projectId: input.projectId,
      repoUrl: input.repoUrl,
      defaultBranch: input.defaultBranch,
      manifestPath: input.manifestPath ?? 'kortix.yaml',
      gitAuthToken: null,
    };
    const compiled =
      !repositoryAccessFromSessionMetadata(session?.metadata) &&
      session?.agentName
        ? await resolveSelectedAgentConfigForSession(
            gitProject,
            session.agentName,
            input.baseRef,
          )
        : await resolveCompiledAgentConfigForSession(gitProject, input.baseRef);
    // `null` is a v1 project or an unreadable manifest. Pushing an empty value
    // would DELETE the agent config the box is running — a v1 project has none
    // to begin with, and for a transient read failure that would be a silent
    // downgrade to no agents at all. Leave the box as it is.
    if (!compiled) return { applied: false, reason: 'no compiled agent config' };

    // Selected WITHOUT the status filter so a non-active row can be NAMED. The
    // filtered form returned a bare 'no active sandbox' and the caller logged
    // nothing, so a session whose row said `stopped` while its VM was genuinely
    // running — serving prompts the whole time — silently received no secret or
    // config push for HOURS. A prod session, 2026-08-27: every push
    // since the secret was created was skipped this way, and the only visible
    // symptom was an agent that could not see a secret the UI said it had.
    const [row] = await db
      .select({
        externalId: sessionSandboxes.externalId,
        config: sessionSandboxes.config,
        status: sessionSandboxes.status,
      })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sessionId, input.sessionId))
      .limit(1);
    if (!row?.externalId) return { applied: false, reason: 'no sandbox for session' };
    if (row.status && row.status !== 'active')
      return nonActiveSandboxSkip('agent-config push', input, row.status);

    const config = (row.config || {}) as Record<string, unknown>;
    const serviceKey = typeof config.serviceKey === 'string' ? config.serviceKey : null;
    if (!serviceKey) return { applied: false, reason: 'sandbox has no service key' };

    const snapshot = await resolveSandboxEnvSnapshot(input.projectId, input.sessionId);
    if (!snapshot) return { applied: false, reason: 'no env snapshot' };

    const { url, headers } = await resolveSandboxIngress(row.externalId, {
      port: SANDBOX_SERVICE_PORT,
      transport: 'http',
    });
    // Capability gate. A daemon with config releases gets governance from its
    // release; `null` (health did not answer) is not permission to push.
    const releases = await daemonHasConfigReleases(url, {
      ...(headers as Record<string, string>),
      Authorization: `Bearer ${serviceKey}`,
    });
    if (releases !== false) {
      return {
        applied: false,
        reason:
          releases === true
            ? 'the daemon receives compiled governance in its config release'
            : 'could not read the daemon capabilities',
      };
    }
    // The daemon call blocks until its verified reload either promotes the new
    // runtime or keeps the old one. This phase therefore names the whole
    // apply-and-validate boundary instead of inventing sub-phases we cannot see.
    input.onPhase?.('applying-config');
    const pushed = await postEnvToDaemon({
      previewUrl: url,
      providerHeaders: headers,
      serviceKey,
      snapshot,
      opencodeEnv: {
        KORTIX_COMPILED_AGENT_CONFIG: compiled,
        // Pushed with the config so the box's reported etag never lags what it
        // is actually running.
        KORTIX_COMPILED_AGENT_CONFIG_ETAG: agentConfigEtag(compiled) ?? '',
      },
      // Restarts opencode so it rebuilds its config against the new agents.
      refreshModels: true,
    });
    // `applied` means WE pushed it. Whether opencode actually took it is
    // `opencodeReload` — a declined swap leaves the old config running, and
    // reporting a bare `applied: true` for that is the lie this field prevents.
    return {
      applied: true,
      opencodeReload: pushed.opencodeReload,
      opencodeTurnEnded: pushed.opencodeTurnEnded,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[env-sync] agent-config push failed for session ${input.sessionId}:`, reason);
    return { applied: false, reason };
  }
}

/**
 * Re-point ONE live session at a different model.
 *
 * opencode reads `KORTIX_OPENCODE_MODEL` when it builds its config at spawn, so
 * the value must reach the daemon AND opencode must restart for it to take
 * effect. `refreshModels: true` is what triggers that restart.
 *
 * Best-effort by design: the row is already updated by the caller, so a sandbox
 * that is down or unreachable simply picks the new model up on its next boot.
 * Returns whether a live box actually took it, so the caller can tell the user
 * whether the change is in effect NOW or only from the next turn.
 */
export async function pushSessionModelToSandbox(input: {
  projectId: string;
  sessionId: string;
  model: string;
}): Promise<{ applied: boolean; reason?: string }> {
  try {
    const [row] = await db
      .select({
        externalId: sessionSandboxes.externalId,
        config: sessionSandboxes.config,
        status: sessionSandboxes.status,
      })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sessionId, input.sessionId))
      .limit(1);
    if (!row?.externalId) return { applied: false, reason: 'no active sandbox' };
    if (row.status && row.status !== 'active')
      return nonActiveSandboxSkip('model push', input, row.status);

    const config = (row.config || {}) as Record<string, unknown>;
    const serviceKey = typeof config.serviceKey === 'string' ? config.serviceKey : null;
    if (!serviceKey) return { applied: false, reason: 'sandbox has no service key' };

    const snapshot = await resolveSandboxEnvSnapshot(input.projectId, input.sessionId);
    if (!snapshot) return { applied: false, reason: 'no env snapshot' };

    const { url, headers } = await resolveSandboxIngress(row.externalId, {
      port: SANDBOX_SERVICE_PORT,
      transport: 'http',
    });
    await postEnvToDaemon({
      previewUrl: url,
      providerHeaders: headers,
      serviceKey,
      snapshot,
      // `KORTIX_MODEL` for a W3 daemon; its pre-W3 name for an older one.
      opencodeEnv: { KORTIX_MODEL: input.model, KORTIX_OPENCODE_MODEL: input.model },
      // Restarts opencode so it rebuilds its config against the new model.
      refreshModels: true,
    });
    return { applied: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[env-sync] model push failed for session ${input.sessionId}:`, reason);
    return { applied: false, reason };
  }
}

/**
 * Re-resolve this session's secrets snapshot and deliver it to the RUNNING
 * sandbox, restarting opencode so its process env picks up the new set.
 *
 * `PUT /sessions/{id}/scope` re-scopes a live session's secrets allowlist. The
 * row was persisted, but for a long time nothing pushed the new snapshot to the
 * box: the route returned "Applies from the next prompt." and delegated the
 * actual delivery to `syncSandboxEnvForPrompt`. That delegation was unreliable:
 *
 *   - the per-prompt hot sync has two silent early-returns (`!serviceKey`,
 *     `!snapshot`/`!row.createdBy`) that skip the POST with no log;
 *   - it only fires when the prompt routes through `POST :8000
 *     /session/{id}/{prompt_async|message}` — a prompt sent any other way
 *     (straight to :4096, the lifecycle queue) slips past it;
 *   - even when it DID fire, the daemon's env route took the ~51ms dispose
 *     fast path for a pure secret change, and a dispose re-reads the opencode
 *     CONFIG file only — it does not re-run `mergeProjectEnv`, so opencode's
 *     process env stayed on the OLD (0/47) snapshot while `agent-env.sh` got
 *     the new one (so freshly-started shells saw 47/47). The box reported a
 *     stale OpenCode PID until something else forced a respawn.
 *
 * Pushing here — the same pattern the `/model` PUT already uses — fixes both
 * halves: the snapshot is re-derived from the freshly-committed allowlist and
 * POSTed to the daemon, and `refreshModels: true` restarts opencode so
 * `spawnChild` re-runs `mergeProjectEnv` + `withoutDeniedProviderEnv`. The
 * LLM-gateway provider strip is re-stamped alongside (it lives in the same
 * `opencodeEnv`/`llmGatewayDenyEnv` channel), so the 42/47-vs-47/47 split
 * between the opencode process and tool shells is preserved, and revocation
 * keeps working (`knownNames` is still tracked in the daemon store, so a
 * dropped secret is actively cleared on the respawn).
 *
 * Best-effort by design, mirroring `pushSessionModelToSandbox`: the row is
 * already committed, so a sandbox that is down or unreachable simply picks the
 * new scope up on its next boot. The caller reports `applied_live` so a UI can
 * tell "in effect now" from "stored, applies at next boot" — the same
 * distinction the model route makes.
 */
export async function pushSessionScopeToSandbox(input: {
  projectId: string;
  sessionId: string;
}): Promise<{ applied: boolean; reason?: string }> {
  try {
    const [row] = await db
      .select({
        externalId: sessionSandboxes.externalId,
        provider: sessionSandboxes.provider,
        config: sessionSandboxes.config,
        status: sessionSandboxes.status,
      })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sessionId, input.sessionId))
      .limit(1);
    if (!row?.externalId) return { applied: false, reason: 'no active sandbox' };
    if (row.status && row.status !== 'active')
      return nonActiveSandboxSkip('scope push', input, row.status);

    const config = (row.config || {}) as Record<string, unknown>;
    const serviceKey = typeof config.serviceKey === 'string' ? config.serviceKey : null;
    if (!serviceKey) return { applied: false, reason: 'sandbox has no service key' };

    // Re-derive from the row the route JUST committed — `resolveOwnerRawEnv`
    // reads `secretsAllowlist` fresh, so this reflects the new scope, not the
    // boot snapshot the daemon is still running.
    const snapshot = await resolveSandboxEnvSnapshot(input.projectId, input.sessionId);
    if (!snapshot) return { applied: false, reason: 'no env snapshot' };

    const llmGatewayEnabled = await projectLlmGatewayEnabledById(input.projectId);
    const { url, headers } = await resolveSandboxIngress(row.externalId, {
      port: SANDBOX_SERVICE_PORT,
      transport: 'http',
    });
    await postEnvToDaemon({
      previewUrl: url,
      providerHeaders: headers,
      serviceKey,
      snapshot,
      // Restarts opencode so spawnChild re-runs mergeProjectEnv + the gateway
      // strip. A dispose cannot refresh the child's process env (project
      // secrets shape it at spawn, not via the config file), so the respawn is
      // the load-bearing part — see the daemon-side gate in routes/env.ts.
      refreshModels: true,
      llmGatewayEnabled,
      llmGatewayBaseUrl: llmGatewayEnabled
        ? llmGatewayBaseUrlForProvider(row.provider as ProviderName)
        : undefined,
    });
    await markSandboxLlmGatewayMode(input.sessionId, llmGatewayEnabled);
    return { applied: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[env-sync] scope push failed for session ${input.sessionId}:`, reason);
    return { applied: false, reason };
  }
}
