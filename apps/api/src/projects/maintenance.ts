import { and, eq, inArray, lt, ne } from 'drizzle-orm';
import { projectSessions, projects } from '@kortix/db';
import { db } from '../shared/db';
import { deleteRemoteSessionBranch, type GitBackedProject } from './git';
import { tickRunningComputeCharges } from '../billing/services/compute-metering';
import { reconcileStaleBuilds } from '../snapshots/builder';
import { reconcileSnapshotQuota } from '../snapshots/quota-gc';
import {
  reapAndReconcileSandboxes,
  reconcileOrphanComputeSessions,
  reconcileStuckActiveSessions,
  reapOrphanProviderBoxes,
  countBillingInvariantViolations,
} from './sandbox-reaper';

const DEFAULT_BRANCH_RETENTION_DAYS = 90;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;
const GC_BATCH_SIZE = 50;

const TERMINAL_SESSION_STATUSES = ['stopped', 'completed', 'failed'] as const;

type MaintenanceTimer = ReturnType<typeof setInterval>;

const globalForProjectMaintenance = globalThis as typeof globalThis & {
  __kortixProjectMaintenanceTimer?: MaintenanceTimer | null;
};

let maintenanceTimer: MaintenanceTimer | null = null;
let maintenanceRunning = false;
// Wall-clock time the current run acquired the lock, or null when idle. Used
// solely by the stall watchdog below — never trust a boolean lock alone (see
// note on STALL_THRESHOLD_MS).
let maintenanceStartedAt: number | null = null;
// Incremented every time a run acquires the lock (including a watchdog
// force-reset). A run's `finally` only clears the lock if its OWN generation
// is still current — otherwise an abandoned, force-reset run that eventually
// settles in the background would clobber the lock/timestamp a newer,
// legitimately-running cycle owns, letting a THIRD cycle start concurrently
// with the second. Cheap and sufficient: we only need "am I still the run
// anyone should trust," not true cancellation of the abandoned work.
let maintenanceGeneration = 0;

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function branchRetentionDays(): number {
  return positiveInt(process.env.KORTIX_BRANCH_RETENTION_DAYS, DEFAULT_BRANCH_RETENTION_DAYS);
}

function maintenanceIntervalMs(): number {
  return positiveInt(process.env.KORTIX_PROJECT_MAINTENANCE_INTERVAL_MS, DEFAULT_MAINTENANCE_INTERVAL_MS);
}

// STALL WATCHDOG — the second, independent line of defense against this exact
// class of bug recurring. `maintenanceRunning` is a simple in-memory boolean
// lock guarded by a `finally`; if ANY awaited call inside a cycle hangs
// forever (an SDK with no per-call timeout, a future un-bounded query, etc.)
// the `finally` never runs and the lock is stuck `true` permanently — every
// later tick then silently no-ops via `if (maintenanceRunning) return`, with
// zero error logs, until the process restarts. That is exactly what happened
// 2026-07-02 (unbounded Daytona SDK calls in sandbox-reaper.ts, now bounded —
// see platform/providers/daytona.ts). Per-call timeouts fix the KNOWN cause;
// this watchdog protects against an UNKNOWN future one: if the lock has been
// held for longer than any real cycle plausibly takes, a tick force-breaks it
// (loudly) instead of leaving the loop dead for good.
function stallThresholdMs(): number {
  return positiveInt(process.env.KORTIX_PROJECT_MAINTENANCE_STALL_MS, maintenanceIntervalMs() * 3);
}

/** Pure decision, exported for direct unit testing. */
export function shouldForceResetStaleLock(heldForMs: number, thresholdMs: number): boolean {
  return heldForMs >= thresholdMs;
}

export function hasOpenPullRequestMarker(metadata: Record<string, unknown> | null | undefined): boolean {
  if (!metadata) return false;
  if (metadata.open_pr === true || metadata.has_open_pr === true) return true;
  for (const key of ['pull_request', 'github_pull_request', 'pr']) {
    const value = metadata[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const state = (value as Record<string, unknown>).state;
      if (typeof state === 'string' && state.toLowerCase() === 'open') return true;
    }
  }
  return false;
}

export function postgresTimestampParam(date: Date): string {
  return date.toISOString();
}

// Idle sandbox hibernation + state/billing reconciliation now lives in the
// provider-agnostic reaper (./sandbox-reaper.ts), which makes the PROVIDER's
// real state the source of truth and keys idleness off MEANINGFUL activity
// (real turns) rather than the partial `last_used_at` proxy signal. See that
// module for the why.

