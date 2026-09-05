/**
 * Production wiring for the legacy runtime bootstrap: DB row → health probe →
 * provider exec → metadata + audit. The policy lives in
 * legacy-runtime-bootstrap.ts and is tested without any of this.
 */
import { sessionSandboxes } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { getProvider, type ProviderName } from '../../platform/providers';
import { readFileSync } from 'node:fs';
import { RUNTIME_VERSIONS as runtimeVersions } from '@kortix/shared/runtime-versions';
import { runtimeAssetsManifest, runtimeEntrypointPath } from '../../runtime-assets/manifest';
import { projectSessions, projects } from '@kortix/db';
import { sql } from 'drizzle-orm';
import { mintSessionToken } from '../../platform/services/session-sandbox';
import { buildSandboxUpstreamHeaders, resolveSandboxIngress } from '../../sandbox-proxy/backend';
import { recordAuditEvent } from '../../shared/audit';
import { db } from '../../shared/db';
import { OPENCODE_PRIMARY_PORT } from '../../shared/opencode-ports';
import { mergeMetadata } from '../reaping/sandbox-state-sync';
import {
  bootstrapLegacyRuntime,
  type LegacyBootstrapDeps,
  type LegacyBootstrapResult,
} from './legacy-runtime-bootstrap';

const SANDBOX_SERVICE_PORT = 8000;
const HEALTH_TIMEOUT_MS = 8_000;

export interface LegacyBootstrapRow {
  sandboxId: string;
  sessionId: string | null;
  accountId: string | null;
  projectId?: string | null;
  provider: ProviderName | string;
  externalId: string;
  metadata: Record<string, unknown> | null;
}

/** Kill switch + scope, read per call so a `kubectl set env` takes effect without a rebuild. */
export function legacyRuntimeBootstrapEnabled(): boolean {
  const raw = (process.env.LEGACY_RUNTIME_BOOTSTRAP ?? 'on').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

/** Concurrent bootstraps per API replica. Each one downloads ~100 MB into a box and holds a poll loop. */
const MAX_IN_FLIGHT = Number(process.env.LEGACY_RUNTIME_BOOTSTRAP_CONCURRENCY ?? '2') || 2;
const inFlight = new Set<string>();

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

/**
 * The daemon proxies OpenCode routes behind the sandbox service key AND the
 * signed per-user context every proxied request carries; the control plane
 * probes as the user who provisioned the box (or the session's creator).
 */
async function opencodeProbeHeaders(
  row: LegacyBootstrapRow,
  providerHeaders: Record<string, string>,
): Promise<Record<string, string> | null> {
  const [sb] = await db
    .select({ config: sessionSandboxes.config, metadata: sessionSandboxes.metadata })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sandboxId, row.sandboxId))
    .limit(1);
  const config = (sb?.config ?? null) as Record<string, unknown> | null;
  const serviceKey = typeof config?.serviceKey === 'string' ? (config.serviceKey as string) : null;
  if (!serviceKey) return null;
  const metadata = (sb?.metadata ?? null) as Record<string, unknown> | null;
  let userId = typeof metadata?.provisionedBy === 'string' ? (metadata.provisionedBy as string) : null;
  if (!userId && row.sessionId) {
    const [session] = await db
      .select({ createdBy: projectSessions.createdBy })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, row.sessionId))
      .limit(1);
    userId = session?.createdBy ?? null;
  }
  if (!userId) return null;
  return buildSandboxUpstreamHeaders({ sandboxId: row.sandboxId, userId, serviceKey, providerHeaders });
}

/**
 * Legacy token model. A box provisioned before 2026-08 carries a `kortix_sb_`
 * sandbox API key as its service key / KORTIX_TOKEN; the LLM gateway resolves
 * only PATs, so every model call from such a box 401s once the current daemon
 * runs (it authenticates the LLM proxy with KORTIX_TOKEN). Mint the session PAT
 * provisioning mints today; the script installs it in the box and the service
 * key is switched only after the box reports holding it — the daemon's inbound
 * auth and the API's signed user context must agree on one secret.
 */
