import { and, eq } from 'drizzle-orm';
import { projects, projectSessions, sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { resolveSandboxIngress } from '../../sandbox-proxy/backend';
import { config } from '../../config';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { resolveLlmGatewayBaseUrl } from '../../llm-gateway/sandbox-base-url';
import { nativeProviderEnvNames } from '../../llm-gateway/sandbox-credentials';
import { getProvider, type ProviderName } from '../../platform/providers';
import {
  intersectSecretGrants,
  listProjectSecretsSnapshotForUser,
  projectSecretsRevision,
} from '../secrets';
import { DEFAULT_AGENT_SENTINEL } from '../agents';
import { resolveSessionSecretGrant } from './secret-grant';
import { sanitizeSandboxEnv } from './sandbox-env-names';
import {
  agentConfigEtag,
  resolveCompiledAgentConfigForSession,
} from './compile-agent-config';
import { waitForDaemonOpencodeReady } from './sandbox-daemon-ready';

/**
 * The origin THIS sandbox should reach kortix-api's LLM-gateway surface at —
 * mirrors session-sandbox.ts's boot-time computation (see that file and
 * `local-docker.ts`'s `sandboxFacingApiOrigin()`). Every hot env-push call
 * site here recomputes the LLM-gateway base URL from scratch (a project's
 * gateway opt-in can toggle, or secrets can rotate, mid-session), so it must
 * ask the OWNING provider for its origin the same way the boot path does —
 * otherwise a same-machine provider's boot-time fix is silently undone by the
 * very next prompt or gateway-mode toggle, which re-pushes the generic public
 * origin over the daemon's `/kortix/env` and re-breaks connectivity.
 */
export function llmGatewayBaseUrlForProvider(providerName: ProviderName): string {
  const origin = getProvider(providerName).sandboxFacingApiOrigin?.() ?? config.KORTIX_URL;
  return resolveLlmGatewayBaseUrl(origin);
}

const SANDBOX_SERVICE_PORT = 8000;
const FANOUT_CONCURRENCY = 6;
const ENV_PUSH_TIMEOUT_MS = 15_000;

export interface SandboxEnvSnapshot {
  env: Record<string, string>;
  names: string[];
  revision: string;
  scope: 'inherit' | 'restricted' | 'none';
}

export interface ProjectSecretPropagationTarget {
  session_id: string;
  sandbox_id: string | null;
  status: 'synced' | 'failed';
  scope: SandboxEnvSnapshot['scope'] | null;
  revision: string | null;
  exported: number;
  managed: number | null;
  withheld: number | null;
  agent_env_written: boolean;
  reason?: string;
}

export interface ProjectSecretPropagationResult {
  ok: boolean;
  active_sandboxes: number;
  targeted: number;
  synced: number;
  failed: number;
  exported: number;
  results: ProjectSecretPropagationTarget[];
}

async function resolveOwnerRawEnv(
  projectId: string,
  sessionId: string | null,
  requestedAgent?: string | null,
): Promise<{ env: Record<string, string>; scope: SandboxEnvSnapshot['scope'] } | null> {
  if (!sessionId) return null;
  const [row] = await db
    .select({
      createdBy: projectSessions.createdBy,
      agentName: projectSessions.agentName,
      secretsAllowlist: projectSessions.secretsAllowlist,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  if (!row?.createdBy) return null;

  // Resolve the RUNNING agent's `secrets` grant (by identifier) — the SAME gate
  // applied at sandbox boot (buildSessionSandboxEnvVars), through the SAME
  // resolver (lib/secret-grant.ts), so boot and hot push can never disagree.
  //
  // `requestedAgent` is the agent the prompt actually asked to run, which is
  // NOT necessarily `row.agentName`: in-session agent switching is allowed and
  // nothing ever updates that column. Resolving from the stale column let a
  // session created under a broad agent run a narrow one while still being
  // re-pushed the broad agent's full env on every turn. A switch that would
  // change the grant now throws AgentSecretGrantMismatchError (→ 409) rather
  // than quietly re-scoping, because a later narrowing cannot un-read what the
  // previous agent already pulled into the box when the optional strict lock
  // is enabled. By default, the hot push replaces the env with the running
  // agent's grant before the prompt is forwarded.
  const [project] = await db
    .select({
      repoUrl: projects.repoUrl,
      defaultBranch: projects.defaultBranch,
      manifestPath: projects.manifestPath,
    })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);

  const grantEnv = await resolveSessionSecretGrant({
    projectId,
    repoUrl: project?.repoUrl ?? '',
    defaultBranch: project?.defaultBranch,
    manifestPath: project?.manifestPath,
    sessionAgent: row.agentName ?? DEFAULT_AGENT_SENTINEL,
    requestedAgent,
    enforceGrantLock: config.KORTIX_ENFORCE_AGENT_SECRET_GRANT_LOCK,
  });

  // THE CLOBBER FIX: apply the SAME per-session secrets narrowing as boot
  // (buildSessionSandboxEnvVars). Without this, the first prompt's env sync (and
  // every secret-CRUD fan-out) would re-push the full agent-grant set into a
  // narrowed sandbox, silently widening it back. null allowlist → passthrough.
  const grantEnvForSession = intersectSecretGrants(grantEnv, row.secretsAllowlist ?? null);
  const env = (
    await listProjectSecretsSnapshotForUser(
      projectId,
      row.createdBy,
      grantEnvForSession,
      // Same session the boot path built for — boot and hot push must agree on
      // delivery or a prompt would re-push a value boot deliberately withheld.
      sessionId,
    )
  ).env;
  return {
    env,
    scope:
      row.secretsAllowlist == null
        ? 'inherit'
        : row.secretsAllowlist.length === 0
          ? 'none'
          : 'restricted',
  };
}

export async function resolveSandboxEnvSnapshot(
  projectId: string,
  sessionId: string | null,
  requestedAgent?: string | null,
): Promise<SandboxEnvSnapshot | null> {
  const resolved = await resolveOwnerRawEnv(projectId, sessionId, requestedAgent);
  if (!resolved) return null;
  const { env, names } = sanitizeSandboxEnv(resolved.env);
  return { env, names, revision: projectSecretsRevision(env), scope: resolved.scope };
}

function isSecureOrPrivateTarget(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  const h = u.hostname;
  if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(h)) return true;
  if (!h.includes('.')) return true; // single-label docker/service name on a private bridge
  if (/\.(local|internal|svc|cluster\.local)$/.test(h)) return true;
  // RFC1918 / link-local — anchored to full IPv4 literals so a public hostname
  // like "10.foo.evil.com" can't slip through a `^10.` prefix match.
  if (/^10(\.\d{1,3}){3}$/.test(h)) return true;
  if (/^192\.168(\.\d{1,3}){2}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}$/.test(h)) return true;
  if (/^169\.254(\.\d{1,3}){2}$/.test(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true; // IPv6 unique-local
  return false; // plain http to a public host — refuse to send secrets in cleartext
}

async function postEnvToDaemon(args: {
  previewUrl: string;
  providerHeaders: Record<string, string>;
  serviceKey: string;
  snapshot: SandboxEnvSnapshot;
  refreshModels?: boolean;
  /** Runtime env the daemon applies to the OPENCODE process (allow-listed there). */
  opencodeEnv?: Record<string, string | null>;
  llmGatewayEnabled?: boolean;
  llmGatewayBaseUrl?: string;
  llmGatewayDenyEnv?: string;
  requireAgentEnvProof?: boolean;
}): Promise<{
  opencodeState: string | null;
  revision: string;
  exported: number;
  managed: number | null;
  withheld: number | null;
  agentEnvWritten: boolean;
}> {
  if (!isSecureOrPrivateTarget(args.previewUrl)) {
    throw new Error('refusing to push secrets over insecure transport (non-TLS public host)');
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${args.serviceKey}`,
    ...args.providerHeaders,
  };

  const res = await fetch(`${args.previewUrl.replace(/\/$/, '')}/kortix/env`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      env: args.snapshot.env,
      names: args.snapshot.names,
      revision: args.snapshot.revision,
      refreshModels: args.refreshModels ?? false,
      ...(args.opencodeEnv ? { opencodeEnv: args.opencodeEnv } : {}),
      ...(typeof args.llmGatewayEnabled === 'boolean'
        ? {
            llmGatewayEnabled: args.llmGatewayEnabled,
            ...(args.llmGatewayBaseUrl ? { llmGatewayBaseUrl: args.llmGatewayBaseUrl } : {}),
            llmGatewayDenyEnv: args.llmGatewayDenyEnv ?? '',
          }
        : {}),
    }),
    signal: AbortSignal.timeout(ENV_PUSH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`env sync failed: ${res.status}${body ? ` ${body.slice(0, 500)}` : ''}`);
  }
  // The daemon echoes opencode's post-sync state. After a model-affecting change
  // it restarts opencode and reports `starting` here — the signal we use to wait
  // for readiness before the prompt is forwarded.
  const body = (await res.json().catch(() => null)) as {
    ok?: unknown;
    revision?: unknown;
    exported?: unknown;
    managed?: unknown;
    withheld?: unknown;
    agent_env_written?: unknown;
    opencode?: unknown;
  } | null;
  const expectedExported = Object.keys(args.snapshot.env).length;
  if (args.requireAgentEnvProof) {
    if (!body || body.ok !== true) throw new Error('env sync proof missing ok=true');
    if (body.revision !== args.snapshot.revision) {
      throw new Error(`env sync revision mismatch: expected ${args.snapshot.revision}, received ${String(body.revision)}`);
    }
    if (body.agent_env_written !== true) {
      throw new Error('env sync did not confirm agent-env.sh write');
    }
    if (body.exported !== expectedExported) {
      throw new Error(`env sync export mismatch: expected ${expectedExported}, received ${String(body.exported)}`);
    }
  }
  return {
    opencodeState: typeof body?.opencode === 'string' ? body.opencode : null,
    revision: typeof body?.revision === 'string' ? body.revision : args.snapshot.revision,
    exported: typeof body?.exported === 'number' ? body.exported : expectedExported,
    managed: typeof body?.managed === 'number' ? body.managed : null,
    withheld: typeof body?.withheld === 'number' ? body.withheld : null,
    agentEnvWritten: body?.agent_env_written === true,
  };
}

export async function syncSandboxEnvForPrompt(args: {
  projectId: string;
  sessionId: string;
  serviceKey: string | null;
  previewUrl: string;
  providerHeaders: Record<string, string>;
  /** The provider this sandbox actually runs on (`SandboxRecord.provider` at
   *  the call site) — needed to resolve the LLM-gateway base URL onto the
   *  RIGHT origin for a same-machine provider. */
  providerName: ProviderName;
  /** The agent this prompt asked to run (the body's `agent` field). The secret
   *  grant is resolved from THIS, not from the session's create-time agent —
   *  see resolveOwnerRawEnv. Null/'default' means "the session's own agent". */
  requestedAgent?: string | null;
  /** Runtime env the daemon applies before the prompt reaches OpenCode. */
  opencodeEnv?: Record<string, string | null>;
}): Promise<void> {
  if (!args.serviceKey) return;
  const snapshot = await resolveSandboxEnvSnapshot(
    args.projectId,
    args.sessionId,
    args.requestedAgent,
  );
  if (!snapshot) return;
  const llmGatewayEnabled = await resolveProjectLlmGatewayEnabled(args.projectId);
  const { opencodeState } = await postEnvToDaemon({
    previewUrl: args.previewUrl,
    providerHeaders: args.providerHeaders,
    serviceKey: args.serviceKey,
    snapshot,
    refreshModels: true,
    opencodeEnv: args.opencodeEnv,
    llmGatewayEnabled,
    llmGatewayBaseUrl: llmGatewayEnabled ? llmGatewayBaseUrlForProvider(args.providerName) : undefined,
    llmGatewayDenyEnv: llmGatewayEnabled ? nativeProviderEnvNames().join(',') : '',
  });
  // A model-affecting change just restarted opencode (state !== 'ok'). The prompt
  // is forwarded the instant this returns, so block until opencode is serving —
  // otherwise the forward hits the restart window and 503s "opencode not ready",
  // dropping the session's first prompt (the user then has to resend).
  if (opencodeState && opencodeState !== 'ok') {
    const waitStartedAt = Date.now();
    const ready = await waitForDaemonOpencodeReady({
      previewUrl: args.previewUrl,
      providerHeaders: args.providerHeaders,
    });
    console.log(
      `[env-sync] opencode restarted by prompt env-sync (state=${opencodeState}); ` +
        `waited ${Date.now() - waitStartedAt}ms for readiness before forwarding ` +
        `(ready=${ready}) session=${args.sessionId}`,
    );
  }
  await markSandboxLlmGatewayMode(args.sessionId, llmGatewayEnabled);
}

export async function propagateProjectSecretsToActiveSandboxes(
  projectId: string,
  opts?: { refreshModels?: boolean },
): Promise<ProjectSecretPropagationResult> {
  const report: ProjectSecretPropagationResult = {
    ok: true,
    active_sandboxes: 0,
    targeted: 0,
    synced: 0,
    failed: 0,
    exported: 0,
    results: [],
  };
  try {
    const rows = await db
      .select({
        externalId: sessionSandboxes.externalId,
        sessionId: sessionSandboxes.sessionId,
        config: sessionSandboxes.config,
      })
      .from(sessionSandboxes)
      .where(and(eq(sessionSandboxes.projectId, projectId), eq(sessionSandboxes.status, 'active')));

    report.active_sandboxes = rows.length;
    const targets = rows.filter((r): r is typeof r & { externalId: string } => !!r.externalId);
    for (const row of rows) {
      if (row.externalId) continue;
      report.results.push({
        session_id: row.sessionId,
        sandbox_id: null,
        status: 'failed',
        scope: null,
        revision: null,
        exported: 0,
        managed: null,
        withheld: null,
        agent_env_written: false,
        reason: 'active sandbox has no external id',
      });
    }
    report.targeted = targets.length;
    if (targets.length === 0) {
      console.info('[env-sync] propagate: no active sandboxes found', { projectId, totalRows: rows.length });
      report.failed = report.results.length;
      report.ok = report.failed === 0;
      return report;
    }
    console.info('[env-sync] propagate: pushing to sandboxes', { projectId, targetCount: targets.length });

    await runBounded(targets, FANOUT_CONCURRENCY, async (row) => {
      const config = (row.config || {}) as Record<string, unknown>;
      const serviceKey = typeof config.serviceKey === 'string' ? config.serviceKey : null;
      if (!serviceKey) {
        report.results.push({
          session_id: row.sessionId,
          sandbox_id: row.externalId,
          status: 'failed',
          scope: null,
          revision: null,
          exported: 0,
          managed: null,
          withheld: null,
          agent_env_written: false,
          reason: 'active sandbox has no service key',
        });
        return;
      }
      let snapshot: SandboxEnvSnapshot | null = null;
      try {
        snapshot = await resolveSandboxEnvSnapshot(projectId, row.sessionId);
        if (!snapshot) throw new Error('session env snapshot is unavailable');
        const { url, headers } = await resolveSandboxIngress(row.externalId, { port: SANDBOX_SERVICE_PORT, transport: 'http' });
        const proof = await postEnvToDaemon({
          previewUrl: url,
          providerHeaders: headers,
          serviceKey,
          snapshot,
          refreshModels: opts?.refreshModels,
          requireAgentEnvProof: true,
        });
        report.results.push({
          session_id: row.sessionId,
          sandbox_id: row.externalId,
          status: 'synced',
          scope: snapshot.scope,
          revision: proof.revision,
          exported: proof.exported,
          managed: proof.managed,
          withheld: proof.withheld,
          agent_env_written: proof.agentEnvWritten,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        report.results.push({
          session_id: row.sessionId,
          sandbox_id: row.externalId,
          status: 'failed',
          scope: snapshot?.scope ?? null,
          revision: snapshot?.revision ?? null,
          exported: 0,
          managed: null,
          withheld: null,
          agent_env_written: false,
          reason,
        });
        console.warn(
          `[env-sync] hot push failed for sandbox ${row.externalId}:`,
          reason,
        );
      }
    });
    report.synced = report.results.filter((result) => result.status === 'synced').length;
    report.failed = report.results.filter((result) => result.status === 'failed').length;
    report.exported = report.results.reduce((sum, result) => sum + result.exported, 0);
    report.results.sort((a, b) => a.session_id.localeCompare(b.session_id));
    report.ok = report.failed === 0;
    console.info('[env-sync] propagate: complete', {
      projectId,
      activeSandboxes: report.active_sandboxes,
      targeted: report.targeted,
      synced: report.synced,
      failed: report.failed,
      exported: report.exported,
    });
    return report;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[env-sync] hot fan-out failed for project ${projectId}:`,
      reason,
    );
    report.ok = false;
    report.failed += 1;
    report.results.push({
      session_id: '',
      sandbox_id: null,
      status: 'failed',
      scope: null,
      revision: null,
      exported: 0,
      managed: null,
      withheld: null,
      agent_env_written: false,
      reason,
    });
    return report;
  }
}

export async function propagateLlmGatewayModeToActiveSandboxes(
  projectId: string,
  enabled: boolean,
): Promise<void> {
  try {
    const rows = await db
      .select({
        externalId: sessionSandboxes.externalId,
        sessionId: sessionSandboxes.sessionId,
        provider: sessionSandboxes.provider,
        config: sessionSandboxes.config,
      })
      .from(sessionSandboxes)
      .where(and(eq(sessionSandboxes.projectId, projectId), eq(sessionSandboxes.status, 'active')));

    const targets = rows.filter((r): r is typeof r & { externalId: string } => !!r.externalId);
    if (targets.length === 0) return;

    // Computed PER ROW (not once, hoisted) — a project's active sandboxes can
    // span more than one provider (mid-migration, failover), and each needs
    // the base URL resolved onto ITS OWN provider's origin.
    await runBounded(targets, FANOUT_CONCURRENCY, async (row) => {
      const rowConfig = (row.config || {}) as Record<string, unknown>;
      const serviceKey = typeof rowConfig.serviceKey === 'string' ? rowConfig.serviceKey : null;
      if (!serviceKey) return;
      try {
        const snapshot =
          (await resolveSandboxEnvSnapshot(projectId, row.sessionId)) ??
          emptySandboxEnvSnapshot(`llm-gateway-${enabled ? 'on' : 'off'}`);
        const { url, headers } = await resolveSandboxIngress(row.externalId, { port: SANDBOX_SERVICE_PORT, transport: 'http' });
        await postEnvToDaemon({
          previewUrl: url,
          providerHeaders: headers,
          serviceKey,
          snapshot,
          refreshModels: true,
          llmGatewayEnabled: enabled,
          llmGatewayBaseUrl: enabled ? llmGatewayBaseUrlForProvider(row.provider as ProviderName) : undefined,
          llmGatewayDenyEnv: enabled ? nativeProviderEnvNames().join(',') : '',
        });
        await markSandboxLlmGatewayMode(row.sessionId, enabled);
      } catch (err) {
        console.warn(
          `[env-sync] LLM gateway mode push failed for sandbox ${row.externalId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    });
  } catch (err) {
    console.warn(
      `[env-sync] LLM gateway mode fan-out failed for project ${projectId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function resolveProjectLlmGatewayEnabled(projectId: string): Promise<boolean> {
  const [project] = await db
    .select({ metadata: projects.metadata })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  return projectLlmGatewayEnabled(project?.metadata);
}

async function markSandboxLlmGatewayMode(
  sessionId: string,
  enabled: boolean,
): Promise<void> {
  const [row] = await db
    .select({ config: sessionSandboxes.config })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId))
    .limit(1);
  if (!row) return;
  await db
    .update(sessionSandboxes)
    .set({
      config: {
        ...((row.config as Record<string, unknown> | null) ?? {}),
        llmGatewayEnabled: enabled,
      },
      updatedAt: new Date(),
    })
    .where(eq(sessionSandboxes.sessionId, sessionId));
}

function emptySandboxEnvSnapshot(reason: string): SandboxEnvSnapshot {
  return {
    env: {},
    names: [],
    revision: `${reason}-${Date.now()}`,
    scope: 'inherit',
  };
}

async function runBounded<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await fn(item);
    }
  });
  await Promise.all(workers);
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
}): Promise<{ applied: boolean; reason?: string }> {
  try {
    const compiled = await resolveCompiledAgentConfigForSession(
      {
        projectId: input.projectId,
        repoUrl: input.repoUrl,
        defaultBranch: input.defaultBranch,
        manifestPath: input.manifestPath ?? 'kortix.yaml',
        gitAuthToken: null,
      },
      input.baseRef,
    );
    // `null` is a v1 project or an unreadable manifest. Pushing an empty value
    // would DELETE the agent config the box is running — a v1 project has none
    // to begin with, and for a transient read failure that would be a silent
    // downgrade to no agents at all. Leave the box as it is.
    if (!compiled) return { applied: false, reason: 'no compiled agent config' };

    const [row] = await db
      .select({ externalId: sessionSandboxes.externalId, config: sessionSandboxes.config })
      .from(sessionSandboxes)
      .where(
        and(eq(sessionSandboxes.sessionId, input.sessionId), eq(sessionSandboxes.status, 'active')),
      )
      .limit(1);
    if (!row?.externalId) return { applied: false, reason: 'no active sandbox' };

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
      opencodeEnv: {
        KORTIX_COMPILED_AGENT_CONFIG: compiled,
        // Pushed with the config so the box's reported etag never lags what it
        // is actually running.
        KORTIX_COMPILED_AGENT_CONFIG_ETAG: agentConfigEtag(compiled) ?? '',
      },
      // Restarts opencode so it rebuilds its config against the new agents.
      refreshModels: true,
    });
    return { applied: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[env-sync] agent-config push failed for session ${input.sessionId}:`, reason);
    return { applied: false, reason };
  }
}

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
      })
      .from(sessionSandboxes)
      .where(
        and(
          eq(sessionSandboxes.sessionId, input.sessionId),
          eq(sessionSandboxes.status, 'active'),
        ),
      )
      .limit(1);
    if (!row?.externalId) return { applied: false, reason: 'no active sandbox' };

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
      opencodeEnv: { KORTIX_OPENCODE_MODEL: input.model },
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
      })
      .from(sessionSandboxes)
      .where(
        and(
          eq(sessionSandboxes.sessionId, input.sessionId),
          eq(sessionSandboxes.status, 'active'),
        ),
      )
      .limit(1);
    if (!row?.externalId) return { applied: false, reason: 'no active sandbox' };

    const config = (row.config || {}) as Record<string, unknown>;
    const serviceKey = typeof config.serviceKey === 'string' ? config.serviceKey : null;
    if (!serviceKey) return { applied: false, reason: 'sandbox has no service key' };

    // Re-derive from the row the route JUST committed — `resolveOwnerRawEnv`
    // reads `secretsAllowlist` fresh, so this reflects the new scope, not the
    // boot snapshot the daemon is still running.
    const snapshot = await resolveSandboxEnvSnapshot(input.projectId, input.sessionId);
    if (!snapshot) return { applied: false, reason: 'no env snapshot' };

    const llmGatewayEnabled = await resolveProjectLlmGatewayEnabled(input.projectId);
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
      llmGatewayDenyEnv: llmGatewayEnabled ? nativeProviderEnvNames().join(',') : '',
    });
    await markSandboxLlmGatewayMode(input.sessionId, llmGatewayEnabled);
    return { applied: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[env-sync] scope push failed for session ${input.sessionId}:`, reason);
    return { applied: false, reason };
  }
}