export async function sweepExpiredSessionBranches(now = new Date()): Promise<{
  candidates: number;
  deleted: number;
  skipped: number;
  errors: number;
}> {
  const cutoff = new Date(now.getTime() - branchRetentionDays() * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      sessionId: projectSessions.sessionId,
      branchName: projectSessions.branchName,
      baseRef: projectSessions.baseRef,
      metadata: projectSessions.metadata,
      projectId: projects.projectId,
      repoUrl: projects.repoUrl,
      defaultBranch: projects.defaultBranch,
      manifestPath: projects.manifestPath,
    })
    .from(projectSessions)
    .innerJoin(projects, eq(projectSessions.projectId, projects.projectId))
    .where(and(
      inArray(projectSessions.status, [...TERMINAL_SESSION_STATUSES]),
      lt(projectSessions.updatedAt, cutoff),
      ne(projectSessions.branchName, projects.defaultBranch),
    ))
    .limit(GC_BATCH_SIZE);

  let deleted = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    const metadata = row.metadata ?? {};
    if (hasOpenPullRequestMarker(metadata)) {
      skipped += 1;
      continue;
    }

    if ((metadata.branch_gc as Record<string, unknown> | undefined)?.deleted_at) {
      skipped += 1;
      continue;
    }

    try {
      const project: GitBackedProject = {
        projectId: row.projectId,
        repoUrl: row.repoUrl,
        defaultBranch: row.defaultBranch,
        manifestPath: row.manifestPath,
      };
      const remoteDeleted = await deleteRemoteSessionBranch(project, row.branchName);
      await db
        .update(projectSessions)
        .set({
          metadata: {
            ...metadata,
            branch_gc: {
              deleted_at: now.toISOString(),
              branch_name: row.branchName,
              remote_deleted: remoteDeleted,
            },
          },
          updatedAt: new Date(),
        })
        .where(eq(projectSessions.sessionId, row.sessionId));
      deleted += remoteDeleted ? 1 : 0;
      if (!remoteDeleted) skipped += 1;
    } catch (err) {
      errors += 1;
      console.error(`[project-maintenance] Failed to GC branch ${row.branchName}:`, err);
    }
  }

  return { candidates: rows.length, deleted, skipped, errors };
}

/** Test-only visibility into the lock — never used by runtime code. */
export function __isMaintenanceRunningForTest(): boolean {
  return maintenanceRunning;
}

