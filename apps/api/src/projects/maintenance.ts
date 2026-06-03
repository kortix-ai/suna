import { and, eq, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';
import { projectSessions, projects, sessionSandboxes } from '@kortix/db';
import { db } from '../shared/db';
import { getProvider, type ProviderName } from '../platform/providers';
import { invalidateProviderCache } from '../sandbox-proxy';
import { deleteRemoteSessionBranch, type GitBackedProject } from './git';
import { pauseComputeSession, tickRunningComputeCharges } from '../billing/services/compute-metering';
import { reconcileStaleBuilds } from '../snapshots/builder';
import { reconcileWarmPool } from '../platform/services/warm-pool';

const DEFAULT_IDLE_TTL_MS = 60 * 60 * 1000;
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

function sandboxIdleTtlMs(): number {
  return positiveInt(process.env.KORTIX_SANDBOX_IDLE_TTL, DEFAULT_IDLE_TTL_MS);
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

/**
 * Daytona auto-stops idle sandboxes on its own (autoStopInterval), so by the
 * time this hourly idle GC runs the sandbox is frequently already stopped,
 * archived, or deleted. Those are the desired end state — not failures — so we
 * reconcile our row quietly instead of logging a stack trace per sandbox.
 */
function isAlreadyNotRunning(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('not started') ||
    msg.includes('not running') ||
    msg.includes('already stopped') ||
    msg.includes('not found')
  );
}

function isLifecycleTransitionInProgress(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes('state change in progress') || msg.includes('transition in progress');
}

export async function hibernateIdleSessionSandboxes(now = new Date()): Promise<{
  candidates: number;
  stopped: number;
  skipped: number;
  errors: number;
}> {
  const cutoff = new Date(now.getTime() - sandboxIdleTtlMs());
  const cutoffParam = postgresTimestampParam(cutoff);
  const rows = await db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      sessionId: sessionSandboxes.sessionId,
      accountId: sessionSandboxes.accountId,
      provider: sessionSandboxes.provider,
      externalId: sessionSandboxes.externalId,
    })
    .from(sessionSandboxes)
    .where(and(
      eq(sessionSandboxes.status, 'active'),
      isNotNull(sessionSandboxes.externalId),
      // Never hibernate an unclaimed warm-pool box (pool_state set) — it has no
      // session activity by design. Claimed boxes have pool_state cleared and
      // hibernate normally. See docs/specs/warm-pool.md.
      sql`${sessionSandboxes.poolState} IS NULL`,
      sql`coalesce(${sessionSandboxes.lastUsedAt}, ${sessionSandboxes.updatedAt}, ${sessionSandboxes.createdAt}) < ${cutoffParam}::timestamptz`,
    ))
    .limit(GC_BATCH_SIZE);

  let stopped = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    if (!row.externalId) {
      skipped += 1;
      continue;
    }

    // Local Docker containers are launched with --rm, so stopping one discards
    // the runnable container id. Skip until local resume can re-create them.
    if (row.provider !== 'daytona') {
      skipped += 1;
      continue;
    }

    try {
      const provider = getProvider(row.provider as ProviderName);
      await provider.stop(row.externalId);
      invalidateProviderCache(row.externalId);
      const stoppedAt = new Date();

      // Billing v2 — close out the compute metering row before flipping
      // status, so the wall-time delta is computed against an `active` row.
      void pauseComputeSession(row.sandboxId).catch((err) =>
        console.warn(`[maintenance] compute pauseComputeSession failed for ${row.sandboxId}:`, err),
      );

      await db
        .update(sessionSandboxes)
        .set({ status: 'stopped', updatedAt: stoppedAt })
        .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
      await db
        .update(projectSessions)
        .set({ status: 'stopped', updatedAt: stoppedAt })
        .where(eq(projectSessions.sessionId, row.sessionId));

      stopped += 1;
    } catch (err) {
      // Already stopped/archived/gone on Daytona's side — that's success.
      // Reconcile our row to match and move on without the noisy stack trace.
      if (isAlreadyNotRunning(err)) {
        const reconciledAt = new Date();
        await db
          .update(sessionSandboxes)
          .set({ status: 'stopped', updatedAt: reconciledAt })
          .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
        await db
          .update(projectSessions)
          .set({ status: 'stopped', updatedAt: reconciledAt })
          .where(eq(projectSessions.sessionId, row.sessionId));
        invalidateProviderCache(row.externalId);
        stopped += 1;
        continue;
      }
      if (isLifecycleTransitionInProgress(err)) {
        skipped += 1;
        continue;
      }
      errors += 1;
      console.error(`[project-maintenance] Failed to hibernate sandbox ${row.sandboxId}: ${(err as Error)?.message ?? err}`);
    }
  }

  return { candidates: rows.length, stopped, skipped, errors };
}

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
    const [idle, branches, computeTick, staleBuilds, warmPool] = await Promise.all([
      hibernateIdleSessionSandboxes(),
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
      // Keep each enabled project's warm sandbox pool at its desired size and
      // reap dead/aged boxes. No-op when KORTIX_WARM_POOL_MAX_TOTAL=0.
      reconcileWarmPool().catch((err) => {
        console.warn('[project-maintenance] warm-pool reconcile failed:', err instanceof Error ? err.message : err);
        return { reaped: 0, projects: 0 };
      }),
    ]);
    if (
      idle.stopped || idle.errors || branches.deleted || branches.errors ||
      computeTick.settled || staleBuilds.closedReady || staleBuilds.closedFailed || warmPool.reaped
    ) {
      console.log('[project-maintenance] completed', { idle, branches, computeTick, staleBuilds, warmPool });
    }
  } finally {
    maintenanceRunning = false;
  }
}

export function startProjectMaintenance(): void {
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
