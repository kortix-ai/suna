/**
 * The hibernated-box wake fence: claiming, executing, finalizing and failing
 * an in-place resume of a stopped sandbox. Split out of the former
 * routes/shared.ts (KRTX-274); every block below moved verbatim.
 */
import { sessionSandboxes } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { markComputeSessionAlive, reopenComputeForSandbox } from '../../billing/services/compute-metering';
import { type SandboxProviderName, config } from '../../lib/config';
import { type SandboxStatus, getProvider } from '../../platform/providers';
import { isProviderNotFound } from '../../platform/providers/status';
import { invalidateSandbox } from '../../sandbox-proxy/backend';
import { db } from '../../shared/db';
import { scheduleSandboxRuntimeRefresh } from '../lib/sandbox-runtime-refresh';
import { scheduleSessionConfigConvergence } from '../lib/session-config-convergence';
import { stripMetadataKeys } from '../session-lifecycle/sandbox-metadata-sql';
import { RUNTIME_READINESS_CLOCK_KEYS } from '../session-lifecycle/readiness-clocks';
import { recoverTurnsAfterRuntimeRestart } from '../session-lifecycle/runtime-restart-recovery';
import { transitionRuntime } from '../session-lifecycle/status-transitions';
import type { StartCallLog } from '../session-lifecycle/start-envelope';
import {
  RUNTIME_START_FAILURE_KEYS,
  RUNTIME_WAKE_HARD_MS,
  RUNTIME_WAKE_LATE_START_GUARD_MS,
  RUNTIME_WAKE_LEASE_MS,
  executeClaimedRuntimeWake,
  runtimeStartFailurePatch,
  runtimeWakeInProgress,
  runtimeWakeProgressPatch,
  runtimeWakeRestoreProgressPatch,
  stampedRuntimeFailureState,
} from '../session-lifecycle/runtime-wake-fence';
import type { OpenSessionRow } from './session-open-context';

/**
 * Keys a WAKE CLAIM drops. The readiness clocks are appended, so a re-attempt
 * boots against a clean budget.
 *
 * Deliberately ABSENT: `runtimeStartFailureCount` and `runtimeStartFailedAt`.
 * They drive the escalating cooldown between automatic rungs and must survive
 * one — unlike an explicit human Restart, which resets the whole episode
 * (`IN_PLACE_RESTART_CLEARED_KEYS`, stripped by `claimInPlaceRestart`).
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

/** Keys the wake's finalize drops once the provider confirms the box runs. */
const RUNTIME_WAKE_FINALIZE_CLEARED_KEYS = [
  'runtimeWakeStartedAt',
  'runtimeWakeId',
  'runtimeWakeLeaseExpiresAt',
  'runtimeWakeProviderStatus',
  'runtimeWakeError',
  'runtimeWakeFailedAt',
  'runtimeWakeRetryAfterAt',
  'runtimeWakeCleanupUntilAt',
  'runtimeWakeCleanupId',
  'runtimeWakeCleanupLeaseExpiresAt',
  'runtimeWakeLateStartCheckedAt',
  'runtimeWakeLateStartProviderStatus',
  'runtimeWakeLateStartStoppedAt',
  'runtimeWakeProgressAt',
  ...RUNTIME_START_FAILURE_KEYS,
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
  // `POST /restart` the only way back for two prod sessions on 2026-08-26.
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
    start: () =>
      provider.start(externalId, {
        // A restore from cold storage runs inside start() and can outlast the
        // lease; keep it, fenced to this wake.
        onProgress: async () => {
          await db
            .update(sessionSandboxes)
            .set({
              metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${JSON.stringify(runtimeWakeRestoreProgressPatch())}::jsonb`,
            })
            .where(
              and(
                eq(sessionSandboxes.sandboxId, row.sandboxId),
                sql`${sessionSandboxes.metadata}->>'runtimeWakeId' = ${runtimeWakeId}`,
              ),
            );
        },
      }),
    stop: () => provider.stop(externalId),
    isMissingError: isMissingRuntimeError,
    finalize: async () => {
      const confirmedAt = new Date();
      // Both rows move together, or neither does: the sandbox CAS on this
      // wake's own id, the session guarded against a delete.
      const finalized = await transitionRuntime({
        sessionId: row.sessionId,
        sandboxId: row.sandboxId,
        session: 'resume',
        sandbox: 'wake',
        at: confirmedAt,
        error: null,
        metadata: {
          strip: RUNTIME_WAKE_FINALIZE_CLEARED_KEYS,
          merge: { providerRunningConfirmedAt: confirmedAt.toISOString() },
        },
        guard: and(
          eq(sessionSandboxes.externalId, externalId),
          sql`${sessionSandboxes.metadata}->>'runtimeWakeId' = ${runtimeWakeId}`,
        ),
      });
      if (!finalized) return false;
      invalidateSandbox(externalId);
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
      // The project's half of the same problem. The woken VM still holds the
      // config dir, skills and compiled agent config of its provision day;
      // nothing on a resume re-reads the base branch. Detached, idle-gated, and
      // a no-op — no opencode restart — on a box that is already current.
      scheduleSessionConfigConvergence(row.sessionId, 'resume');
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

export function isMissingRuntimeError(error: unknown): boolean {
  if (isProviderNotFound(error)) return true;
  // legacy: Daytona answers a start on a box whose container is gone with a
  // non-404 that names the gone container only in Docker's text. Scoped to
  // Daytona's own error classes so another provider's text never matches.
  // Delete when Daytona types this answer (status 404 or an errorCode).
  const name = error instanceof Error ? error.name : '';
  return (
    name.startsWith('Daytona') &&
    /no such container|container not found|failed to inspect sandbox container/i.test((error as Error).message)
  );
}

/**
 * The hibernated-resume phase of `runOpenSession`: read provider truth for a
 * stopped row and hand it to the wake fence above. The body is the original
 * `runOpenSession` branch, verbatim (KRTX-274 split); the possibly re-read row
 * and the observed provider status are returned to the orchestrator.
 */
export async function resumeHibernatedOnOpen(
  log: StartCallLog,
  row: OpenSessionRow,
): Promise<{ row: OpenSessionRow; stoppedProviderStatus: SandboxStatus | null }> {
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
  return { row, stoppedProviderStatus };
}
