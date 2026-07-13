import { and, eq } from 'drizzle-orm';
import { projects, projectSessions, sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { resolvePreviewLink } from '../../sandbox-proxy/backend';
import { config } from '../../config';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { nativeProviderEnvNames } from '../../llm-gateway/sandbox-credentials';
import { listProjectSecretsSnapshotForUser, projectSecretsRevision } from '../secrets';
import { grantFromLoadedAgents, loadProjectAgents } from '../agents';
import { sanitizeSandboxEnv } from './sandbox-env-names';
import { daytonaPreviewHeaders } from './sandbox-daemon-ready';

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
    .select({ createdBy: projectSessions.createdBy, agentName: projectSessions.agentName })
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

  return (await listProjectSecretsSnapshotForUser(projectId, row.createdBy, grantEnv)).env;
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
  previewToken: string | null;
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
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${args.serviceKey}`,
    ...daytonaPreviewHeaders(args.previewToken),
  };

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

export async function syncSandboxEnvForPrompt(args: {
  projectId: string;
  sessionId: string;
  serviceKey: string | null;
  previewUrl: string;
  previewToken: string | null;
}): Promise<void> {
  if (!args.serviceKey) return;
  const snapshot = await resolveSandboxEnvSnapshot(args.projectId, args.sessionId);
  if (!snapshot) return;
  const llmGatewayEnabled = await resolveProjectLlmGatewayEnabled(args.projectId);
  await postEnvToDaemon({
    previewUrl: args.previewUrl,
    previewToken: args.previewToken,
    serviceKey: args.serviceKey,
    snapshot,
    refreshModels: true,
    llmGatewayEnabled,
    llmGatewayBaseUrl: llmGatewayEnabled ? resolveLlmGatewayBaseUrl() : undefined,
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
        const { url, token } = await resolvePreviewLink(row.externalId, SANDBOX_SERVICE_PORT);
        await postEnvToDaemon({ previewUrl: url, previewToken: token, serviceKey, snapshot, refreshModels: opts?.refreshModels });
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
        config: sessionSandboxes.config,
      })
      .from(sessionSandboxes)
      .where(and(eq(sessionSandboxes.projectId, projectId), eq(sessionSandboxes.status, 'active')));

    const targets = rows.filter((r): r is typeof r & { externalId: string } => !!r.externalId);
    if (targets.length === 0) return;

    const llmGatewayBaseUrl = resolveLlmGatewayBaseUrl();
    await runBounded(targets, FANOUT_CONCURRENCY, async (row) => {
      const rowConfig = (row.config || {}) as Record<string, unknown>;
      const serviceKey = typeof rowConfig.serviceKey === 'string' ? rowConfig.serviceKey : null;
      if (!serviceKey) return;
      try {
        const snapshot =
          (await resolveSandboxEnvSnapshot(projectId, row.sessionId)) ??
          emptySandboxEnvSnapshot(`llm-gateway-${enabled ? 'on' : 'off'}`);
        const { url, token } = await resolvePreviewLink(row.externalId, SANDBOX_SERVICE_PORT);
        await postEnvToDaemon({
          previewUrl: url,
          previewToken: token,
          serviceKey,
          snapshot,
          refreshModels: true,
          llmGatewayEnabled: enabled,
          llmGatewayBaseUrl: enabled ? llmGatewayBaseUrl : undefined,
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

function resolveLlmGatewayBaseUrl(): string {
  const kortixOrigin = config.KORTIX_URL.replace(/\/+$/, '');
  const llmProxyMode = config.LLM_GATEWAY_PROXY_PORT || config.LLM_GATEWAY_PROXY_TARGET;
  return (
    config.LLM_GATEWAY_BASE_URL ||
    (llmProxyMode ? `${kortixOrigin}/v1/llm-gateway/v1/llm` : `${kortixOrigin}/v1/llm`)
  );
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