export async function runProjectMaintenance(): Promise<void> {
  if (maintenanceRunning) {
    const heldForMs = maintenanceStartedAt ? Date.now() - maintenanceStartedAt : 0;
    if (!shouldForceResetStaleLock(heldForMs, stallThresholdMs())) return;
    // Stale lock — the prior cycle almost certainly hung on an unbounded call
    // rather than genuinely still running. Break it loudly and proceed. The
    // abandoned run keeps executing in the background (nothing cancels it —
    // its individual provider calls are now timeout-bounded so it WILL
    // eventually finish or error), but its `finally` is generation-gated
    // below so it can no longer clobber this (or a later) run's lock.
    console.error(
      `[project-maintenance] STALLED — lock held for ${heldForMs}ms (threshold ${stallThresholdMs()}ms), forcing reset. ` +
      'This means a prior cycle hung on an unbounded call — file a bug, this should not happen with all provider calls timeout-bounded.',
    );
  }
  const myGeneration = ++maintenanceGeneration;
  maintenanceRunning = true;
  maintenanceStartedAt = Date.now();
  try {
    const [idle, orphanCompute, stuckSessions, orphanBoxes, branches, computeTick, staleBuilds, snapshotGc] = await Promise.all([
      // Provider-authoritative idle reaper + state/billing reconcile (the fix for
      // boxes that never auto-stopped and kept billing). Backstops the webhooks.
      reapAndReconcileSandboxes().catch((err) => {
        console.warn('[project-maintenance] reaper failed:', err instanceof Error ? err.message : err);
        return { candidates: 0, stopped: 0, reconciled: 0, billingClosed: 0, skipped: 0, errors: 0 };
      }),
      // Billing safety net: close metering for any active compute row whose box
      // is not actually running (catches orphans / missed webhooks).
      reconcileOrphanComputeSessions().catch((err) => {
        console.warn('[project-maintenance] orphan-compute reconcile failed:', err instanceof Error ? err.message : err);
        return { checked: 0, closed: 0, errors: 0 };
      }),
      // Session-side leak fix: reconcile project_sessions stuck in an ACTIVE
      // status with no running box behind them — invisible to the provider reaper
      // above (which keys off an `active` sandbox row) and the real reason an
      // account's concurrent-session cap fills up and wedges Slack. DB-only, so
      // it drains the cap even while Daytona is throttling the box reaper.
      reconcileStuckActiveSessions().catch((err) => {
        console.warn('[project-maintenance] stuck-session reconcile failed:', err instanceof Error ? err.message : err);
        return { candidates: 0, reconciled: 0, billingClosed: 0, errors: 0 };
      }),
      // Provider-authoritative orphan-BOX reaper: stops boxes still running on
      // the provider (this env) with no live DB row — the leak the DB-driven
      // reaper above structurally can't see. STOP-only, label-scoped, age-gated.
      reapOrphanProviderBoxes().catch((err) => {
        console.warn('[project-maintenance] orphan-box reaper failed:', err instanceof Error ? err.message : err);
        return { listed: 0, orphans: 0, stopped: 0, errors: 0 };
      }),
      sweepExpiredSessionBranches(),
      // Billing v2 — partial-bill any active compute sessions that haven't
      // settled in > 1h, so a missed stop hook can't accrue uncharged compute.
      tickRunningComputeCharges().catch((err) => {
        console.warn('[project-maintenance] compute tick failed:', err instanceof Error ? err.message : err);
        return { settled: 0 };
      }),
      // Heal snapshot build-log rows orphaned at "building" by a process
      // restart/crash, globally across all projects.
      reconcileStaleBuilds().catch((err) => {
        console.warn('[project-maintenance] stale-build reconcile failed:', err instanceof Error ? err.message : err);
        return { checked: 0, closedReady: 0, closedFailed: 0 };
      }),
      // GC superseded template snapshots (content-addressed names orphaned by
      // every identity drift) before the 100/org Daytona quota fills up.
      // Pressure-gated + bounded; no-op while the ORG total is small.
      reconcileSnapshotQuota().catch((err) => {
        console.warn('[project-maintenance] snapshot quota GC failed:', err instanceof Error ? err.message : err);
        return { orgTotal: 0, managedCount: 0, eligible: 0, deleted: 0, deferred: 0, dryRun: false };
      }),
    ]);
    const hadAction = Boolean(
      idle.stopped || idle.reconciled || idle.errors || orphanCompute.closed || orphanCompute.errors ||
      stuckSessions.reconciled || stuckSessions.errors ||
      orphanBoxes.stopped || orphanBoxes.errors ||
      branches.deleted || branches.errors ||
      computeTick.settled || staleBuilds.closedReady || staleBuilds.closedFailed ||
      snapshotGc.deleted,
    );
    if (hadAction) {
      console.log('[project-maintenance] completed', { idle, orphanCompute, stuckSessions, orphanBoxes, branches, computeTick, staleBuilds, snapshotGc });
    }
    // Unconditional heartbeat — proof-of-life independent of whether any
    // action happened. A stuck lock (see the watchdog above) produces total
    // silence from this function forever; a healthy loop with nothing to do
    // ALSO produces total silence under the old (action-gated-only) logging,
    // making the two indistinguishable from logs alone — which is exactly how
    // the 2026-07-02 incident went undetected for hours. This line is cheap
    // (one per cycle, ~every 5min) and makes "the loop is alive" observable —
    // wire an alert on its absence for N cycles instead of trusting silence.
    console.log(`[project-maintenance] heartbeat idle_candidates=${idle.candidates} action=${hadAction}`);

    // Invariant monitor: in steady state, every `active` compute session has a
    // running box. A non-zero count means billing is leaking — make it loud so a
    // silent regression pages instead of accruing $ for days (the original bug).
    try {
      const billingLeak = await countBillingInvariantViolations();
      if (billingLeak > 0) {
        console.warn(`[project-maintenance] BILLING INVARIANT VIOLATED: ${billingLeak} active compute session(s) with a non-running box`);
      }
    } catch (err) {
      console.warn('[project-maintenance] billing invariant check failed:', err instanceof Error ? err.message : err);
    }
  } finally {
    // Only the run that's still current may release the lock — see
    // maintenanceGeneration's docstring for why an abandoned, force-reset run
    // settling later must not clobber a newer run's state.
    if (maintenanceGeneration === myGeneration) {
      maintenanceRunning = false;
      maintenanceStartedAt = null;
    }
  }
}

export function startProjectMaintenance(): void {
  if (process.env.KORTIX_PROJECT_MAINTENANCE_ENABLED === 'false') return;
  if (globalForProjectMaintenance.__kortixProjectMaintenanceTimer) {
    clearInterval(globalForProjectMaintenance.__kortixProjectMaintenanceTimer);
  }
  maintenanceTimer = setInterval(() => {
    runProjectMaintenance().catch((err) => {
      console.error('[project-maintenance] run failed:', err);
    });
  }, maintenanceIntervalMs());
  globalForProjectMaintenance.__kortixProjectMaintenanceTimer = maintenanceTimer;
}

export function stopProjectMaintenance(): void {
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  }
  if (globalForProjectMaintenance.__kortixProjectMaintenanceTimer) {
    clearInterval(globalForProjectMaintenance.__kortixProjectMaintenanceTimer);
    globalForProjectMaintenance.__kortixProjectMaintenanceTimer = null;
  }
}
