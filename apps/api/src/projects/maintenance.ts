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

async function runProjectMaintenance(): Promise<void> {
  if (maintenanceRunning) return;
  maintenanceRunning = true;
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
      // Pressure-gated + bounded; no-op while the namespace is small.
      reconcileSnapshotQuota().catch((err) => {
        console.warn('[project-maintenance] snapshot quota GC failed:', err instanceof Error ? err.message : err);
        return { namespaceCount: 0, eligible: 0, deleted: 0, dryRun: false };
      }),
    ]);
    if (
      idle.stopped || idle.reconciled || idle.errors || orphanCompute.closed || orphanCompute.errors ||
      stuckSessions.reconciled || stuckSessions.errors ||
      orphanBoxes.stopped || orphanBoxes.errors ||
      branches.deleted || branches.errors ||
      computeTick.settled || staleBuilds.closedReady || staleBuilds.closedFailed ||
      snapshotGc.deleted
    ) {
      console.log('[project-maintenance] completed', { idle, orphanCompute, stuckSessions, orphanBoxes, branches, computeTick, staleBuilds, snapshotGc });
    }

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
    maintenanceRunning = false;
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
