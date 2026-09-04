import type {
  ProjectSessionSandbox,
  SessionStartFailure,
  SessionStartResult,
} from '@kortix/api-contract';
import { changeRequests, projectSessions, sessionSandboxes } from '@kortix/db';
import { type SQL, and, eq, sql } from 'drizzle-orm';
import {
  markComputeSessionAlive,
  reopenComputeForSandbox,
} from '../../billing/services/compute-metering';
import { type SandboxProviderName, config } from '../../config';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { auth, json } from '../../openapi';
import { type SandboxStatus, getProvider } from '../../platform/providers';
import { classifySandboxProvisioningFailure } from '../../platform/services/sandbox-provisioning-error';
import { db } from '../../shared/db';
import { resolveBranchTip } from '../git';
import { legacyRehydrateSpec, rehydrateSessionChat } from '../legacy-migration-rehydrate';
import { withProjectGitAuth } from '../lib/git';
import { scheduleSandboxRuntimeRefresh } from '../lib/sandbox-runtime-refresh';
import { type ProjectRow, serializeSessionSandboxConfig } from '../lib/serializers';
import { allocateSessionRuntime } from '../lib/session-runtime-allocator';
import {
  projectImageAllowedForSession,
  sandboxSlugFromSessionMetadata,
  workspaceModeFromSessionMetadata,
} from '../lib/session-sandbox-metadata';
import { buildSessionSandboxEnvVars, sandboxCallbackUnreachableReason } from '../lib/sessions';
import { ensureOpencodeSessionPin } from '../opencode-mapping';
import {
  RUNTIME_IDENTITY_UNAVAILABLE,
  claimInPlaceRuntimeRecovery,
  finalizeRecoveredRuntimeIfRunning,
  markInPlaceRuntimeRecoveryAccepted,
  parkEstablishedRuntime,
  preserveEstablishedRuntime,
  retireUnmaterializedRuntime,
  runtimeLossVerdict,
} from '../runtime-identity';
import { inspectSandboxRuntime } from '../runtime-inspection';
import {
  type StartCallLog,
  createStartCallLog,
  withStartEnvelope,
} from '../session-lifecycle/start-envelope';
import { runStoppedObservationFollowUp } from '../session-lifecycle/stopped-observation-followup';
import type { StopReason } from '../stop-reason';
import { recoverTurnsAfterRuntimeRestart } from '../session-lifecycle/runtime-restart-recovery';
import {
  RUNTIME_READINESS_CLOCK_KEYS,
  STALE_OPENCODE_BOOT_HARD_MS,
  hasRuntimeReadinessClock,
  opencodeReadyWaitPatch,
  staleOpencodeReadyReason,
} from '../session-lifecycle/readiness-clocks';
import {
  RUNTIME_START_FAILURE_KEYS,
  RUNTIME_START_MAX_FAILURES,
  RUNTIME_WAKE_GRACE_MS,
  RUNTIME_WAKE_HARD_MS,
  RUNTIME_WAKE_LATE_START_GUARD_MS,
  RUNTIME_WAKE_LEASE_MS,
  executeClaimedRuntimeWake,
  runtimeStartFailureCount,
  runtimeStartFailurePatch,
  runtimeStartRetryAtMs,
  runtimeWakeInProgress,
  runtimeWakeProgressPatch,
  stampedRuntimeFailureState,
} from '../session-lifecycle/runtime-wake-fence';

/**
 * `metadata - 'a' - 'b' - …`, generated from a key list.
 *
 * Hand-written `-` chains are how the readiness clocks drifted apart: the wake
 * claim stripped four of the ten, `clearRuntimeReadinessClocks` stripped eight
 * by hardcoded index, and `opencodeBootWaitFirstSeenAt` was therefore cleared
 * by nothing except a human Restart. That immortal clock parked session
 * 29861dfa's second attempt 14 ms before its daemon claimed its first turn
 * (2026-08-26). One generator, one list, no drift.
 */
