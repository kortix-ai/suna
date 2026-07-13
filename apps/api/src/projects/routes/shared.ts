import { reopenComputeForSandbox } from '../../billing/services/compute-metering';
import { config, type SandboxProviderName } from '../../config';
import type { ProjectSessionSandbox, SessionStartResult } from '@kortix/api-contract';
import { auth, json } from '../../openapi';
import { getProvider, type SandboxStatus } from '../../platform/providers';
import { db } from '../../shared/db';
import { resolveBranchTip } from '../git';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { rehydrateSessionChat } from '../legacy-migration-rehydrate';
import { changeRequests, projectSessions, sessionSandboxes } from '@kortix/db';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { resolveProjectGitAuth } from '../lib/git';
import { ProjectRow, serializeSessionSandboxConfig } from '../lib/serializers';
import { allocateSessionRuntime } from '../lib/session-runtime-allocator';
import {
  buildSessionSandboxEnvVars,
  sandboxCallbackUnreachableReason,
} from '../lib/sessions';
import { inspectSandboxRuntime } from '../runtime-inspection';
import {
  claimInPlaceRuntimeRecovery,
  finalizeRecoveredRuntimeIfRunning,
  markInPlaceRuntimeRecoveryAccepted,
  preserveEstablishedRuntime,
  retireUnmaterializedRuntime,
  RUNTIME_IDENTITY_UNAVAILABLE,
} from '../runtime-identity';

/**
 * Resume a hibernated (status='stopped') session sandbox IN PLACE instead of
 * destroying it and cold-reprovisioning a fresh one. A stopped row whose
 * `externalId` is still set is a powered-down VM whose disk — the repo clone,
 * installed dependencies and harness state is intact, so resuming it skips the dominant boot
 * costs (snapshot pull + clone + deps).
 *
 * Atomically wins the stopped→active transition (so concurrent opens don't
 * double-start the provider), flips the session back to `running`, reopens
 * compute metering, and kicks the provider start in the background. The
 * caller returns `active` immediately; the frontend's existing health poll
 * waits for the container to come back — identical to the idle-wake path.
 *
 * On a hard provider-start failure the row is reverted to `stopped` so the
 * next open simply retries the resume (transient blips self-heal).
 *
 * Returns true when THIS call won the transition (and kicked the start).
 */
