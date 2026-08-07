/**
 * THE BILLING INVARIANT ENFORCER, and the two monitors that watch both fail
 * directions of it. Decisions live in compute-close-policy.ts; this module is
 * the pass that applies them plus the DB-only counters `/health` alerts on.
 */

import { and, eq, sql } from 'drizzle-orm';
import { appRuntimes, sandboxComputeSessions, sessionSandboxes } from '@kortix/db';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { getProvider, type ProviderName, type SandboxStatus } from '../../platform/providers';
import {
  REAP_BATCH_SIZE,
  REAP_CONCURRENCY,
  computeMaxWindowMs,
  computeUnresolvedCeilingMs,
} from '../../projects/reaper-constants';
import { pauseComputeSession } from './compute-metering';
import {
  computeLivenessGraceMs,
  isBeyondLivenessCeiling,
  lastAliveAtOf,
  parseTimestamp,
} from './compute-liveness';
import {
  type ComputeCloseReason,
  computeCloseWindowEnd,
  decideComputeClose,
  hasFailedRuntimeStart,
} from './compute-close-policy';

export interface OrphanComputeResult {
  checked: number;
  closed: number;
  errors: number;
  byReason: Record<ComputeCloseReason, number>;
}

const EMPTY_REASON_COUNTS = (): Record<ComputeCloseReason, number> => ({
  'sandbox-row-missing': 0,
  'sandbox-not-active': 0,
  'runtime-start-failed': 0,
  'beyond-liveness-ceiling': 0,
  'provider-not-running': 0,
  'unresolvable-past-ceiling': 0,
  'window-past-max': 0,
});

function appRuntimeBillingStatus(status: string | null): string | null {
  if (status === 'running') return 'active';
  if (status === 'provisioning' || status === 'starting') return 'provisioning';
  return status;
}

/**
 * Every compute window belongs to exactly one runtime model. Session windows
 * join through `session_sandboxes`; App windows join through `app_runtime_id`.
 * Keeping both joins in one bounded query preserves oldest-first sweep order.
 */
export function selectOpenComputeInvariantCandidates(limit = REAP_BATCH_SIZE) {
  return db
    .select({
      computeId: sandboxComputeSessions.id,
      sandboxId: sandboxComputeSessions.sandboxId,
      workloadType: sandboxComputeSessions.workloadType,
      startedAt: sandboxComputeSessions.startedAt,
      computeMetadata: sandboxComputeSessions.metadata,
      sbStatus: sessionSandboxes.status,
      sbUpdatedAt: sessionSandboxes.updatedAt,
      sbMetadata: sessionSandboxes.metadata,
      sessionProvider: sessionSandboxes.provider,
      sessionExternalId: sessionSandboxes.externalId,
      appStatus: appRuntimes.status,
      appUpdatedAt: appRuntimes.updatedAt,
      appMetadata: appRuntimes.metadata,
      appProvider: appRuntimes.provider,
      appExternalId: appRuntimes.externalId,
    })
    .from(sandboxComputeSessions)
    .leftJoin(sessionSandboxes, eq(sessionSandboxes.sandboxId, sandboxComputeSessions.sandboxId))
    .leftJoin(appRuntimes, eq(appRuntimes.runtimeId, sandboxComputeSessions.appRuntimeId))
    .where(eq(sandboxComputeSessions.state, 'active'))
    .orderBy(sql`${sandboxComputeSessions.startedAt} asc`)
    .limit(limit);
}

/**
 * The single authority that guarantees "no compute row stays open unless its
 * sandbox is provably alive".
 *
 * Every stop path in this codebase closes the meter best-effort
 * (`pauseComputeSession(...).catch(warn)`) and then flips the sandbox row
 * regardless, so any one of them failing — or passing the wrong id — strands a
 * billing row that then accrues wall-clock forever. This pass re-derives the
 * truth every cycle from scratch instead of trusting that N callers all did
 * their job, which is the only structure that has ever held.
 *
 * It runs the DB-only rules first, so the dominant leak costs zero provider
 * round-trips, and it settles each closed window to the last moment we can
 * affirmatively evidence the box was alive rather than to `now` (see
 * `computeCloseWindowEnd`). Oldest-open first, so a saturated batch drains the
 * worst leaks first and can never starve them. Deterministic; idempotent.
 */