async function mintReplacementServiceKey(row: LegacyBootstrapRow): Promise<string | null> {
  if (!row.sessionId) return null;
  const [sb] = await db
    .select({ config: sessionSandboxes.config })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sandboxId, row.sandboxId))
    .limit(1);
  const config = (sb?.config ?? null) as Record<string, unknown> | null;
  const current = typeof config?.serviceKey === 'string' ? (config.serviceKey as string) : '';
  if (!current.startsWith('kortix_sb_')) return null;
  const [session] = await db
    .select({
      accountId: projectSessions.accountId,
      projectId: projectSessions.projectId,
      createdBy: projectSessions.createdBy,
      agentName: projectSessions.agentName,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, row.sessionId))
    .limit(1);
  if (!session?.createdBy) return null;
  const [project] = await db
    .select({
      projectId: projects.projectId,
      repoUrl: projects.repoUrl,
      defaultBranch: projects.defaultBranch,
      manifestPath: projects.manifestPath,
    })
    .from(projects)
    .where(eq(projects.projectId, session.projectId))
    .limit(1);
  if (!project) return null;
  return mintSessionToken({
    accountId: session.accountId,
    userId: session.createdBy,
    projectId: session.projectId,
    sandboxId: row.sessionId,
    agentName: session.agentName ?? 'default',
    gitProject: { ...project, gitAuthToken: null },
  });
}