function stripMetadataKeys(keys: readonly string[]): SQL {
  return keys.reduce<SQL>((acc, key) => {
    // A LITERAL, not a bind parameter. `jsonb - $1` leaves the parameter type
    // unknown and Postgres cannot choose between `jsonb - text` and
    // `jsonb - integer`. Every key here is a compile-time constant from a
    // frozen list, and this guard keeps it that way.
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`refusing to strip a non-identifier metadata key: ${key}`);
    }
    return sql`${acc} - ${sql.raw(`'${key}'`)}`;
  }, sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb)`);
}

/**
 * Keys a WAKE CLAIM drops. The readiness clocks are appended, so a re-attempt
 * boots against a clean budget.
 *
 * Deliberately ABSENT: `runtimeStartFailureCount` and `runtimeStartFailedAt`.
 * They drive the escalating cooldown between automatic rungs and must survive
 * one — unlike an explicit human Restart, which resets the whole episode
 * (`prepareInPlaceRestartMetadata`).
 */
export const RUNTIME_WAKE_CLAIM_CLEARED_KEYS = [
  'runtimeIdentityState',
  'runtimeUnavailableReason',
  'runtimeUnavailableAt',
  'preservedExternalId',
  'needsReprovision',
  'runtimeWakeError',
  'runtimeWakeFailedAt',
  'runtimeWakeRetryAfterAt',
  'runtimeStartRetryAfterAt',
  'runtimeWakeCleanupUntilAt',
  'runtimeWakeLateStartStoppedAt',
  'runtimeWakeProgressAt',
  ...RUNTIME_READINESS_CLOCK_KEYS,
] as const;

/**
 * Resume a hibernated (status='stopped') session sandbox IN PLACE instead of
 * destroying it and cold-reprovisioning a fresh one. A stopped row whose
 * `externalId` is still set is a powered-down VM whose disk — the repo clone,
 * installed deps, opencode — is intact, so resuming it skips the dominant boot
 * costs (snapshot pull + clone + deps).
 *
 * Claims wake ownership while both durable rows remain stopped. Provider start
 * is asynchronous. Only provider-running confirmation may finalize the rows and
 * open compute billing. A hard failure records a terminal cooldown payload, so
 * browser `/start` polling cannot create a provider retry storm.
 */
export async function resumeStoppedSandbox(
  row: {
    sandboxId: string;
    sessionId: string;
    accountId: string;
    provider: string;
    externalId: string | null;
    metadata?: Record<string, unknown> | null;
  },
  /**
   * A provider status the caller already read, forwarded to the wake so it does
   * not pay a second provider round trip for the same answer. See
   * `executeClaimedRuntimeWake`'s `knownStatus`.
   */
  knownProviderStatus?: string | null,
): Promise<boolean> {
  if (!row.externalId) return false;
  if (!(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(row.provider)) return false;
  const now = new Date();
  // A stamped runtime-start failure blocks a re-attempt for its COOLDOWN, and
  // for nothing longer. Refusing outright — which is what this gate used to do
  // for both `runtime_boot_failed` and `runtime_wake_failed` — is what made
  // `POST /restart` the only way back for sessions e06ad0c4 and 9c8749ac.
  const stampedFailure = stampedRuntimeFailureState(row.metadata, now);
  if (stampedFailure === 'cooling_down' || stampedFailure === 'terminal') return false;

  const externalId = row.externalId;
  const runtimeWakeId = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + RUNTIME_WAKE_LEASE_MS);
  const wakePatch = {
    runtimeWakeStartedAt: now.toISOString(),
    runtimeWakeId,
    runtimeWakeLeaseExpiresAt: leaseExpiresAt.toISOString(),
    runtimeWakeProviderStatus: 'starting',
  };
  // Metadata CAS is the lock. The row deliberately stays stopped. A retry can
  // replace only an expired lease and cannot bypass a failed-wake cooldown.
  const [won] = await db
    .update(sessionSandboxes)
    .set({
      updatedAt: now,
      metadata: sql`(${stripMetadataKeys(RUNTIME_WAKE_CLAIM_CLEARED_KEYS)}) || ${JSON.stringify(wakePatch)}::jsonb`,
    })
    .where(
      and(
        eq(sessionSandboxes.sandboxId, row.sandboxId),
        eq(sessionSandboxes.externalId, externalId),
        eq(sessionSandboxes.status, 'stopped'),
        sql`(
          ${sessionSandboxes.metadata}->>'runtimeWakeId' IS NULL
          OR ${sessionSandboxes.metadata}->>'runtimeWakeLeaseExpiresAt' IS NULL
          OR ${sessionSandboxes.metadata}->>'runtimeWakeLeaseExpiresAt' !~ '^\\d{4}-\\d{2}-\\d{2}T'
          OR coalesce(${sessionSandboxes.metadata}->>'runtimeWakeLeaseExpiresAt', '') <= ${now.toISOString()}
        )`,
        sql`(
          ${sessionSandboxes.metadata}->>'runtimeWakeRetryAfterAt' IS NULL
          OR ${sessionSandboxes.metadata}->>'runtimeWakeRetryAfterAt' !~ '^\\d{4}-\\d{2}-\\d{2}T'
          OR coalesce(${sessionSandboxes.metadata}->>'runtimeWakeRetryAfterAt', '') <= ${now.toISOString()}
        )`,
        sql`(
          ${sessionSandboxes.metadata}->>'runtimeWakeCleanupId' IS NULL
          OR ${sessionSandboxes.metadata}->>'runtimeWakeCleanupLeaseExpiresAt' IS NULL
          OR ${sessionSandboxes.metadata}->>'runtimeWakeCleanupLeaseExpiresAt' !~ '^\\d{4}-\\d{2}-\\d{2}T'
          OR coalesce(${sessionSandboxes.metadata}->>'runtimeWakeCleanupLeaseExpiresAt', '') <= ${now.toISOString()}
        )`,
      ),
    )
    .returning({ sandboxId: sessionSandboxes.sandboxId });
  if (!won) return false;

  const provider = getProvider(row.provider as SandboxProviderName);
  void executeClaimedRuntimeWake({
    knownStatus: knownProviderStatus ?? null,
    getStatus: () => provider.getStatus(externalId),
    waitOptions: {
      // The wake's own budget is now "time without a provider-state change",
      // capped absolutely at RUNTIME_WAKE_HARD_MS. Each change also refreshes
      // the DURABLE lease below, so the fence every other component reads stays
      // in step with the wake actually running.
      hardCapMs: RUNTIME_WAKE_HARD_MS,
      onProgress: async (status) => {
        const [current] = await db
          .select({ metadata: sessionSandboxes.metadata })
          .from(sessionSandboxes)
          .where(eq(sessionSandboxes.sandboxId, row.sandboxId))
          .limit(1);
        const patch = runtimeWakeProgressPatch(
          (current?.metadata ?? {}) as Record<string, unknown>,
          status,
        );
        if (!patch) return;
        await db
          .update(sessionSandboxes)
          .set({
            metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
          })
          .where(
            and(
              eq(sessionSandboxes.sandboxId, row.sandboxId),
              // Fenced: only the wake that owns this row may extend its lease.
              sql`${sessionSandboxes.metadata}->>'runtimeWakeId' = ${runtimeWakeId}`,
            ),
          );
      },
    },
    start: () => provider.start(externalId),
    stop: () => provider.stop(externalId),
    isMissingError: isMissingRuntimeError,
    finalize: async () => {
      const confirmedAt = new Date();
      const finalized = await db.transaction(async (tx) => {
        const [activated] = await tx
          .update(sessionSandboxes)
          .set({
            status: 'active',
            updatedAt: confirmedAt,
            metadata: sql`(
              coalesce(${sessionSandboxes.metadata}, '{}'::jsonb)
                - 'runtimeWakeStartedAt'
                - 'runtimeWakeId'
                - 'runtimeWakeLeaseExpiresAt'
                - 'runtimeWakeProviderStatus'
                - 'runtimeWakeError'
                - 'runtimeWakeFailedAt'
                - 'runtimeWakeRetryAfterAt'
                - 'runtimeWakeCleanupUntilAt'
                - 'runtimeWakeCleanupId'
                - 'runtimeWakeCleanupLeaseExpiresAt'
                - 'runtimeWakeLateStartCheckedAt'
                - 'runtimeWakeLateStartProviderStatus'
                - 'runtimeWakeLateStartStoppedAt'
                - 'runtimeWakeProgressAt'
                - ${RUNTIME_START_FAILURE_KEYS[0]}
                - ${RUNTIME_START_FAILURE_KEYS[1]}
                - ${RUNTIME_START_FAILURE_KEYS[2]}
              ) || ${JSON.stringify({ providerRunningConfirmedAt: confirmedAt.toISOString() })}::jsonb`,
          })
          .where(
            and(
              eq(sessionSandboxes.sandboxId, row.sandboxId),
              eq(sessionSandboxes.externalId, externalId),
              eq(sessionSandboxes.status, 'stopped'),
              sql`${sessionSandboxes.metadata}->>'runtimeWakeId' = ${runtimeWakeId}`,
            ),
          )
          .returning({ sandboxId: sessionSandboxes.sandboxId });
        if (!activated) return false;
        await tx
          .update(projectSessions)
          .set({ status: 'running', error: null, updatedAt: confirmedAt })
          .where(eq(projectSessions.sessionId, row.sessionId));
        return true;
      });
      if (!finalized) return false;
      // The provider had this box STOPPED: whatever turn was still open on it
      // is over. Normally applyStoppedState settled those rows already and
      // this finds nothing; it is the guard for a row that reached `stopped`
      // without that path (see runtime-restart-recovery.ts).
      await recoverTurnsAfterRuntimeRestart({
        sandboxId: row.sandboxId,
        sessionId: row.sessionId,
        externalId,
        hold: false,
      }).catch((err) =>
        console.warn(`[projects] turn recovery after wake failed for ${row.sandboxId}:`, err),
      );
      await reopenComputeForSandbox(
        row.sandboxId,
        row.accountId,
        row.sessionId,
        null,
        row.provider as SandboxProviderName,
      ).catch((err) => console.warn(`[projects] compute reopen failed for ${row.sandboxId}:`, err));
      await markComputeSessionAlive(row.sandboxId, confirmedAt).catch((err) =>
        console.warn(`[projects] compute liveness stamp failed for ${row.sandboxId}:`, err),
      );
      // A resume wakes the SAME powered-down VM, so the daemon's boot-time
      // reconcile never re-runs and the box keeps the `kortix` binary its image
      // was built with. Poke the daemon to re-converge on this deploy's runtime
      // assets. Detached and after the rows are already active: it must not
      // extend the wake the user is waiting on. It retries on its own, because
      // provider-running precedes the guest daemon binding its port.
      scheduleSandboxRuntimeRefresh(row.sessionId, 'resume');
      return true;
    },
    fail: async (reason) => {
      const failedAt = new Date();
      // Read the row back for the CONSECUTIVE-failure count: the cooldown this
      // stamp owes escalates with it, and the count is what eventually earns a
      // terminal card instead of another attempt.
      const [current] = await db
        .select({ metadata: sessionSandboxes.metadata })
        .from(sessionSandboxes)
        .where(eq(sessionSandboxes.sandboxId, row.sandboxId))
        .limit(1);
      const failurePatch = {
        runtimeWakeError: reason,
        runtimeWakeFailedAt: failedAt.toISOString(),
        stopReason: 'runtime_wake_failed',
        stoppedAt: failedAt.toISOString(),
        ...runtimeStartFailurePatch(
          (current?.metadata ?? {}) as Record<string, unknown>,
          failedAt,
        ),
        runtimeWakeCleanupUntilAt: new Date(
          failedAt.getTime() + RUNTIME_WAKE_LATE_START_GUARD_MS,
        ).toISOString(),
      };
      const [failed] = await db
        .update(sessionSandboxes)
        .set({
          updatedAt: failedAt,
          metadata: sql`(
            coalesce(${sessionSandboxes.metadata}, '{}'::jsonb)
              - 'runtimeWakeId'
              - 'runtimeWakeLeaseExpiresAt'
              - 'runtimeWakeProviderStatus'
            ) || ${JSON.stringify(failurePatch)}::jsonb`,
        })
        .where(
          and(
            eq(sessionSandboxes.sandboxId, row.sandboxId),
            eq(sessionSandboxes.externalId, externalId),
            eq(sessionSandboxes.status, 'stopped'),
            sql`${sessionSandboxes.metadata}->>'runtimeWakeId' = ${runtimeWakeId}`,
          ),
        )
        .returning({ sandboxId: sessionSandboxes.sandboxId });
      return Boolean(failed);
    },
    claimState: async () => {
      const [current] = await db
        .select({
          status: sessionSandboxes.status,
          metadata: sessionSandboxes.metadata,
        })
        .from(sessionSandboxes)
        .where(eq(sessionSandboxes.sandboxId, row.sandboxId))
        .limit(1);
      const metadata = (current?.metadata ?? {}) as Record<string, unknown>;
      if (
        current?.status === 'stopped' &&
        typeof metadata.runtimeWakeId === 'string' &&
        metadata.runtimeWakeId !== runtimeWakeId &&
        runtimeWakeInProgress(metadata)
      ) {
        return 'delegated';
      }
      return current?.status === 'stopped' && metadata.runtimeWakeId === runtimeWakeId
        ? 'owned'
        : 'cancelled';
    },
  }).catch((err) =>
    console.error(
      `[projects] claimed wake crashed for ${externalId} (session ${row.sessionId}):`,
      err,
    ),
  );
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
  const opencodeModel =
    typeof session.metadata?.opencode_model === 'string' ? session.metadata.opencode_model : null;
  const runtimeMetadata = { opened_at: new Date().toISOString() };
  const sessionMetadata = { ...(session.metadata ?? {}), ...runtimeMetadata };
  const rehydrate = legacyRehydrateSpec(session.metadata, loaded.row.metadata);

  allocateSessionRuntime({
    sessionId,
    accountId: loaded.row.accountId,
    projectId,
    userId: loaded.userId,
    project: loaded.row,
    providerName,
    baseRef: session.baseRef ?? loaded.row.defaultBranch,
    agentName: session.agentName ?? 'default',
    allowProjectImage: projectImageAllowedForSession(
      session.agentName,
      workspaceModeFromSessionMetadata(session.metadata),
    ),
    sandboxSlug: sandboxSlugFromSessionMetadata(session.metadata),
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
        opencodeModel,
        defaultBranch: loaded.row.defaultBranch,
        manifestPath: loaded.row.manifestPath,
        llmGatewayEnabled: projectLlmGatewayEnabled(loaded.row.metadata),
        workspaceMode: workspaceModeFromSessionMetadata(session.metadata),
        restoreSessionBranch: true,
      }),
    resolveGitProject: async () => withProjectGitAuth(loaded.row),
    beforeActive: rehydrate
      ? (externalId) =>
          rehydrateSessionChat({
            sessionId,
            externalId,
            provider: providerName,
            spec: rehydrate,
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
/**
 * The CONTROL transport address for a session's runtime: the OpenCode/daemon
 * REST channel, always the path proxy.
 *
 * This is deliberately NOT a preview origin and must never be used to build
 * one. It is called per turn by programmatic clients holding a bearer token;
 * resolving it through an origin would make every such request re-establish a
 * host-scoped session (a non-indexed sandbox-label lookup) and would put turn
 * delivery behind wildcard DNS, the certificate pack and the edge Worker.
 * Browser-facing URLs come from `previewOriginFor` / `previewUrlTemplate`
 * instead — see sandbox-proxy/preview-hosts.ts.
 */
export function sessionRuntimeUrlPath(externalId: string): string {
  return `/p/${externalId}/8000`;
}

const STALE_PENDING_PROVISIONING_MS = 10 * 60 * 1000;
const STALE_STARTED_PROVISIONING_MS = 5 * 60 * 1000;
const STALE_RUNTIME_WAKE_MS = RUNTIME_WAKE_GRACE_MS;
// A provider-running box normally binds the daemon within seconds. A daemon
// that remains unreachable for 30 seconds needs an explicit restart, not five
// minutes of repeated 8-second /start long-polls. Once the daemon answers, give
// OpenCode itself a wider window to finish booting.
const STALE_RUNTIME_UNREACHABLE_MS = 30_000;
const STALE_OPENCODE_NOT_READY_MS = 90_000;

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

async function markOpencodeReadyWaitStarted(
  row: typeof sessionSandboxes.$inferSelect,
  reason: 'not_ready' | 'unreachable',
  bootPhase: string | undefined,
): Promise<void> {
  const metadata = sandboxMetadata(row);
  // The reason clock restarts on every daemon-reported phase change, so the
  // budget below is "no progress for N seconds", not "not ready N seconds
  // after the first poll" (see opencodeReadyWaitPatch).
  const patch = opencodeReadyWaitPatch(metadata, reason, bootPhase);
  if (!patch) return;
  try {
    await db
      .update(sessionSandboxes)
      .set({ metadata: patch, updatedAt: new Date() })
      .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
  } catch (err) {
    console.warn(`[start] failed to mark OpenCode wait for ${row.sandboxId}:`, err);
  }
}

async function clearRuntimeReadinessClocks(
  row: typeof sessionSandboxes.$inferSelect,
): Promise<void> {
  const metadata = sandboxMetadata(row);
  if (!hasRuntimeReadinessClock(metadata)) return;
  try {
    await db
      .update(sessionSandboxes)
      .set({
        // EVERY key. This used to strip the first eight by index, leaving
        // `opencodeBootPhase` and `opencodeBootWaitFirstSeenAt` on a row whose
        // daemon had just reported READY — so the next boot wait on that row
        // inherited a spent hard cap.
        metadata: stripMetadataKeys(RUNTIME_READINESS_CLOCK_KEYS),
        updatedAt: new Date(),
      })
      .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
  } catch (err) {
    console.warn(`[start] failed to clear readiness clocks for ${row.sandboxId}:`, err);
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

/**
 * The answer `/start` owes a STOPPED row before any provider call: a wake in
 * flight, a cooldown after a failed start, or a terminal verdict. `null` means
 * "nothing to replay" — the caller goes on to actually try.
 *
 * Exported for `stopped-wake-result.test.ts`, which pins the 2026-08-26
 * dead-end regression directly on this projection.
 */
export function stoppedWakeResult(
  row: typeof sessionSandboxes.$inferSelect | undefined,
  agentName: string | null,
  opencodeSessionId: string | null,
  now: Date = new Date(),
): SessionStartResult | null {
  if (row?.status !== 'stopped' || !row.externalId) return null;
  const metadata = sandboxMetadata(row);
  // An identity already preserved as unavailable outranks every wake clock on
  // this row. Both payloads below describe a wake that may still succeed, and
  // the cooldown one even advertises `retryable: true` — for a runtime the
  // provider has disowned that is a dead-end button, not a retry. Fall through
  // to the authoritative removed/recovery path, which either restores the box
  // in place or re-reports `runtime_identity_unavailable`.
  if (metadata.runtimeIdentityState !== 'unavailable' && runtimeWakeInProgress(metadata, now)) {
    return {
      stage: 'starting',
      agent_name: agentName ?? 'default',
      retriable: true,
      sandbox: serializeSandboxRow(row),
      opencode_session_id: opencodeSessionId,
      runtime_url: sessionRuntimeUrlPath(row.externalId),
      reason: 'runtime_waking',
    };
  }
  if (metadata.runtimeIdentityState === 'unavailable') return null;

  // A STAMPED runtime-start failure — `runtime_wake_failed` from a wake that
  // ran out of budget, `runtime_boot_failed` from a park. It used to short
  // -circuit every later `/start` to a terminal payload forever, so the session
  // could only be recovered by a human pressing Restart (Essentia 2026-08-26:
  // e06ad0c4 answered `failed` in 47ms for a startable box; 9c8749ac replayed a
  // 03:37Z stamp for 10+ hours). Now it is a cooldown with three outcomes.
  const failureState = stampedRuntimeFailureState(metadata, now);
  // `retry`: say nothing here. The caller falls through to the resume path and
  // RE-ATTEMPTS the wake, which is the whole fix.
  if (failureState === null || failureState === 'retry') return null;

  const failureCount = runtimeStartFailureCount(metadata);
  const retryAtMs = runtimeStartRetryAtMs(metadata);
  const parkReason =
    typeof metadata.runtimeParkReason === 'string' ? metadata.runtimeParkReason : null;
  const stampReason =
    metadata.stopReason === 'runtime_wake_failed'
      ? 'runtime_wake_failed'
      : (parkReason ?? 'runtime_boot_failed');
  const evidence = {
    check: typeof metadata.runtimeWakeError === 'string' ? metadata.runtimeWakeError : stampReason,
    observed_at:
      typeof metadata.runtimeStartFailedAt === 'string'
        ? metadata.runtimeStartFailedAt
        : typeof metadata.runtimeWakeFailedAt === 'string'
          ? metadata.runtimeWakeFailedAt
          : typeof metadata.stoppedAt === 'string'
            ? metadata.stoppedAt
            : null,
    error: typeof metadata.lastInitError === 'string' ? metadata.lastInitError : null,
    attempts: failureCount,
    next_retry_at: retryAtMs !== null ? new Date(retryAtMs).toISOString() : null,
  };

  if (failureState === 'cooling_down') {
    // NOT a terminal answer and no longer dressed as one: the server itself
    // re-attempts once the cooldown lapses, so the honest stage is `starting`
    // and the honest `retriable` is true. Polling now makes progress.
    return {
      stage: 'starting',
      agent_name: agentName ?? 'default',
      retriable: true,
      sandbox: serializeSandboxRow(row),
      opencode_session_id: opencodeSessionId,
      runtime_url: sessionRuntimeUrlPath(row.externalId),
      reason: 'runtime_wake_cooldown',
      failure: {
        category: 'sandbox-provider',
        message:
          failureCount > 1
            ? `The runtime did not start (attempt ${failureCount}). Retrying automatically.`
            : 'The runtime did not start. Retrying automatically.',
        retryable: true,
        evidence,
      },
    };
  }

  // `terminal`: the attempt budget is spent, or the provider disowned the box.
  // Restart still clears it, and the verdict itself expires
  // (RUNTIME_START_FAILURE_TTL_MS) so a session opened later starts clean.
  return {
    stage: 'failed',
    agent_name: agentName ?? 'default',
    retriable: false,
    sandbox: serializeSandboxRow(row),
    opencode_session_id: opencodeSessionId,
    runtime_url: sessionRuntimeUrlPath(row.externalId),
    reason: stampReason,
    failure: {
      category: 'sandbox-provider',
      message: `The session runtime did not become reachable after ${Math.min(failureCount, RUNTIME_START_MAX_FAILURES)} attempts. Restart the session to try again.`,
      retryable: true,
      evidence,
    },
  };
}

export function sessionStartFailureFromSandbox(
  row: typeof sessionSandboxes.$inferSelect,
): SessionStartFailure | null {
  if (row.status !== 'error') return null;
  const metadata = sandboxMetadata(row);
  const rawCategory = metadata.failureCategory;
  const storedCategory =
    rawCategory === 'provider-capacity' ||
    rawCategory === 'git-auth' ||
    rawCategory === 'unsupported-secret-delivery' ||
    rawCategory === 'invalid-secret-boundary-policy' ||
    rawCategory === 'sandbox-provider'
      ? rawCategory
      : 'sandbox-provider';
  const rawProviderError =
    typeof metadata.lastProvisioningError === 'string'
      ? metadata.lastProvisioningError
      : typeof metadata.provisioningError === 'string'
        ? metadata.provisioningError
        : null;
  const inferredFailure = rawProviderError
    ? classifySandboxProvisioningFailure(rawProviderError)
    : null;
  const inferredSpecificFailure =
    storedCategory === 'sandbox-provider' && inferredFailure?.category !== 'sandbox-provider'
      ? inferredFailure
      : null;
  const category = inferredSpecificFailure?.category ?? storedCategory;
  const message =
    inferredSpecificFailure?.userMessage ??
    (typeof metadata.errorMessage === 'string' && metadata.errorMessage.length > 0
      ? metadata.errorMessage
      : 'The sandbox provider could not start this session. Try again.');
  // Both secret-delivery categories are configuration states, not transient faults: the identical
  // input produces the identical failure every time, so offering a retry only wastes the user's time.
  return {
    category,
    message,
    retryable:
      category !== 'unsupported-secret-delivery' && category !== 'invalid-secret-boundary-policy',
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
  /** WHICH park this is, for the classification query. Explicit per call site:
   *  this helper serves four unrelated populations (a stalled provision, a
   *  failed wake, a failed boot, a real provider removal) and cannot tell them
   *  apart from the inside. */
  stopReason: StopReason,
  /** A provider status the CALLER just observed, so the loss gate below does
   *  not re-probe. Pass only a fresh answer; omit to let the gate ask. */
  knownProviderStatus?: SandboxStatus,
): Promise<SessionStartResult> {
  if (!row.externalId) {
    await retireUnmaterializedRuntime(row, reason);
    await allocateRuntimeOnOpen(loaded, visible.row, projectId, sessionId);
    return {
      stage: 'provisioning',
      agent_name: visible.row.agentName ?? 'default',
      retriable: true,
      sandbox: null,
      opencode_session_id: null,
      reason,
    };
  }
  // Incident 2026-08-14: only a definitive provider `removed` may become the
  // terminal "computer was lost" state. Two healthy boxes were preserved as
  // lost because a dead local tunnel kept them from booting and nothing asked
  // the provider first. Anything short of `removed` — including `unknown`,
  // which is a probe failure, not evidence — parks the row retriable instead.
  // try/catch, not .catch(): getProvider() itself throws SYNCHRONOUSLY for a
  // disabled provider (missing API key), and that must read as "cannot ask" —
  // park — never as a 500 out of /start.
  let providerStatus: SandboxStatus = knownProviderStatus ?? 'unknown';
  if (!knownProviderStatus) {
    try {
      providerStatus = await getProvider(row.provider as SandboxProviderName).getStatus(
        row.externalId,
      );
    } catch {
      providerStatus = 'unknown';
    }
  }
  if (runtimeLossVerdict(providerStatus) === 'park') {
    const parked = await parkEstablishedRuntime(row, reason, stopReason);
    return {
      stage: 'failed',
      agent_name: visible.row.agentName ?? 'default',
      retriable: true,
      sandbox: serializeSandboxRow(parked ?? row),
      opencode_session_id: null,
      runtime_url: sessionRuntimeUrlPath(row.externalId),
      reason,
    };
  }
  const preserved = await preserveEstablishedRuntime(row, reason, stopReason);
  return {
    stage: 'failed',
    agent_name: visible.row.agentName ?? 'default',
    retriable: false,
    sandbox: preserved ? serializeSandboxRow(preserved) : serializeSandboxRow(row),
    opencode_session_id: null,
    runtime_url: sessionRuntimeUrlPath(row.externalId),
    reason: RUNTIME_IDENTITY_UNAVAILABLE,
  };
}

/**
 * THE authoritative session-open path — the single call the dashboard uses to
 * bring a session's runtime up. Idempotent: provisions a missing sandbox,
 * resumes a hibernated/idle one, and resolves the canonical OpenCode pin once the
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
      opencodeSessionId: string | null;
      accountId: string;
      metadata?: Record<string, unknown> | null;
    };
  };
  projectId: string;
  sessionId: string;
}): Promise<SessionStartResult> {
  // ONE log per call. Every branch below records what it DID and what it
  // OBSERVED; the envelope is assembled once, here, from that record — so a
  // payload that claims a negative without a live check is not expressible.
  const log = createStartCallLog();
  const result = await runOpenSession(args, log);
  return withStartEnvelope(
    result,
    log,
    (result.sandbox?.metadata ?? {}) as Record<string, unknown>,
  );
}

async function runOpenSession(args: {
  loaded: { row: ProjectRow; userId: string };
  visible: {
    row: {
      status: string;
      sandboxProvider: string;
      baseRef: string | null;
      agentName: string | null;
      opencodeSessionId: string | null;
      accountId: string;
      metadata?: Record<string, unknown> | null;
    };
  };
  projectId: string;
  sessionId: string;
}, log: StartCallLog): Promise<SessionStartResult> {
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

  // Gate browser polling before any provider call. A live wake coalesces behind
  // its durable claim. A failed wake returns one terminal cooldown payload.
  // Reversing this order issues another provider start on every `/start` poll.
  const existingWake = stoppedWakeResult(
    row,
    visible.row.agentName,
    visible.row.opencodeSessionId,
    log.observedAt,
  );
  if (existingWake) {
    log.did(existingWake.reason === 'runtime_wake_cooldown' ? 'cooling_down' : 'awaited_wake');
    return existingWake;
  }

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
    log.sawProvider(stoppedProviderStatus);
    if (stoppedProviderStatus !== 'removed' || !provider.recoverInPlace) {
      const resumed = await resumeStoppedSandbox(
        {
          sandboxId: row.sandboxId,
          sessionId: row.sessionId,
          accountId: row.accountId,
          provider: row.provider,
          externalId: row.externalId,
          metadata: row.metadata as Record<string, unknown> | null,
        },
        // Already read one line above — do not buy it twice. Withheld for
        // 'removed': that status makes the wake fail INSTEAD of starting, and
        // the fence is detached (`void`), so without its own `getStatus` await
        // to defer it the failure write races — and beats — the row re-read
        // three lines below. The caller would then serve the terminal cooldown
        // payload for a box whose wake had only just been claimed, instead of
        // `runtime_waking`. A removed box is a rare terminal path where one
        // extra provider round trip buys nothing worth that.
        stoppedProviderStatus === 'removed' ? null : stoppedProviderStatus,
      );
      if (resumed) log.did('resumed');
      const [afterResume] = await db
        .select()
        .from(sessionSandboxes)
        .where(eq(sessionSandboxes.sandboxId, row.sandboxId))
        .limit(1);
      if (afterResume) row = afterResume;
    }
  }

  const resumedWake = stoppedWakeResult(
    row,
    visible.row.agentName,
    visible.row.opencodeSessionId,
    log.observedAt,
  );
  if (resumedWake) {
    if (resumedWake.reason === 'runtime_wake_cooldown') log.did('cooling_down');
    return resumedWake;
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
        sandbox: row?.status === 'error' ? serializeSandboxRow(row) : null,
        opencode_session_id: null,
        failure: row ? sessionStartFailureFromSandbox(row) : null,
      };
    }
    if (visible.row.status !== 'provisioning') {
      if (row?.externalId) {
        log.did('reconciled');
      log.did('reconciled');
    return preserveEstablishedRuntimeOnOpen(
          loaded,
          visible,
          projectId,
          sessionId,
          row,
          'non_usable_established_runtime',
          'unusable_runtime_state',
        );
      }
      if (row) await retireUnmaterializedRuntime(row, 'non_usable_unmaterialized_runtime');
      await allocateRuntimeOnOpen(loaded, visible.row, projectId, sessionId);
      log.did('provisioned');
    }
    return {
      stage: 'provisioning',
      agent_name: visible.row.agentName ?? 'default',
      retriable: true,
      sandbox: null,
      opencode_session_id: null,
    };
  }

  const staleProvisioning = row ? staleProvisioningReason(row) : null;
  if (row && staleProvisioning) {
    log.did('reconciled');
    return preserveEstablishedRuntimeOnOpen(
      loaded,
      visible,
      projectId,
      sessionId,
      row,
      staleProvisioning,
      'provisioning_stalled',
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
      opencode_session_id: visible.row.opencodeSessionId,
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
      opencode_session_id: null,
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
  log.sawProvider(providerStatus);
  let observedRuntimeHealth: Awaited<ReturnType<typeof inspectSandboxRuntime>> = null;
  if (providerStatus === 'unknown') {
    observedRuntimeHealth = await inspectSandboxRuntime(row.externalId, loaded.userId);
    if (observedRuntimeHealth) {
      providerStatus = 'running';
      log.sawProvider(providerStatus);
      log.sawRuntime('ready');
    } else {
      log.sawRuntime('unreachable');
    }
  }

  if (providerStatus === 'removed') {
    if (removedRuntimeStillInGrace(row)) {
      await markRuntimeWakeStarted(row, providerStatus);
      return {
        stage: 'starting',
        agent_name: visible.row.agentName ?? 'default',
        retriable: true,
        sandbox: null,
        opencode_session_id: null,
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
        opencode_session_id: visible.row.opencodeSessionId,
        runtime_url: sessionRuntimeUrlPath(row.externalId),
        reason: 'runtime_recovery_in_progress',
      };
    }
    const recovery = await provider.recoverInPlace?.(row.externalId).catch((err) => {
      console.warn(`[start] in-place recovery failed for ${row.externalId}:`, err);
      return 'unavailable' as const;
    });
    if (recovery === 'running' || recovery === 'recovering') {
      log.did('restored');
      const recoveringRow = await markInPlaceRuntimeRecoveryAccepted(claim, recovery);
      if (!recoveringRow) {
        return {
          stage: 'stopped',
          agent_name: visible.row.agentName ?? 'default',
          retriable: false,
          sandbox: null,
          opencode_session_id: null,
          reason: 'runtime_recovery_cancelled',
        };
      }
      return {
        stage: 'starting',
        agent_name: visible.row.agentName ?? 'default',
        retriable: true,
        sandbox: serializeSandboxRow(recoveringRow),
        opencode_session_id: visible.row.opencodeSessionId,
        runtime_url: sessionRuntimeUrlPath(row.externalId),
        reason:
          recovery === 'running' ? 'runtime_recovered_in_place' : 'runtime_restoring_in_place',
      };
    }
    log.did('reconciled');
    return preserveEstablishedRuntimeOnOpen(
      loaded,
      visible,
      projectId,
      sessionId,
      claim.row,
      'runtime_removed',
      // The provider itself answered `removed` and in-place recovery came back
      // unavailable — a real Path D2 removal, not a wake that ran out of time.
      'provider_removed',
      'removed',
    );
  }

  if (providerStatus !== 'running') {
    if (sandboxMetadata(row).runtimeIdentityState === 'recovering') {
      return {
        stage: 'starting',
        agent_name: visible.row.agentName ?? 'default',
        retriable: true,
        sandbox: serializeSandboxRow(row),
        opencode_session_id: visible.row.opencodeSessionId,
        runtime_url: sessionRuntimeUrlPath(row.externalId),
        reason: 'runtime_restoring_in_place',
      };
    }
    const staleWake = staleRuntimeWakeReason(row, providerStatus);
    if (staleWake) {
      log.did('reconciled');
      log.did('reconciled');
    return preserveEstablishedRuntimeOnOpen(
        loaded,
        visible,
        projectId,
        sessionId,
        row,
        staleWake,
        'runtime_wake_failed',
        providerStatus,
      );
    }
    // The provider read said `stopped`, but this row still holds turn authority
    // and the stop was not confirmed by a second read. See below.
    let stopUnconfirmed = false;
    if (providerStatus === 'stopped') {
      // Provider truth says this active row is parked. Close the old compute
      // window and both durable states first. Then enter the same stopped-row
      // wake fence used by every other access path. No raw provider start exists
      // outside that fence.
      //
      // ONE read is not that truth while the row holds turn authority. This
      // endpoint is an UNSOLICITED OBSERVATION — it has stopped nothing itself —
      // and it is polled every second, while Daytona folds `stopping` and
      // `pending_stop` into `stopped` (platform/providers/daytona-state.ts). On
      // 2026-08-17T20:40:03Z one such read parked session 0fc6897a mid-turn,
      // settled its ledger `runtime_gone` and returned the client to the wake
      // flow with the turn's work lost. So it takes the same confirmation gate
      // as the reaper's poll: a second `stopped` read, one window later.
      const activeExternalId = row.externalId;
      const stateSync = await import('../reaping/sandbox-state-sync');
      const parked = await stateSync.reconcileSandboxStoppedByExternalId(
        activeExternalId,
        new Date(),
        { confirmMidTurnStop: true },
      );
      if (parked) log.did('reconciled');
      const [stoppedRow] = await db
        .select()
        .from(sessionSandboxes)
        .where(eq(sessionSandboxes.sandboxId, row.sandboxId))
        .limit(1);
      if (stoppedRow?.status === 'stopped') {
        if (
          await resumeStoppedSandbox({
            sandboxId: stoppedRow.sandboxId,
            sessionId: stoppedRow.sessionId,
            accountId: stoppedRow.accountId,
            provider: stoppedRow.provider,
            externalId: stoppedRow.externalId,
            metadata: stoppedRow.metadata as Record<string, unknown> | null,
          })
        ) {
          log.did('resumed');
        }
      } else if (stoppedRow?.status === 'active') {
        // Nothing was parked and nothing is waking: the box keeps running with
        // its turn intact. Say exactly that instead of claiming a wake — the
        // next poll either reads `running` again, which drops the marker, or
        // earns the confirmation and takes the branch above.
        stopUnconfirmed = true;
        // OWN the confirmation instead of hoping someone reads again. Without
        // this the row keeps claiming `running` for as long as nothing polls —
        // 5+ minutes on Essentia 2026-08-26, with the queued prompt delivered
        // against a box the provider had already stopped. Detached: the answer
        // this call returns must not wait a confirmation window for it.
        void runStoppedObservationFollowUp({
          externalId: activeExternalId,
          sandboxId: row.sandboxId,
          getStatus: () => provider.getStatus(activeExternalId).catch(() => 'unknown'),
          reconcile: (at) =>
            stateSync.reconcileSandboxStoppedByExternalId(activeExternalId, at, {
              confirmMidTurnStop: true,
            }),
        }).catch((err) =>
          console.warn(
            `[start] stopped-observation follow-up failed for ${activeExternalId}:`,
            err instanceof Error ? err.message : err,
          ),
        );
      }
    } else {
      // Unknown is not permission to issue repeated provider starts. Record one
      // readiness clock and let the bounded stale path terminate it.
      await markRuntimeWakeStarted(row, providerStatus);
    }
    return {
      stage: 'starting',
      agent_name: visible.row.agentName ?? 'default',
      retriable: true,
      sandbox: null,
      opencode_session_id: null,
      runtime_url: sessionRuntimeUrlPath(row.externalId),
      reason:
        providerStatus !== 'stopped'
          ? 'runtime_status_unknown'
          : stopUnconfirmed
            ? 'runtime_stop_unconfirmed'
            : 'runtime_waking',
    };
  }

  // The provider says RUNNING, so the pending-stop confirmation this endpoint
  // may have armed above is answered: drop it.
  //
  // A confirmation is about ONE provider transition. This route is polled about
  // once a second and it can arm the marker; an endpoint that arms and never
  // disarms turns two transient `pending_stop` misreads MINUTES apart — with
  // hundreds of healthy `running` reads in between — into a confirmed park of a
  // live box. Only a row that carries a marker pays for the write, and the
  // reaper's own running read does the same thing for rows nobody is polling.
  if (sandboxMetadata(row).pendingStopObservedAtMs !== undefined) {
    await import('../reaping/sandbox-state-sync').then((m) =>
      m.clearPendingStopObservation(row.sandboxId),
    );
  }

  if (sandboxMetadata(row).runtimeIdentityState === 'recovering') {
    const finalized = await finalizeRecoveredRuntimeIfRunning(row);
    if (!finalized) {
      return {
        stage: 'stopped',
        agent_name: visible.row.agentName ?? 'default',
        retriable: false,
        sandbox: null,
        opencode_session_id: null,
        reason: 'runtime_recovery_cancelled',
      };
    }
    row = finalized;
  }
  const runningExternalId = row.externalId;
  if (!runningExternalId) {
    throw new Error(`Provider-running sandbox ${row.sandboxId} has no external_id`);
  }

  // Box is provider-running. Resolve OpenCode readiness + the canonical pin
  // server-side — safe now that the box is confirmed up, so the daemon answers
  // FAST (a 503 'not_ready' while OpenCode is still booting, not an 8s timeout
  // against a dead box). This keeps ALL the lifecycle logic server-side: the
  // client just polls until stage='ready' and gets the pin handed to it.
  const ensured = await ensureOpencodeSessionPin({
    projectId,
    sessionId,
    accountId,
    externalId: runningExternalId,
    userId: loaded.userId,
    currentPin: visible.row.opencodeSessionId ?? null,
  });
  const booting = ensured.reason === 'not_ready' || ensured.reason === 'unreachable';
  log.sawRuntime(
    ensured.reason === 'unreachable' ? 'unreachable' : booting ? 'booting' : 'ready',
    ensured.bootPhase ?? null,
  );
  if (booting) {
    // A daemon that reports a NEW boot phase since the last poll has made
    // progress: its reason clock is restarted below before the next poll
    // judges it, so only a box that stalls in one phase for the budget — or
    // one that never becomes ready within the hard cap — is parked.
    const metadataForBudget =
      ensured.reason === 'not_ready' || ensured.reason === 'unreachable'
        ? (opencodeReadyWaitPatch(sandboxMetadata(row), ensured.reason, ensured.bootPhase) ??
          sandboxMetadata(row))
        : sandboxMetadata(row);
    const staleBoot = staleOpencodeReadyReason(
      metadataForBudget,
      ensured.reason,
      Date.now(),
      ensured.reason === 'unreachable'
        ? STALE_RUNTIME_UNREACHABLE_MS
        : STALE_OPENCODE_NOT_READY_MS,
      STALE_OPENCODE_BOOT_HARD_MS,
    );
    if (staleBoot) {
      log.did('reconciled');
      log.did('reconciled');
    return preserveEstablishedRuntimeOnOpen(
        loaded,
        visible,
        projectId,
        sessionId,
        row,
        staleBoot,
        'runtime_boot_failed',
      );
    }
    await markOpencodeReadyWaitStarted(
      row,
      ensured.reason === 'unreachable' ? 'unreachable' : 'not_ready',
      ensured.bootPhase,
    );
  } else {
    await clearRuntimeReadinessClocks(row);
  }
  return {
    stage: booting ? 'starting' : 'ready',
    agent_name: visible.row.agentName ?? 'default',
    retriable: booting,
    sandbox: serializeSandboxRow(row),
    opencode_session_id: ensured.pin,
    runtime_url: sessionRuntimeUrlPath(runningExternalId),
    reason: ensured.reason,
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