export async function reconcileOrphanComputeSessions(now = new Date()): Promise<OrphanComputeResult> {
  const unresolvedCeilingMs = computeUnresolvedCeilingMs();
  const maxWindowMs = computeMaxWindowMs();

  const rows = await selectOpenComputeInvariantCandidates();

  const result: OrphanComputeResult = {
    checked: rows.length,
    closed: 0,
    errors: 0,
    byReason: EMPTY_REASON_COUNTS(),
  };
  let cursor = 0;
  const worker = async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      try {
        const isApp = row.workloadType === 'app';
        const runtimeStatus = isApp
          ? appRuntimeBillingStatus(row.appStatus)
          : row.sbStatus;
        const runtimeUpdatedAt = isApp ? row.appUpdatedAt : row.sbUpdatedAt;
        const runtimeMetadata = (isApp ? row.appMetadata : row.sbMetadata) as
          | Record<string, unknown>
          | null;
        const provider = isApp ? row.appProvider : row.sessionProvider;
        const externalId = isApp ? row.appExternalId : row.sessionExternalId;
        const startedAt = parseTimestamp(row.startedAt) ?? now;
        const openForMs = Math.max(0, now.getTime() - startedAt.getTime());
        const computeMetadata = (row.computeMetadata ?? {}) as Record<string, unknown>;
        const unresolvedSince = parseTimestamp(computeMetadata.unresolvedSince);
        const lastAliveAt = lastAliveAtOf({ metadata: computeMetadata, startedAt: row.startedAt });
        const livenessGraceMs = computeLivenessGraceMs();

        const base = {
          sandboxStatus: runtimeStatus ?? null,
          hasProviderTarget: !!externalId && !!provider,
          runtimeStartFailed: hasFailedRuntimeStart(runtimeMetadata),
          beyondLivenessCeiling: isBeyondLivenessCeiling({ now, lastAliveAt, graceMs: livenessGraceMs }),
          openForMs,
          unresolvedCeilingMs,
          maxWindowMs,
        };

        // Probe the DB-only rules first: `providerStatus: 'running'` and
        // `unresolvedForMs: null` make every provider-informed rule inert, so a
        // non-null reason here is one we reached without any provider call.
        let decision = decideComputeClose({
          ...base,
          providerStatus: 'running',
          unresolvedForMs: null,
        });

        let providerStatus: SandboxStatus | null = null;
        if (!decision.reason && decision.needsProviderStatus) {
          providerStatus = await getProvider(provider as ProviderName)
            .getStatus(externalId as string)
            .catch(() => null);
          // 'unknown' is the STEADY state for a box deleted out from under us
          // (44 of 66 open prod rows answered unknown), so track how long it has
          // been continuously unresolvable rather than treating it as transient.
          if (providerStatus === 'running') {
            if (unresolvedSince) {
              await updateComputeSessionMetadata(row.computeId, { ...computeMetadata, unresolvedSince: null });
            }
          } else if (providerStatus !== 'stopped' && providerStatus !== 'removed' && !unresolvedSince) {
            await updateComputeSessionMetadata(row.computeId, {
              ...computeMetadata,
              unresolvedSince: now.toISOString(),
            });
          }
          decision = decideComputeClose({
            ...base,
            providerStatus,
            unresolvedForMs: unresolvedSince ? now.getTime() - unresolvedSince.getTime() : null,
          });
        }

        if (!decision.reason) continue;

        const windowEnd = computeCloseWindowEnd({
          reason: decision.reason,
          now,
          startedAt,
          sandboxUpdatedAt: parseTimestamp(runtimeUpdatedAt),
          unresolvedSince,
          runtimeWakeFailedAt: parseTimestamp(runtimeMetadata?.runtimeWakeFailedAt),
          lastAliveAt,
          livenessGraceMs,
          maxWindowMs,
        });
        await pauseComputeSession(row.sandboxId, windowEnd);
        result.closed += 1;
        result.byReason[decision.reason] += 1;
        logger.warn('[reaper] closed a compute window whose box was not provably alive', {
          sandbox_id: row.sandboxId,
          reason: decision.reason,
          open_for_hours: Number((openForMs / 3_600_000).toFixed(2)),
          billed_through: windowEnd.toISOString(),
          workload_type: row.workloadType,
          sandbox_status: runtimeStatus ?? null,
          provider_status: providerStatus,
        });
      } catch (err) {
        result.errors += 1;
        console.warn(`[reaper] orphan-compute reconcile failed for ${row.sandboxId}:`, err instanceof Error ? err.message : err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(REAP_CONCURRENCY, rows.length) }, worker));
  return result;
}