async function commitReplacementServiceKey(
  row: LegacyBootstrapRow,
  secret: string,
  rotatedOnBox: boolean | null,
): Promise<void> {
  let holds = rotatedOnBox === true;
  if (rotatedOnBox === null) {
    // The report never arrived: ask the box. A user-context probe signed with
    // the new secret succeeds only if the daemon's KORTIX_TOKEN is that secret.
    holds = await probeDaemonWithServiceKey(row, secret);
  }
  if (!holds) {
    console.warn(`[legacy-bootstrap] ${row.sandboxId}: box did not take the rotated token; service key unchanged`);
    return;
  }
  const patch = { serviceKey: secret, serviceKeyRotatedAt: new Date().toISOString(), legacyServiceKeyRetiredAt: new Date().toISOString() };
  await db
    .update(sessionSandboxes)
    .set({ config: sql`coalesce(${sessionSandboxes.config}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
}

async function probeDaemonWithServiceKey(row: LegacyBootstrapRow, serviceKey: string): Promise<boolean> {
  try {
    const [sb] = await db
      .select({ metadata: sessionSandboxes.metadata })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sandboxId, row.sandboxId))
      .limit(1);
    const metadata = (sb?.metadata ?? null) as Record<string, unknown> | null;
    const userId = typeof metadata?.provisionedBy === 'string' ? (metadata.provisionedBy as string) : null;
    if (!userId) return false;
    const { url, headers } = await resolveSandboxIngress(row.externalId, { port: OPENCODE_PRIMARY_PORT, transport: 'http' });
    const probeHeaders = await buildSandboxUpstreamHeaders({ sandboxId: row.sandboxId, userId, serviceKey, providerHeaders: headers });
    const res = await fetch(`${url.replace(/\/$/, '')}/session/status`, { headers: probeHeaders, signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

export function buildLegacyBootstrapDeps(row: LegacyBootstrapRow): LegacyBootstrapDeps {
  const provider = getProvider(row.provider as ProviderName);
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    manifestBuild: async () => {
      try {
        return (await runtimeAssetsManifest()).build;
      } catch {
        return null;
      }
    },
    fetchHealth: async () => {
      try {
        const { url, headers } = await resolveSandboxIngress(row.externalId, {
          port: SANDBOX_SERVICE_PORT,
          transport: 'http',
        });
        return await fetchJson(`${url.replace(/\/$/, '')}/kortix/health`, headers);
      } catch {
        // A stopped box has no ingress to resolve: unreachable, not an error.
        return null;
      }
    },
    fetchOpencodeStatus: async () => {
      // OpenCode routes are proxied by the daemon behind the sandbox service
      // key plus the signed user context every proxied user request carries;
      // health is the only unauthenticated daemon route.
      try {
        const { url, headers } = await resolveSandboxIngress(row.externalId, {
          port: OPENCODE_PRIMARY_PORT,
          transport: 'http',
        });
        const probeHeaders = await opencodeProbeHeaders(row, headers);
        if (!probeHeaders) return null;
        const body = await fetchJson(`${url.replace(/\/$/, '')}/session/status`, probeHeaders);
        return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    },
    entrypointSource: () => {
      try {
        return readFileSync(runtimeEntrypointPath(), 'utf8');
      } catch {
        return null;
      }
    },
    pnpmVersion: () => (typeof (runtimeVersions as { pnpm?: unknown }).pnpm === 'string' ? ((runtimeVersions as { pnpm: string }).pnpm) : null),
    rotateKortixToken: () => mintReplacementServiceKey(row),
    commitKortixToken: (secret, rotatedOnBox) => commitReplacementServiceKey(row, secret, rotatedOnBox),
    exec: async (command, timeoutMs) => {
      if (!provider.exec) throw new Error(`provider ${row.provider} has no exec channel`);
      return provider.exec(row.externalId, command, { timeoutMs });
    },
    patchMetadata: async (patch) => {
      await db
        .update(sessionSandboxes)
        .set({ metadata: mergeMetadata(patch) })
        .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
    },
    audit: async (event) => {
      await recordAuditEvent({
        accountId: row.accountId ?? null,
        projectId: row.projectId ?? null,
        sessionId: row.sessionId ?? null,
        actorType: 'system',
        source: 'legacy-runtime-bootstrap',
        action: 'sandbox.runtime.legacy_bootstrap',
        phase: event.phase,
        resourceType: 'sandbox',
        resourceId: row.sandboxId,
        outcome: event.outcome,
        outputSummary: { externalId: row.externalId, provider: row.provider, ...event.summary },
        errorMessage: event.error ?? null,
      }).catch((err) =>
        console.warn(
          '[legacy-bootstrap] audit write failed:',
          err instanceof Error ? err.message : err,
        ),
      );
    },
    log: (message, context) => console.log(`[legacy-bootstrap] ${message}`, context ?? ''),
  };
}

/** Run one bootstrap to completion. Used by the operator sweep and by the reaper's scheduler. */
export async function runLegacyRuntimeBootstrap(
  row: LegacyBootstrapRow,
  reason: string,
  opts: { force?: boolean } = {},
): Promise<LegacyBootstrapResult> {
  return bootstrapLegacyRuntime(
    {
      sandboxId: row.sandboxId,
      externalId: row.externalId,
      provider: row.provider,
      metadata: row.metadata,
      reason,
      force: opts.force,
    },
    buildLegacyBootstrapDeps(row),
  );
}

/**
 * Reaper entry point: fire-and-forget with a per-replica concurrency cap. The
 * policy's own gates (recent-check TTL, cooldown, budget, busy) make this
 * cheap on a converged fleet — one health probe per box per 6 h.
 */
export function scheduleLegacyRuntimeBootstrap(row: LegacyBootstrapRow, reason = 'reaper'): boolean {
  if (!legacyRuntimeBootstrapEnabled()) return false;
  if (!row.externalId) return false;
  if (inFlight.has(row.sandboxId) || inFlight.size >= MAX_IN_FLIGHT) return false;
  inFlight.add(row.sandboxId);
  void runLegacyRuntimeBootstrap(row, reason)
    .catch((err) =>
      console.warn(
        `[legacy-bootstrap] ${row.sandboxId} failed:`,
        err instanceof Error ? err.message : err,
      ),
    )
    .finally(() => inFlight.delete(row.sandboxId));
  return true;
}

/** Test seam. */
export function legacyBootstrapInFlightCount(): number {
  return inFlight.size;
}
