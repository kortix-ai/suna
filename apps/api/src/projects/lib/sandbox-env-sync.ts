import { and, eq } from 'drizzle-orm';
import { projects, projectSessions, sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { KORTIX_USER_CONTEXT_HEADER } from '../../shared/kortix-user-context';
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
import { grantFromLoadedAgents, loadProjectAgents } from '../agents';
import { sanitizeSandboxEnv } from './sandbox-env-names';

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
}

async function resolveOwnerRawEnv(
  projectId: string,
  sessionId: string | null,
): Promise<Record<string, string> | null> {
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

  // Resolve the running agent's `secrets` grant (by identifier) — the SAME gate
  // applied at sandbox boot (buildSessionSandboxEnvVars). A hot-push must not
  // deliver an identifier a scoped agent isn't granted; back-compat/no-git-
  // context sessions default to 'all' (undefined).
  const [project] = await db
    .select({
      repoUrl: projects.repoUrl,
      defaultBranch: projects.defaultBranch,
      manifestPath: projects.manifestPath,
    })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);

  let grantEnv: string[] | 'all' | undefined;
  if (project?.defaultBranch) {
    const loadedAgents = await loadProjectAgents({
      projectId,
      repoUrl: project.repoUrl ?? '',
      defaultBranch: project.defaultBranch,
      manifestPath: project.manifestPath ?? 'kortix.yaml',
      gitAuthToken: null,
    }).catch(() => null);
    const grant = loadedAgents ? grantFromLoadedAgents(row.agentName ?? '', loadedAgents) : null;
    grantEnv = grant?.env;
  }

  // THE CLOBBER FIX: apply the SAME per-session secrets narrowing as boot
  // (buildSessionSandboxEnvVars). Without this, the first prompt's env sync (and
  // every secret-CRUD fan-out) would re-push the full agent-grant set into a
  // narrowed sandbox, silently widening it back. null allowlist → passthrough.
  const grantEnvForSession = intersectSecretGrants(grantEnv, row.secretsAllowlist ?? null);
  return (await listProjectSecretsSnapshotForUser(projectId, row.createdBy, grantEnvForSession)).env;
}

export async function resolveSandboxEnvSnapshot(
  projectId: string,
  sessionId: string | null,
): Promise<SandboxEnvSnapshot | null> {
  const raw = await resolveOwnerRawEnv(projectId, sessionId);
  if (!raw) return null;
  const { env, names } = sanitizeSandboxEnv(raw);
  return { env, names, revision: projectSecretsRevision(env) };
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
  llmGatewayEnabled?: boolean;
  llmGatewayBaseUrl?: string;
  llmGatewayDenyEnv?: string;
}): Promise<void> {
  if (!isSecureOrPrivateTarget(args.previewUrl)) {
    throw new Error('refusing to push secrets over insecure transport (non-TLS public host)');
  }
  const headers = buildEnvSyncHeaders(args);

  const res = await fetch(`${args.previewUrl.replace(/\/$/, '')}/kortix/env`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...args.snapshot,
      refreshModels: args.refreshModels ?? false,
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
  await res.arrayBuffer().catch(() => undefined);
}

/** Build the service-to-service env-sync boundary. Provider ingress credentials
 * are preserved, but a user-scoped preview context must never reach the daemon's
 * privileged secret refresh route or override its sandbox service credential. */
export function buildEnvSyncHeaders(args: {
  providerHeaders: Record<string, string>;
  serviceKey: string;
}): Headers {
  const headers = new Headers(args.providerHeaders);
  headers.delete(KORTIX_USER_CONTEXT_HEADER);
  headers.set('Authorization', `Bearer ${args.serviceKey}`);
  headers.set('Content-Type', 'application/json');
  return headers;
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
}): Promise<void> {
  if (!args.serviceKey) return;
  const snapshot = await resolveSandboxEnvSnapshot(args.projectId, args.sessionId);
  if (!snapshot) return;
  const llmGatewayEnabled = await resolveProjectLlmGatewayEnabled(args.projectId);
  await postEnvToDaemon({
    previewUrl: args.previewUrl,
    providerHeaders: args.providerHeaders,
    serviceKey: args.serviceKey,
    snapshot,
    refreshModels: true,
    llmGatewayEnabled,
    llmGatewayBaseUrl: llmGatewayEnabled ? llmGatewayBaseUrlForProvider(args.providerName) : undefined,
    llmGatewayDenyEnv: llmGatewayEnabled ? nativeProviderEnvNames().join(',') : '',
  });
  // The ACP daemon recycles only idle processes and starts the selected harness
  // again on the immediately following /acp request. Busy processes are deferred
  // by the daemon so a credential rotation never kills an in-flight turn.
  await markSandboxLlmGatewayMode(args.sessionId, llmGatewayEnabled);
}

export async function propagateProjectSecretsToActiveSandboxes(
  projectId: string,
  opts?: { refreshModels?: boolean },
): Promise<void> {
  try {
    const rows = await db
      .select({
        externalId: sessionSandboxes.externalId,
        sessionId: sessionSandboxes.sessionId,
        config: sessionSandboxes.config,
      })
      .from(sessionSandboxes)
      .where(and(eq(sessionSandboxes.projectId, projectId), eq(sessionSandboxes.status, 'active')));

    const targets = rows.filter((r): r is typeof r & { externalId: string } => !!r.externalId);
    if (targets.length === 0) return;

    await runBounded(targets, FANOUT_CONCURRENCY, async (row) => {
      const config = (row.config || {}) as Record<string, unknown>;
      const serviceKey = typeof config.serviceKey === 'string' ? config.serviceKey : null;
      if (!serviceKey) return;
      try {
        const snapshot = await resolveSandboxEnvSnapshot(projectId, row.sessionId);
        if (!snapshot) return;
        const { url, headers } = await resolveSandboxIngress(row.externalId, {
          port: SANDBOX_SERVICE_PORT,
          transport: 'http',
        });
        await postEnvToDaemon({
          previewUrl: url,
          providerHeaders: headers,
          serviceKey,
          snapshot,
          refreshModels: opts?.refreshModels,
        });
      } catch (err) {
        console.warn(
          `[env-sync] hot push failed for sandbox ${row.externalId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    });
  } catch (err) {
    console.warn(
      `[env-sync] hot fan-out failed for project ${projectId}:`,
      err instanceof Error ? err.message : err,
    );
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
        const { url, headers } = await resolveSandboxIngress(row.externalId, {
          port: SANDBOX_SERVICE_PORT,
          transport: 'http',
        });
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