async function updateComputeSessionMetadata(
  computeId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await db
    .update(sandboxComputeSessions)
    .set({ metadata })
    .where(eq(sandboxComputeSessions.id, computeId))
    .catch((err) =>
      console.warn('[reaper] compute metadata update failed:', err instanceof Error ? err.message : err),
    );
}

/**
 * Invariant monitor (surfaced on /health + alerting): how many `active` compute
 * sessions have a sandbox that is NOT `active`. In steady state this is 0; a
 * non-zero, growing value means billing is leaking and must page. Cheap, DB-only.
 */
export async function countBillingInvariantViolations(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sandboxComputeSessions)
    .leftJoin(sessionSandboxes, eq(sessionSandboxes.sandboxId, sandboxComputeSessions.sandboxId))
    .leftJoin(appRuntimes, eq(appRuntimes.runtimeId, sandboxComputeSessions.appRuntimeId))
    .where(and(
      eq(sandboxComputeSessions.state, 'active'),
      sql`(
        (${sandboxComputeSessions.workloadType} = 'app' AND (
          ${appRuntimes.runtimeId} IS NULL OR
          ${appRuntimes.status} NOT IN ('provisioning', 'starting', 'running')
        )) OR
        (${sandboxComputeSessions.workloadType} <> 'app' AND (
          ${sessionSandboxes.status} IS NULL OR ${sessionSandboxes.status} <> 'active'
        ))
      )`,
    ));
  return Number(row?.n ?? 0);
}

/**
 * THE OTHER FAIL DIRECTION. Billing is now gated on control-plane liveness
 * evidence (compute-liveness.ts), and that trade has a cost: under wall-clock
 * accrual an outage OVER-bills loudly (customers complain); under
 * evidence-gated accrual the same outage UNDER-bills silently, which is
 * strictly worse to operate because nothing tells you.
 *
 * So this counts the mirror invariant: sandboxes we still believe are `active`
 * whose open window has NOT been observed alive inside the grace, i.e. windows
 * that have quietly stopped earning. In steady state the reaper re-stamps every
 * visited row well inside the grace, so this is ~0. A rising value means the
 * reaper is starved or dead and revenue is draining away in silence — page on
 * it exactly like BILLING INVARIANT VIOLATED. Two monitors, one per direction.
 */
export async function countStaleLivenessWindows(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - computeLivenessGraceMs()).toISOString();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sandboxComputeSessions)
    .leftJoin(sessionSandboxes, eq(sessionSandboxes.sandboxId, sandboxComputeSessions.sandboxId))
    .leftJoin(appRuntimes, eq(appRuntimes.runtimeId, sandboxComputeSessions.appRuntimeId))
    .where(and(
      eq(sandboxComputeSessions.state, 'active'),
      sql`(
        (${sandboxComputeSessions.workloadType} = 'app' AND ${appRuntimes.status} = 'running') OR
        (${sandboxComputeSessions.workloadType} <> 'app' AND ${sessionSandboxes.status} = 'active')
      )`,
      sql`coalesce(${sandboxComputeSessions.metadata}->>'lastAliveAt', ${sandboxComputeSessions.startedAt}::text) < ${cutoff}`,
    ));
  return Number(row?.n ?? 0);
}
