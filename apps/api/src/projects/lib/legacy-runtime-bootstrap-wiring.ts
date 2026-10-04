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
import { createAccountToken, revokeAccountToken } from '../../repositories/account-tokens';
import { mintSessionToken } from '../../platform/services/session-sandbox';
import { buildSandboxUpstreamHeaders, resolveSandboxIngress } from '../../sandbox-proxy/backend';
import { recordAuditEvent } from '../../services/audit/audit';
import { db } from '../../lib/db';
import { OPENCODE_PRIMARY_PORT } from '../../services/sessions/opencode-ports';
import { mergeMetadata } from '../reaping/sandbox-state-sync';
import {
  bootstrapLegacyRuntime,
  classifyDaemonHealth,
  describeLegacyBootstrapRetry,
  opencodeIdle,
  type LegacyBootstrapDeps,
  type LegacyBootstrapResult,
  type LegacyBootstrapRetrySummary,
  type RuntimeClassification,
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

/**
 * How long the repair's own credential lives. It is revoked the moment the
 * exec returns; the expiry is only the backstop for a process that dies
 * mid-repair. Sized to the script's exec budget, not to the session.
 */
const REPAIR_TOKEN_TTL_MS = 30 * 60_000;

/**
 * Mint the credential the repair runs on.
 *
 * NOT a session credential. `validateAccountToken` refuses any token carrying
 * a `session_id` whose sandbox row is not `provisioning`/`active`
 * (repositories/account-tokens.ts) — which is exactly the state a repair has
 * to work in. A project-scoped PAT with a short expiry is vouched for by the
 * control plane at repair time and is not hostage to the row being repaired.
 * It only ever fetches `/v1/runtime-assets/*`, and it is revoked when the exec
 * returns.
 */
async function mintRepairCredential(
  row: LegacyBootstrapRow,
): Promise<{ secret: string; release: () => Promise<void> } | null> {
  if (!row.sessionId) return null;
  const [session] = await db
    .select({
      accountId: projectSessions.accountId,
      projectId: projectSessions.projectId,
      createdBy: projectSessions.createdBy,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, row.sessionId))
    .limit(1);
  if (!session?.createdBy) return null;
  const token = await createAccountToken({
    accountId: session.accountId,
    userId: session.createdBy,
    projectId: session.projectId,
    name: `Runtime repair ${row.sandboxId.slice(0, 8)}`,
    expiresAt: new Date(Date.now() + REPAIR_TOKEN_TTL_MS),
    // Purpose-scoped, NOT a laptop-CLI PAT. A project-scoped token with a null
    // `agentGrant` resolves to the full project authority of `session.createdBy`;
    // an EMPTY grant makes `agentMayPerform` deny every `project.*` action while
    // the authentication-only `/v1/runtime-assets/*` routes stay reachable, which
    // is all the repair fetches. The narrow scope is enforced by the token model
    // here, not merely described by the script's behaviour.
    agentGrant: { agent: 'runtime-repair', permissions: [], connectors: [], env: [] },
  });
  return {
    secret: token.secretKey,
    release: async () => {
      await revokeAccountToken(token.tokenId, session.accountId, session.projectId);
    },
  };
}

export function buildLegacyBootstrapDeps(row: LegacyBootstrapRow): LegacyBootstrapDeps {
  const provider = getProvider(row.provider as ProviderName);
  return {
    now: () => Date.now(),
    sleep: Bun.sleep,
    manifestBuild: async () => {
      try {
        return (await runtimeAssetsManifest()).build;
      } catch {
        return null;
      }
    },
    // The `running_assets_stale` sha-to-sha compare (classifyDaemonHealth):
    // this deploy's own manifest, never the box's opinion of itself.
    expectedRunningAssets: async () => {
      try {
        const manifest = await runtimeAssetsManifest();
        return {
          cli_sha256: manifest.cli_sha256,
          managed_skills_hash: manifest.managed_skills_hash,
          agent_sha256: manifest.components.agent?.sha256 ?? null,
        };
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
    mintRepairToken: () => mintRepairCredential(row),
    // Asked only when the daemon answered nothing: is there still a box there?
    providerRunning: async () => (await provider.getStatus(row.externalId)) === 'running',
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

/** Per-replica concurrency cap, for tests that need to see it (production reads it off `inFlight.size` internally). */
export { MAX_IN_FLIGHT };

/** Tests only: forget every in-flight sandbox between runs. Production never calls this. */
export function __resetLegacyBootstrapInFlightForTests(): void {
  inFlight.clear();
}

/**
 * Reaper entry point: fire-and-forget with a per-replica concurrency cap. The
 * policy's own gates (recent-check TTL, cooldown, budget, busy) make this
 * cheap on a converged fleet — one health probe per box per 6 h.
 *
 * `runner` is overridable ONLY for tests (the repair-storm guard on
 * `MAX_IN_FLIGHT`) — production always uses the real
 * `runLegacyRuntimeBootstrap`, which is why it is the default rather than a
 * required argument.
 */
export function scheduleLegacyRuntimeBootstrap(
  row: LegacyBootstrapRow,
  reason = 'reaper',
  runner: (row: LegacyBootstrapRow, reason: string) => Promise<LegacyBootstrapResult> = runLegacyRuntimeBootstrap,
): boolean {
  if (!legacyRuntimeBootstrapEnabled()) return false;
  if (!row.externalId) return false;
  if (inFlight.has(row.sandboxId) || inFlight.size >= MAX_IN_FLIGHT) return false;
  inFlight.add(row.sandboxId);
  void runner(row, reason)
    .catch((err) =>
      console.warn(
        `[legacy-bootstrap] ${row.sandboxId} failed:`,
        err instanceof Error ? err.message : err,
      ),
    )
    .finally(() => inFlight.delete(row.sandboxId));
  return true;
}

export type OpenRuntimeGuaranteeAction = 'proceed' | 'defer_turn_running' | 'repairing' | 'exhausted' | 'blocked';

export interface OpenRuntimeGuaranteeOutcome {
  action: OpenRuntimeGuaranteeAction;
  /** Null only when the guarantee is disabled or the health probe itself failed (fail-open — see `guaranteeCurrentRuntimeOnOpen`). */
  classification: RuntimeClassification | null;
  retry?: LegacyBootstrapRetrySummary;
}

/**
 * THE session-open guarantee: "open any session and it works, or it says
 * plainly why not" (the owner's acceptance bar). Shares the exact
 * classification and the exact repair the reaper schedules in the
 * background — this is the synchronous half of the same mechanism, not a
 * second implementation.
 *
 * Bounded on purpose: at most a health probe and (only for a stale/legacy
 * box) one OpenCode status probe — a few seconds, matching
 * `HEALTH_TIMEOUT_MS`. The actual repair (provider exec + relaunch, up to
 * `LEGACY_BOOTSTRAP_CONVERGE_BUDGET_MS` = 8 min to converge) is FIRED via
 * `scheduleRepair` and never awaited here — the caller reports `repairing`
 * and the client's own poll loop observes convergence on a later call,
 * exactly like `runtime_waking`/`cooling_down` already work in
 * `runOpenSession`. Never fires under a live turn (`opencodeIdle` gate,
 * shared with `bootstrapLegacyRuntime`) — a relaunch kills PTYs and ends
 * in-flight work.
 */
export async function guaranteeCurrentRuntimeOnOpen(
  row: LegacyBootstrapRow,
  depsOverride?: LegacyBootstrapDeps,
  scheduleRepair: (row: LegacyBootstrapRow, reason?: string) => boolean = scheduleLegacyRuntimeBootstrap,
): Promise<OpenRuntimeGuaranteeOutcome> {
  if (!legacyRuntimeBootstrapEnabled()) return { action: 'proceed', classification: null };

  // `buildLegacyBootstrapDeps` is NOT a safe default-parameter expression: it
  // calls `getProvider(row.provider)` synchronously, which throws for a
  // provider whose API key is unset. A default parameter evaluates during
  // the CALL, before this function's own body (and its caller's `.catch()`
  // on the returned promise) exists to catch it — the exact way `POST
  // .../start` started 500ing for any row on a provider without full
  // production credentials configured. Resolving it here, inside the async
  // body, turns that throw into an ordinary rejected promise like every
  // other failure this function fails open on.
  let deps: LegacyBootstrapDeps;
  try {
    deps = depsOverride ?? buildLegacyBootstrapDeps(row);
  } catch (err) {
    console.warn(`[runtime-guarantee] could not build deps for ${row.sandboxId}:`, err instanceof Error ? err.message : err);
    return { action: 'proceed', classification: null };
  }

  const health = await deps.fetchHealth();
  const expectedRunningAssets = await deps.expectedRunningAssets?.();
  const classification = classifyDaemonHealth(health, expectedRunningAssets ?? undefined);
  if (classification.klass === 'blocked') {
    // The daemon's own supervisor already tried and rolled back. Surfacing
    // this, never looping a repair on it, is the whole point of `blocked`
    // existing as its own klass — see classifyDaemonHealth's module doc.
    return { action: 'blocked', classification };
  }
  if (classification.klass !== 'legacy' && classification.klass !== 'stale') {
    // 'current' → nothing to do. 'unreachable'/'not-ok' here means the health
    // probe itself failed even though the caller already confirmed the
    // provider is running and OpenCode answered moments earlier — fail open
    // rather than block a session open on a second, redundant probe flaking.
    return { action: 'proceed', classification };
  }

  const status = await deps.fetchOpencodeStatus();
  if (!opencodeIdle(status)) {
    // A live turn owns this box. Relaunching would kill it. The reaper's own
    // background pass applies the identical gate and will repair it once the
    // turn ends.
    return { action: 'defer_turn_running', classification };
  }

  const manifestBuild = await deps.manifestBuild();
  const retry = describeLegacyBootstrapRetry(row.metadata, manifestBuild, deps.now());
  if (retry.status === 'exhausted') {
    return { action: 'exhausted', classification, retry };
  }
  if (retry.status !== 'cooldown') {
    // Idle, not already cooling down: fire the SAME bootstrap the reaper
    // schedules. Fire-and-forget — bounded by MAX_IN_FLIGHT per replica and
    // by the metadata record's own in-flight guard cross-replica
    // (`LEGACY_BOOTSTRAP_STALE_RUNNING_MS`) — this call never waits for it.
    scheduleRepair(row, 'session-open');
  }
  return { action: 'repairing', classification, retry };
}