export async function resumeStoppedSandbox(row: {
  sandboxId: string;
  sessionId: string;
  accountId: string;
  provider: string;
  externalId: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<boolean> {
  if (!row.externalId) return false;
  if (!(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(row.provider)) return false;

  const externalId = row.externalId;
  const now = new Date();
  const runtimeWakeId = crypto.randomUUID();
  const wakeMetadata = { ...(row.metadata ?? {}) };
  for (const key of [
    'idleQuiesced',
    'idleQuiescedAt',
    'idleObservedAt',
    'runtimeIdentityState',
    'runtimeUnavailableReason',
    'runtimeUnavailableAt',
    'preservedExternalId',
    'needsReprovision',
    'runtimeWakeError',
    'runtimeWakeFailedAt',
  ])
    delete wakeMetadata[key];
  Object.assign(wakeMetadata, {
    lastTurnAt: now.toISOString(),
    runtimeWakeStartedAt: now.toISOString(),
    runtimeWakeId,
    runtimeWakeProviderStatus: 'starting',
  });
  // Conditional update = the lock: only the request that flips stopped→active
  // proceeds to start the VM. Concurrent polls see `active` and just return it.
  const [won] = await db
    .update(sessionSandboxes)
    .set({
      status: 'active',
      updatedAt: now,
      // Explicit resume clears the reaper's idle-quiesce marker AND its idle
      // countdown (idleObservedAt — a stale pre-stop stamp would shut the box
      // down on the very next pass), and stamps lastTurnAt so the resume opens
      // a FRESH idle window for the unreachable-box fallback clock too.
      metadata: wakeMetadata,
    })
    .where(
      and(eq(sessionSandboxes.sandboxId, row.sandboxId), eq(sessionSandboxes.status, 'stopped')),
    )
    .returning();
  if (!won) return false;

  await db
    .update(projectSessions)
    .set({ status: 'running', updatedAt: now })
    .where(eq(projectSessions.sessionId, row.sessionId))
    .catch((err) =>
      console.warn(
        `[projects] failed to mark session running on resume for ${row.sessionId}:`,
        err,
      ),
    );

  void reopenComputeForSandbox(row.sandboxId, row.accountId, row.sessionId).catch((err) =>
    console.warn(`[projects] compute reopen failed for ${row.sandboxId}:`, err),
  );

  const provider = getProvider(row.provider as SandboxProviderName);
  void provider
    .start(externalId)
    .then(async () => {
    await db
      .update(sessionSandboxes)
      .set({
        metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) - 'runtimeWakeStartedAt' - 'runtimeWakeId' - 'runtimeWakeProviderStatus' - 'runtimeWakeError' - 'runtimeWakeFailedAt'`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessionSandboxes.sandboxId, row.sandboxId),
          eq(sessionSandboxes.externalId, externalId),
          sql`${sessionSandboxes.metadata}->>'runtimeWakeId' = ${runtimeWakeId}`,
        ),
      )
      .catch((err) =>
          console.warn(`[runtime-identity] failed to clear wake fence for ${row.sessionId}:`, err),
      );
    })
    .catch(async (err) => {
    console.warn(
      `[projects] failed to resume sandbox ${externalId} for session ${row.sessionId}:`,
      err,
    );
    // Never retire or replace an established identity based on a provider
    // start error. Revert this exact fenced wake so a later explicit open can
    // retry the original sandbox in place.
    await db
      .update(sessionSandboxes)
      .set({
        status: 'stopped',
        metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${JSON.stringify({ runtimeWakeError: isMissingRuntimeError(err) ? 'missing' : 'start_failed', runtimeWakeFailedAt: new Date().toISOString() })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessionSandboxes.sandboxId, row.sandboxId),
          eq(sessionSandboxes.externalId, externalId),
          sql`${sessionSandboxes.metadata}->>'runtimeWakeId' = ${runtimeWakeId}`,
        ),
      )
      .catch(() => {});
    await db
      .update(projectSessions)
      .set({ status: 'stopped', updatedAt: new Date() })
      .where(eq(projectSessions.sessionId, row.sessionId))
      .catch(() => {});
  });
  return true;
}

/**
 * Resume a stopped box addressed by its provider `external_id` (the id in proxy
 * URLs, `/v1/p/<externalId>/<port>`). Fetches the full row — crucially including
 * `metadata`, which {@link resumeStoppedSandbox} rewrites — so the sandbox-proxy
 * data path can wake a hibernated box the SAME way `/start` does when a real user
 * actively hits the OpenCode runtime. Idempotent: the conditional stopped→active
 * lock inside `resumeStoppedSandbox` de-dupes the concurrent session.list retries,
 * so at most one provider start is kicked. Returns true when THIS call won the
 * resume (false if it wasn't stopped, isn't resumable, or a concurrent call won).
 */
export async function resumeStoppedSandboxByExternalId(externalId: string): Promise<boolean> {
  const [row] = await db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      sessionId: sessionSandboxes.sessionId,
      accountId: sessionSandboxes.accountId,
      provider: sessionSandboxes.provider,
      externalId: sessionSandboxes.externalId,
      status: sessionSandboxes.status,
      metadata: sessionSandboxes.metadata,
    })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.externalId, externalId))
    .limit(1);
  if (!row || row.status !== 'stopped' || !row.externalId) return false;
  return resumeStoppedSandbox({
    sandboxId: row.sandboxId,
    sessionId: row.sessionId,
    accountId: row.accountId,
    provider: row.provider,
    externalId: row.externalId,
    metadata: row.metadata,
  });
}

// ── Pre-resume on presence ───────────────────────────────────────────────────
// Throttle pre-resume per project so portal activity doesn't re-kick on every
// request. The resume itself is idempotent (resumeStoppedSandbox only acts on a
// stopped→active transition), so this is purely to avoid wasted DB lookups.
const preResumeThrottle = new Map<string, number>();
const PRERESUME_THROTTLE_MS = 30_000;

/**
 * When a user returns to a project, proactively resume their most-recently-used
 * STOPPED session sandbox(es) so the in-place resume (VM restart + ACP runtime
 * re-warm) overlaps the user's navigation and the session is ready by the time
 * they open it. Reuses resumeStoppedSandbox (idempotent with the on-open resume:
 * if the box is already resuming/active, the conditional stopped→active lock
 * simply no-ops). Best-effort + fire-and-forget; GATED OFF by default
 * (KORTIX_PRERESUME_ENABLED) since it spends compute on a box the user might not
 * open. Scoped to the user's OWN sessions (never speculatively resumes someone
 * else's). Most-recent-first, capped at KORTIX_PRERESUME_MAX_PER_PROJECT.
 */
/**
 * The pre-resume candidates: the user's OWN most-recently-used STOPPED session
 * sandboxes in a project (status='stopped', a provider box still attached).
 * Most-recent-first, capped at `limit`. Pure DB read, no side effects —
 * exported so the selection is testable without provisioning real sandboxes.
 */
export async function selectPreResumeTargets(
  projectId: string,
  userId: string,
  limit: number,
): Promise<
  Array<{
    sandboxId: string;
    sessionId: string;
    accountId: string;
    provider: string;
    externalId: string | null;
    metadata: Record<string, unknown> | null;
  }>
> {
  return db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      sessionId: sessionSandboxes.sessionId,
      accountId: sessionSandboxes.accountId,
      provider: sessionSandboxes.provider,
      externalId: sessionSandboxes.externalId,
      metadata: sessionSandboxes.metadata,
    })
    .from(sessionSandboxes)
    .innerJoin(projectSessions, eq(projectSessions.sessionId, sessionSandboxes.sessionId))
    .where(
      and(
      eq(sessionSandboxes.projectId, projectId),
      eq(sessionSandboxes.status, 'stopped'),
      isNotNull(sessionSandboxes.externalId),
      eq(projectSessions.createdBy, userId),
      ),
    )
    .orderBy(desc(sessionSandboxes.lastUsedAt))
    .limit(Math.max(1, limit));
}

export function preResumeRecentStoppedSessions(projectId: string, userId?: string | null): void {
  if (!config.KORTIX_PRERESUME_ENABLED || !projectId || !userId) return;
  const nowMs = Date.now();
  if (nowMs - (preResumeThrottle.get(projectId) ?? 0) < PRERESUME_THROTTLE_MS) return;
  preResumeThrottle.set(projectId, nowMs);
  void (async () => {
    try {
      const rows = await selectPreResumeTargets(
        projectId,
        userId,
        config.KORTIX_PRERESUME_MAX_PER_PROJECT,
      );
      let kicked = 0;
      for (const row of rows) {
        const won = await resumeStoppedSandbox(row).catch((err) => {
          console.warn(
            `[pre-resume] resume ${row.sandboxId.slice(0, 8)} failed:`,
            err instanceof Error ? err.message : err,
          );
          return false;
        });
        if (won) kicked++;
      }
      if (kicked)
        console.log(`[pre-resume] kicked ${kicked} resume(s) for project ${projectId.slice(0, 8)}`);
    } catch (err) {
      console.warn('[pre-resume] failed:', err instanceof Error ? err.message : err);
      preResumeThrottle.delete(projectId); // let the next presence retry
    }
  })();
}

export async function allocateRuntimeOnOpen(
  loaded: { row: ProjectRow; userId: string },
  session: {
    sandboxProvider: string;
    baseRef: string | null;
    agentName: string | null;
    metadata?: Record<string, unknown> | null;
  },
  projectId: string,
  sessionId: string,
): Promise<void> {
  const providerName = session.sandboxProvider as SandboxProviderName;
  if (!(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(providerName)) return;
  if (sandboxCallbackUnreachableReason()) return;
  await db
    .update(projectSessions)
    .set({ status: 'provisioning', error: null, updatedAt: new Date() })
    .where(eq(projectSessions.sessionId, sessionId));
  // Migrated session — restore its original chat as part of provisioning, before
  // the sandbox goes active so the compiled ACP launch plan survives.
  const legacySandboxId = (
    loaded.row as {
      metadata?: { legacy_migration?: { source_sandbox_id?: unknown } };
    }
  ).metadata?.legacy_migration?.source_sandbox_id;
  const runtimeModel = typeof session.metadata?.model === 'string' ? session.metadata.model : null;
  const runtimeAuthKind = typeof session.metadata?.auth_connection === 'string'
    ? session.metadata.auth_connection as import('../lib/composer-capabilities').HarnessAuthKind
    : null;
  const runtimeMetadata = { opened_at: new Date().toISOString() };
  const sessionMetadata = { ...(session.metadata ?? {}), ...runtimeMetadata };

  allocateSessionRuntime({
    sessionId,
    accountId: loaded.row.accountId,
    projectId,
    userId: loaded.userId,
    project: loaded.row,
    providerName,
    baseRef: session.baseRef ?? loaded.row.defaultBranch,
    agentName: session.agentName ?? 'default',
    runtimeMetadata,
    sessionMetadata,
    buildEnvVars: () =>
      buildSessionSandboxEnvVars({
        accountId: loaded.row.accountId,
        projectId,
        sessionId,
        userId: loaded.userId,
        repoUrl: loaded.row.repoUrl,
        baseRef: session.baseRef ?? loaded.row.defaultBranch,
        agentName: session.agentName ?? 'default',
        runtimeModel,
        runtimeAuthKind,
        defaultBranch: loaded.row.defaultBranch,
        manifestPath: loaded.row.manifestPath,
        llmGatewayEnabled: projectLlmGatewayEnabled(loaded.row.metadata),
      }),
    resolveGitAuthToken: async () => (await resolveProjectGitAuth(loaded.row)).auth?.token ?? null,
    beforeActive:
      typeof legacySandboxId === 'string'
        ? (externalId) =>
            rehydrateSessionChat({
              sessionId,
              legacySandboxId,
              newExternalId: externalId,
            })
        : undefined,
  });
}

// ── Unified session-open orchestration ──────────────────────────────────────
// The stage/result wire types live in @kortix/api-contract (the shared wire
// contract); re-exported here for the existing import sites.

export type {
  SessionStartResult,
  SessionStartStage,
} from '@kortix/api-contract';

/**
 * The relative proxy path a client uses for all OpenCode (port 8000) traffic for
 * a session, resolved against the SDK's configured backendUrl. Keyed by
 * `external_id` — the same id the preview proxy's `loadSandbox()` looks up — so
 * the client never has to know the proxy URL scheme. This is the one place the
 * per-session runtime URL is shaped; the SDK consumes it opaquely.
 */
export function sessionRuntimeUrlPath(externalId: string): string {
  return `/p/${externalId}/8000`;
}

const STALE_PENDING_PROVISIONING_MS = 10 * 60 * 1000;
const STALE_STARTED_PROVISIONING_MS = 5 * 60 * 1000;
const STALE_RUNTIME_WAKE_MS = 90 * 1000;

function parseTimestampMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function staleProvisioningReason(
  row: typeof sessionSandboxes.$inferSelect,
  nowMs = Date.now(),
): string | null {
  if (row.status !== 'provisioning' || row.externalId) return null;
  const metadata =
    row.metadata && typeof row.metadata === 'object'
      ? (row.metadata as Record<string, unknown>)
      : {};
  const initStatus = metadata.initStatus;
  const rowUpdatedAtMs = parseTimestampMs(row.updatedAt) ?? nowMs;

  if (initStatus === 'pending') {
    return nowMs - rowUpdatedAtMs > STALE_PENDING_PROVISIONING_MS
      ? 'stale_provisioning_pending'
      : null;
  }

  if (initStatus === 'provisioning' || initStatus === 'retrying') {
    const initUpdatedAtMs = parseTimestampMs(metadata.initUpdatedAt) ?? rowUpdatedAtMs;
    return nowMs - initUpdatedAtMs > STALE_STARTED_PROVISIONING_MS
      ? 'stale_provisioning_lost'
      : null;
  }

  return null;
}

function sandboxMetadata(row: typeof sessionSandboxes.$inferSelect): Record<string, unknown> {
  return row.metadata && typeof row.metadata === 'object'
    ? (row.metadata as Record<string, unknown>)
    : {};
}

function staleRuntimeWakeReason(
  row: typeof sessionSandboxes.$inferSelect,
  providerStatus: SandboxStatus,
  nowMs = Date.now(),
): string | null {
  if (row.status !== 'active' || !row.externalId) return null;
  if (providerStatus === 'running' || providerStatus === 'removed') return null;
  const metadata = sandboxMetadata(row);
  const wakeStartedAtMs = parseTimestampMs(metadata.runtimeWakeStartedAt);
  if (wakeStartedAtMs && nowMs - wakeStartedAtMs > STALE_RUNTIME_WAKE_MS) {
    return providerStatus === 'stopped' ? 'runtime_wake_timeout' : 'runtime_status_unknown_timeout';
  }

  // Existing bad rows predate runtimeWakeStartedAt. If the provider status is
  // unknown long after provider create succeeded, stop returning retriable
  // "starting" forever and surface the preserved identity as unavailable.
  const initSucceededAtMs = parseTimestampMs(metadata.initSucceededAt);
  if (
    !wakeStartedAtMs &&
    providerStatus === 'unknown' &&
    initSucceededAtMs &&
    nowMs - initSucceededAtMs > STALE_RUNTIME_WAKE_MS
  ) {
    return 'runtime_status_unknown_timeout';
  }
  return null;
}

function removedRuntimeStillInGrace(
  row: typeof sessionSandboxes.$inferSelect,
  nowMs = Date.now(),
): boolean {
  const metadata = sandboxMetadata(row);
  const graceStartedAtMs =
    parseTimestampMs(metadata.runtimeWakeStartedAt) ?? parseTimestampMs(metadata.initSucceededAt);
  return graceStartedAtMs != null && nowMs - graceStartedAtMs <= STALE_RUNTIME_WAKE_MS;
}

async function markRuntimeWakeStarted(
  row: typeof sessionSandboxes.$inferSelect,
  providerStatus: SandboxStatus,
): Promise<void> {
  const metadata = sandboxMetadata(row);
  if (typeof metadata.runtimeWakeStartedAt === 'string') return;
  try {
    await db
      .update(sessionSandboxes)
      .set({
        metadata: {
          ...metadata,
          runtimeWakeStartedAt: new Date().toISOString(),
          runtimeWakeProviderStatus: providerStatus,
        },
        updatedAt: new Date(),
      })
      .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
  } catch (err) {
    console.warn(`[start] failed to mark runtime wake for ${row.sandboxId}:`, err);
  }
}

export function isMissingRuntimeError(error: unknown): boolean {
  const err = error as
    | {
        statusCode?: unknown;
        status?: unknown;
        code?: unknown;
        message?: unknown;
      }
    | null
    | undefined;
  const status = err?.statusCode ?? err?.status;
  if (status === 404) return true;
  const code = typeof err?.code === 'string' ? err.code.toLowerCase() : '';
  if (code === 'not_found' || code === 'notfound') return true;
  const message =
    typeof err?.message === 'string'
      ? err.message.toLowerCase()
      : String(error ?? '').toLowerCase();
  return (
    message.includes('no such container') ||
    message.includes('container not found') ||
    message.includes('sandbox container not found') ||
    message.includes('failed to inspect sandbox container') ||
    message.includes('not found')
  );
}

export function serializeSandboxRow(
  row: typeof sessionSandboxes.$inferSelect,
): ProjectSessionSandbox {
  return {
    sandbox_id: row.sandboxId,
    session_id: row.sessionId,
    project_id: row.projectId,
    account_id: row.accountId,
    provider: row.provider,
    external_id: row.externalId,
    base_url: row.baseUrl,
    status: row.status,
    config: serializeSessionSandboxConfig(row.config),
    metadata: row.metadata ?? {},
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

async function preserveEstablishedRuntimeOnOpen(
  loaded: { row: ProjectRow; userId: string },
  visible: {
    row: {
      sandboxProvider: string;
      baseRef: string | null;
      agentName: string | null;
      metadata?: Record<string, unknown> | null;
    };
  },
  projectId: string,
  sessionId: string,
  row: typeof sessionSandboxes.$inferSelect,
  reason: string,
): Promise<SessionStartResult> {
  if (!row.externalId) {
    await retireUnmaterializedRuntime(row, reason);
    await allocateRuntimeOnOpen(loaded, visible.row, projectId, sessionId);
    return {
      stage: 'provisioning',
      agent_name: visible.row.agentName ?? 'default',
      retriable: true,
      sandbox: null,
      reason,
    };
  }
  const preserved = await preserveEstablishedRuntime(row, reason);
  return {
    stage: 'failed',
    agent_name: visible.row.agentName ?? 'default',
    retriable: false,
    sandbox: preserved ? serializeSandboxRow(preserved) : serializeSandboxRow(row),
    runtime_url: sessionRuntimeUrlPath(row.externalId),
    reason: RUNTIME_IDENTITY_UNAVAILABLE,
  };
}

/**
 * THE authoritative session-open path — the single call the dashboard uses to
 * bring a session's runtime up. Idempotent: provisions a missing sandbox,
 * resumes a hibernated/idle one, and reports ACP runtime readiness once the
 * box is reachable. Returns ONE readiness payload the client polls until `ready`.
 */
export async function openSession(args: {
  loaded: { row: ProjectRow; userId: string };
  visible: {
    row: {
      status: string;
      sandboxProvider: string;
      baseRef: string | null;
      agentName: string | null;
      accountId: string;
      metadata?: Record<string, unknown> | null;
    };
  };
  projectId: string;
  sessionId: string;
}): Promise<SessionStartResult> {
  const { loaded, visible, projectId, sessionId } = args;
  const accountId = visible.row.accountId;

  let [row] = await db
    .select()
    .from(sessionSandboxes)
    .where(
      and(
        eq(sessionSandboxes.sessionId, sessionId),
        eq(sessionSandboxes.projectId, projectId),
        eq(sessionSandboxes.accountId, accountId),
      ),
    )
    .limit(1);

  // Resume a hibernated box in place (keeps its disk/workspace). Check provider
  // truth first: a terminal Platinum VM may need backup restoration, and sending
  // a normal start before that restore creates a second provider-side race.
  let stoppedProviderStatus: SandboxStatus | null = null;
  if (
    row &&
    row.status === 'stopped' &&
    row.externalId &&
    (config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(row.provider)
  ) {
    const provider = getProvider(row.provider as SandboxProviderName);
    stoppedProviderStatus = await provider
      .getStatus(row.externalId)
      .catch(() => 'unknown' as const);
    if (stoppedProviderStatus !== 'removed' || !provider.recoverInPlace) {
    await resumeStoppedSandbox({
      sandboxId: row.sandboxId,
      sessionId: row.sessionId,
      accountId: row.accountId,
      provider: row.provider,
      externalId: row.externalId,
      metadata: row.metadata as Record<string, unknown> | null,
    });
    const [resumed] = await db
      .select()
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sandboxId, row.sandboxId))
      .limit(1);
    if (resumed) row = resumed;
  }
  }

  // No usable box → provision on open (or report a terminal state).
  const usable =
    row &&
    (row.status === 'provisioning' ||
      row.status === 'active' ||
      (row.status === 'stopped' && row.externalId && stoppedProviderStatus === 'removed'));
  if (!usable) {
    if (['failed', 'stopped', 'completed'].includes(visible.row.status)) {
      return {
        stage: visible.row.status === 'failed' ? 'failed' : 'stopped',
        agent_name: visible.row.agentName ?? 'default',
        retriable: false,
        sandbox: null,
      };
    }
    if (visible.row.status !== 'provisioning') {
      if (row?.externalId) {
        return preserveEstablishedRuntimeOnOpen(
          loaded,
          visible,
          projectId,
          sessionId,
          row,
          'non_usable_established_runtime',
        );
      }
      if (row) await retireUnmaterializedRuntime(row, 'non_usable_unmaterialized_runtime');
      await allocateRuntimeOnOpen(loaded, visible.row, projectId, sessionId);
    }
    return {
      stage: 'provisioning',
      agent_name: visible.row.agentName ?? 'default',
      retriable: true,
      sandbox: null,
    };
  }

  const staleProvisioning = row ? staleProvisioningReason(row) : null;
  if (row && staleProvisioning) {
    return preserveEstablishedRuntimeOnOpen(
      loaded,
      visible,
      projectId,
      sessionId,
      row,
      staleProvisioning,
    );
  }

  // A same-id restore already owns the provider operation. Concurrent polls
  // must observe that lease without issuing another restore request.
  if (
    row.status === 'provisioning' &&
    row.externalId &&
    sandboxMetadata(row).runtimeIdentityState === 'recovery_claimed'
  ) {
    return {
      stage: 'starting',
      agent_name: visible.row.agentName ?? 'default',
      retriable: true,
      sandbox: serializeSandboxRow(row),
      runtime_url: sessionRuntimeUrlPath(row.externalId),
      reason: 'runtime_recovery_in_progress',
    };
  }

  // Still provisioning, or active but external_id not yet written.
  if (
    (row.status === 'provisioning' && sandboxMetadata(row).runtimeIdentityState !== 'recovering') ||
    !row.externalId
  ) {
    return {
      stage: 'provisioning',
      agent_name: visible.row.agentName ?? 'default',
      retriable: true,
      sandbox: serializeSandboxRow(row),
    };
  }

  // Active + external_id. The provider may have idle-auto-stopped the box while
  // the row still reads 'active' (the row lies until the next health probe), so
  // confirm with a lightweight provider status check and wake it in place if
  // needed. We deliberately do NOT do the heavy daemon round-trip (OpenCode pin
  // resolve) here — that would block this endpoint for ~8s on a still-booting box
  // and it's polled every second. OpenCode readiness is the client health poll's
  // job; the canonical-pin hook resolves the root once the box reports healthy.
  const provider = getProvider(row.provider as SandboxProviderName);
  let providerStatus: SandboxStatus;
  try {
    providerStatus = stoppedProviderStatus ?? (await provider.getStatus(row.externalId));
  } catch {
    providerStatus = 'unknown';
  }

  if (providerStatus === 'removed') {
    if (removedRuntimeStillInGrace(row)) {
      await markRuntimeWakeStarted(row, providerStatus);
      return {
        stage: 'starting',
        agent_name: visible.row.agentName ?? 'default',
        retriable: true,
        sandbox: null,
        runtime_url: sessionRuntimeUrlPath(row.externalId),
        reason: 'runtime_removed_checking',
      };
    }
    const claim = await claimInPlaceRuntimeRecovery(row);
    if (!claim) {
      return {
        stage: 'starting',
        agent_name: visible.row.agentName ?? 'default',
        retriable: true,
        sandbox: serializeSandboxRow(row),
        runtime_url: sessionRuntimeUrlPath(row.externalId),
        reason: 'runtime_recovery_in_progress',
      };
    }
    const recovery = await provider.recoverInPlace?.(row.externalId).catch((err) => {
      console.warn(`[start] in-place recovery failed for ${row.externalId}:`, err);
      return 'unavailable' as const;
    });
    if (recovery === 'running' || recovery === 'recovering') {
      const recoveringRow = await markInPlaceRuntimeRecoveryAccepted(claim, recovery);
      if (!recoveringRow) {
        return {
          stage: 'stopped',
          agent_name: visible.row.agentName ?? 'default',
          retriable: false,
          sandbox: null,
          reason: 'runtime_recovery_cancelled',
        };
      }
      return {
        stage: 'starting',
        agent_name: visible.row.agentName ?? 'default',
        retriable: true,
        sandbox: serializeSandboxRow(recoveringRow),
        runtime_url: sessionRuntimeUrlPath(row.externalId),
        reason:
          recovery === 'running' ? 'runtime_recovered_in_place' : 'runtime_restoring_in_place',
      };
    }
    return preserveEstablishedRuntimeOnOpen(
      loaded,
      visible,
      projectId,
      sessionId,
      claim.row,
      'runtime_removed',
    );
  }

  if (providerStatus !== 'running') {
    if (sandboxMetadata(row).runtimeIdentityState === 'recovering') {
      return {
        stage: 'starting',
        agent_name: visible.row.agentName ?? 'default',
        retriable: true,
        sandbox: serializeSandboxRow(row),
        runtime_url: sessionRuntimeUrlPath(row.externalId),
        reason: 'runtime_restoring_in_place',
      };
    }
    const staleWake = staleRuntimeWakeReason(row, providerStatus);
    if (staleWake) {
      return preserveEstablishedRuntimeOnOpen(
        loaded,
        visible,
        projectId,
        sessionId,
        row,
        staleWake,
      );
    }
    await markRuntimeWakeStarted(row, providerStatus);
    // Idle auto-stop: kick the start in the background; the client keeps polling.
    void provider.start(row.externalId).catch(async (err) => {
      console.warn(`[start] failed to wake sandbox ${row.externalId} (session ${sessionId}):`, err);
      if (isMissingRuntimeError(err)) {
        await preserveEstablishedRuntime(row, 'wake_missing_runtime').catch(() => {});
      }
    });
    return {
      stage: 'starting',
      agent_name: visible.row.agentName ?? 'default',
      retriable: true,
      sandbox: null,
      runtime_url: sessionRuntimeUrlPath(row.externalId),
      reason: providerStatus === 'stopped' ? 'runtime_waking' : 'runtime_status_unknown',
    };
  }

  if (sandboxMetadata(row).runtimeIdentityState === 'recovering') {
    const finalized = await finalizeRecoveredRuntimeIfRunning(row);
    if (!finalized) {
      return {
        stage: 'stopped',
        agent_name: visible.row.agentName ?? 'default',
        retriable: false,
        sandbox: null,
        reason: 'runtime_recovery_cancelled',
      };
    }
    row = finalized;
  }
  const runningExternalId = row.externalId;
  if (!runningExternalId) {
    throw new Error(`Provider-running sandbox ${row.sandboxId} has no external_id`);
  }

  // Box is provider-running. Inspect the daemon-owned runtime mode. Every
  // supported harness, including OpenCode, is ready only through ACP.
  const runtimeHealth = await inspectSandboxRuntime(runningExternalId, loaded.userId);
  if (!runtimeHealth) {
    return {
      stage: 'starting',
      agent_name: visible.row.agentName ?? 'default',
      retriable: true,
      sandbox: serializeSandboxRow(row),
      runtime_protocol: 'acp',
      runtime_id: null,
      runtime_session_id:
        typeof visible.row.metadata?.acp_session_id === 'string'
          ? visible.row.metadata.acp_session_id
          : null,
      runtime_url: sessionRuntimeUrlPath(runningExternalId),
      reason: 'acp_starting',
    };
  }
  if (runtimeHealth?.runtime === 'acp') {
    const ready = runtimeHealth.runtimeReady && !!runtimeHealth.acpServerId;
    return {
      stage: ready ? 'ready' : 'starting',
      agent_name: visible.row.agentName ?? 'default',
      retriable: !ready,
      sandbox: serializeSandboxRow(row),
      runtime_protocol: 'acp',
      runtime_id: runtimeHealth.acpServerId,
      runtime_session_id:
        typeof visible.row.metadata?.acp_session_id === 'string'
          ? visible.row.metadata.acp_session_id
          : null,
      runtime_url: sessionRuntimeUrlPath(runningExternalId),
      reason: ready
        ? 'acp_ready'
        : runtimeHealth.bootError ? 'acp_boot_error' : 'acp_starting',
    };
  }

  // Every supported harness, including OpenCode, must be reached through ACP.
  // A box reporting the removed native runtime is not a compatibility path;
  // it must be rebuilt/restarted with the v3 compiled runtime plan.
  return {
    stage: 'failed',
    agent_name: visible.row.agentName ?? 'default',
    retriable: false,
    sandbox: serializeSandboxRow(row),
    runtime_protocol: null,
    runtime_id: null,
    runtime_session_id: null,
    runtime_url: sessionRuntimeUrlPath(runningExternalId),
    reason: 'non_acp_runtime',
  };
}

export async function refreshCrTips(input: {
  cr: typeof changeRequests.$inferSelect;
  project: {
    projectId: string;
    repoUrl: string;
    defaultBranch: string;
    manifestPath: string;
    gitAuthToken?: string | null;
  };
}) {
  const { cr, project } = input;
  if (cr.status !== 'open') return;
  try {
    const [baseSha, headSha] = await Promise.all([
      resolveBranchTip(project, cr.baseRef),
      resolveBranchTip(project, cr.headRef),
    ]);
    if (cr.headCommitSha === headSha && cr.baseCommitSha === baseSha) return;
    await db
      .update(changeRequests)
      .set({
        headCommitSha: headSha,
        baseCommitSha: baseSha,
        updatedAt: new Date(),
      })
      .where(eq(changeRequests.crId, cr.crId));
  } catch (error) {
    // Repo unreachable or branch missing — leave the CR alone so the UI can
    // still render the metadata it has.
    console.warn('[change-requests] tip refresh failed', {
      crId: cr.crId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// GET /v1/projects/:projectId/change-requests?status=open|merged|closed|all
