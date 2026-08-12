/**
 * The monitor box: provisioning, convergence, and teardown.
 *
 * This is the DB/provider half of the reconciler — ./monitor-box-core.ts owns
 * every decision, this module executes them. It runs from
 * `runProjectMaintenance` (spec D5: a reconciler, not an imperative lifecycle),
 * so a box that should exist gets created no matter which code path failed to
 * create it, and a box that should not exist gets torn down no matter which
 * code path forgot to.
 *
 * Three properties are load-bearing and easy to lose:
 *
 *  - **Liveness is a CONTROL-PLANE observation.** `observeBox` asks the
 *    provider whether the box is running and only then stamps
 *    `markComputeSessionAlive`. A persistent box produces no session traffic,
 *    so without this sweep its billing window would be clamped dead by
 *    compute-liveness within the hour. The box's own ingest POSTs are NOT
 *    acceptable evidence (billing/services/compute-liveness.ts) — letting a box
 *    extend its own bill is the bug, not the feature.
 *  - **The repo comes through the git proxy.** The box clones
 *    `${API}/v1/git/<project>.git` with its own sandbox token. The
 *    clone-credential HTTP route is scoped to `session_sandboxes` and would 403
 *    a monitor box; the git-proxy form is the only transport that works.
 *  - **No session branch.** `KORTIX_BRANCH_NAME` is deliberately omitted, so
 *    the daemon leaves the checkout on default-branch HEAD. A monitor watches
 *    what is shipped, not what some session is working on.
 *
 * Spec: docs/specs/2026-08-12-monitors.md.
 */

import {
  projectMonitorBoxes,
  projectMonitorEvents,
  projectTriggerRuntime,
  projects,
  sandboxComputeSessions,
} from '@kortix/db';
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import {
  calculateComputeCost,
  endComputeSession,
  markComputeSessionAlive,
} from '../../billing/services/compute-metering';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { type ProviderName, getProvider } from '../../platform/providers';
import { db } from '../../shared/db';
import { MONITOR_PROVIDER, monitorProviderConfigured } from './monitor-box-provider';
import {
  MONITOR_EVENT_RETENTION_DAYS,
  MONITOR_LIVE_BOX_STATUSES,
  type MonitorBoxSnapshot,
  type MonitorBoxStore,
  type MonitorCatalogRow,
  type MonitorProjectSnapshot,
  type MonitorReconcileResult,
  buildMonitorEnvPayload,
  emptyMonitorReconcileResult,
  monitorMonthlyBudgetUsd,
  reconcileMonitorBoxesWithStore,
} from './monitor-box-core';

/** Rows deleted per retention pass, so one sweep can never stampede the DB. */
const MONITOR_RETENTION_BATCH = 5_000;

// ─── The store ──────────────────────────────────────────────────────────────

export const databaseMonitorBoxStore: MonitorBoxStore = {
  async listProjects() {
    // Two sources, unioned: projects that DECLARE a monitor (they may need a
    // box) and projects that still HOLD a live box (they may need it removed —
    // a project whose last monitor was deleted has no catalog row left to find
    // it by, and its box would otherwise run forever).
    const [declaring, holding] = await Promise.all([
      db
        .selectDistinct({ projectId: projectTriggerRuntime.projectId })
        .from(projectTriggerRuntime)
        .where(eq(projectTriggerRuntime.triggerType, 'monitor')),
      db
        .selectDistinct({ projectId: projectMonitorBoxes.projectId })
        .from(projectMonitorBoxes)
        .where(inArray(projectMonitorBoxes.status, [...MONITOR_LIVE_BOX_STATUSES])),
    ]);
    const projectIds = [
      ...new Set([...declaring, ...holding].map((row) => row.projectId)),
    ];
    if (projectIds.length === 0) return [];

    const projectRows = await db
      .select()
      .from(projects)
      .where(inArray(projects.projectId, projectIds));

    const snapshots: MonitorProjectSnapshot[] = [];
    for (const project of projectRows) {
      const [catalog, box] = await Promise.all([
        db
          .select({
            slug: projectTriggerRuntime.slug,
            enabled: projectTriggerRuntime.enabled,
            scheduleRevision: projectTriggerRuntime.scheduleRevision,
            scheduleSpec: projectTriggerRuntime.scheduleSpec,
          })
          .from(projectTriggerRuntime)
          .where(
            and(
              eq(projectTriggerRuntime.projectId, project.projectId),
              eq(projectTriggerRuntime.triggerType, 'monitor'),
            ),
          ),
        loadLiveMonitorBox(project.projectId),
      ]);
      snapshots.push({
        projectId: project.projectId,
        accountId: project.accountId,
        active: project.status === 'active',
        flagEnabled: resolveFeatureFlag(project.metadata, 'monitors'),
        monitors: catalog.map(
          (row): MonitorCatalogRow => ({
            slug: row.slug,
            enabled: row.enabled !== false,
            scheduleRevision: row.scheduleRevision,
            spec: (row.scheduleSpec ?? null) as MonitorCatalogRow['spec'],
          }),
        ),
        box,
        // Carried for createBox; not part of any decision.
        repoUrl: project.repoUrl,
        defaultBranch: project.defaultBranch,
        manifestPath: project.manifestPath,
        metadata: project.metadata,
      });
    }
    return snapshots;
  },

  async disableMonitor(projectId, slug, error) {
    await db
      .update(projectTriggerRuntime)
      .set({ enabled: false, lastError: error, updatedAt: new Date() })
      .where(
        and(eq(projectTriggerRuntime.projectId, projectId), eq(projectTriggerRuntime.slug, slug)),
      );
  },

  async budgetExceeded(project) {
    const budget = monitorMonthlyBudgetUsd(project.metadata);
    if (budget <= 0) return true;
    return (await monitorMonthlyComputeCost(project.projectId)) >= budget;
  },

  async createBox(project, monitors, revision) {
    // Loaded ON DEMAND: provisioning drags in the snapshot builder, the secrets
    // snapshot, and the grant resolver, and the sweep does not need any of them
    // on a tick where no box has to be built. See ./monitor-box-provision.ts.
    const { provisionMonitorBox } = await import('./monitor-box-provision');
    await provisionMonitorBox(project, monitors, revision);
  },

  async stopBox(project, box, reason) {
    await stopMonitorBox(project, box, reason);
  },

  async observeBox(project, box) {
    await observeMonitorBox(project, box);
  },

  async appendLifecycleEvent(project, slug, epoch, line) {
    await db
      .insert(projectMonitorEvents)
      .values({
        projectId: project.projectId,
        slug,
        boxEpoch: epoch,
        seq: 0,
        kind: 'lifecycle',
        line,
        emittedAt: new Date(),
        status: 'pending',
      })
      .onConflictDoNothing({
        target: [
          projectMonitorEvents.projectId,
          projectMonitorEvents.slug,
          projectMonitorEvents.boxEpoch,
          projectMonitorEvents.seq,
        ],
      });
  },
};

export async function loadLiveMonitorBox(projectId: string): Promise<MonitorBoxSnapshot | null> {
  const [box] = await db
    .select({
      boxId: projectMonitorBoxes.boxId,
      status: projectMonitorBoxes.status,
      manifestRevision: projectMonitorBoxes.manifestRevision,
      externalId: projectMonitorBoxes.externalId,
      createdAt: projectMonitorBoxes.createdAt,
    })
    .from(projectMonitorBoxes)
    .where(
      and(
        eq(projectMonitorBoxes.projectId, projectId),
        inArray(projectMonitorBoxes.status, [...MONITOR_LIVE_BOX_STATUSES]),
      ),
    )
    .limit(1);
  return box ?? null;
}

// ─── Teardown and observation ───────────────────────────────────────────────

/**
 * Tear a box down completely: provider REMOVE (not stop), billing finalized,
 * row closed out as `deleted`.
 *
 * Remove rather than stop because a monitor box holds nothing worth preserving
 * — the repo is re-cloned at boot and the events already live in Postgres — and
 * a stopped-but-kept box would leak provider disk for as long as the flag stays
 * off. Billing closes FIRST so a failed provider call can never leave a meter
 * running on a box we already decided to destroy.
 */
async function stopMonitorBox(
  project: MonitorProjectSnapshot,
  box: MonitorBoxSnapshot,
  reason: string,
): Promise<void> {
  await endComputeSession(box.boxId).catch((error) =>
    console.warn(
      `[monitor-box] failed to close metering for ${box.boxId}:`,
      error instanceof Error ? error.message : error,
    ),
  );
  if (box.externalId) {
    await getProvider(MONITOR_PROVIDER)
      .remove(box.externalId)
      .catch((error) =>
        console.warn(
          `[monitor-box] provider remove failed for ${box.externalId}:`,
          error instanceof Error ? error.message : error,
        ),
      );
  }
  const now = new Date();
  await db
    .update(projectMonitorBoxes)
    .set({
      status: 'deleted',
      stoppedAt: now,
      updatedAt: now,
      metadata: sql`coalesce(${projectMonitorBoxes.metadata}, '{}'::jsonb) || ${JSON.stringify({ stopReason: reason })}::jsonb`,
    })
    .where(eq(projectMonitorBoxes.boxId, box.boxId));
  console.log(`[monitor-box] stopped ${box.boxId} for ${project.projectId}: ${reason}`);
}

/**
 * Observe a box that should be running, and stamp billing liveness from THAT
 * observation.
 *
 * The status branches are deliberately conservative. Only a DEFINITIVE
 * `removed` tears the row down (so the next tick rebuilds); `unknown` — the
 * steady state of a provider hiccup — changes nothing, because acting on it
 * would destroy a healthy box during an outage.
 */
/** Floor before a running box may be recycled for a stale agent — gives the
 *  post-deploy template refresh time to land and never probes a booting box. */
const STALE_AGENT_RECYCLE_MIN_AGE_MS = 30 * 60 * 1000;

/**
 * Ask the box's daemon which boot path it took. `'monitor'` = current binary in
 * monitor mode; `'session'` = the daemon booted the session path (an agent
 * binary that predates monitor mode omits the field — same verdict); `null` =
 * unreachable/unparseable, in which case the caller must do nothing (the
 * provider's own status governs and the box may legitimately still be booting).
 */
async function probeBoxWorkload(
  provider: ReturnType<typeof getProvider>,
  externalId: string,
): Promise<'monitor' | 'session' | null> {
  try {
    // resolveEndpoint, not resolveIngress: the exposed edge is gated by the
    // per-box serviceKey bearer, and only resolveEndpoint attaches it — a bare
    // ingress URL answers 401 and the probe would silently no-op forever.
    const endpoint = await provider.resolveEndpoint(externalId);
    const res = await fetch(`${endpoint.url.replace(/\/$/, '')}/kortix/health`, {
      headers: endpoint.headers ?? {},
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { daemon?: string; workload?: string };
    if (body?.daemon !== 'ok') return null;
    return body.workload === 'monitor' ? 'monitor' : 'session';
  } catch {
    return null;
  }
}

async function observeMonitorBox(
  project: MonitorProjectSnapshot,
  box: MonitorBoxSnapshot,
): Promise<void> {
  if (!box.externalId) return;
  const provider = getProvider(MONITOR_PROVIDER);
  const status = await provider.getStatus(box.externalId);
  const now = new Date();
  if (status === 'running') {
    // THE liveness stamp. Without a control-plane observation the window is
    // clamped at lastAliveAt + grace and the box silently stops earning.
    await markComputeSessionAlive(box.boxId, now);
    await db
      .update(projectMonitorBoxes)
      .set({ lastHeartbeatAt: now, updatedAt: now })
      .where(eq(projectMonitorBoxes.boxId, box.boxId));
    // A running box whose daemon booted the SESSION path can never run
    // monitors: the baked agent binary predates monitor mode. The shared
    // template refreshes asynchronously after a deploy, so a box created in
    // that window bakes the old binary (observed live on dev 2026-08-12:
    // env said KORTIX_WORKLOAD=monitor, health said opencode/session).
    // Recycle it; the next pass recreates it from the refreshed template.
    // The age floor stops a churn loop while the template pipeline is still
    // catching up, and keeps the probe off freshly-booting boxes.
    const ageMs = box.createdAt ? now.getTime() - new Date(box.createdAt).getTime() : 0;
    if (ageMs > STALE_AGENT_RECYCLE_MIN_AGE_MS) {
      const workload = await probeBoxWorkload(provider, box.externalId);
      if (workload === 'session') {
        console.warn(
          `[monitor-box] box ${box.boxId} daemon lacks monitor mode (stale agent binary); recycling`,
        );
        await stopMonitorBox(project, box, 'daemon booted without monitor mode (stale agent binary)');
      }
    }
    return;
  }
  if (status === 'stopped') {
    // A persistent box should never idle-stop. If it did (host maintenance,
    // an operator action), start it rather than rebuild it.
    await provider.start(box.externalId).catch((error) =>
      console.warn(
        `[monitor-box] restart of stopped box ${box.externalId} failed:`,
        error instanceof Error ? error.message : error,
      ),
    );
    return;
  }
  if (status === 'removed') {
    console.warn(
      `[monitor-box] box ${box.boxId} is gone on the provider; closing the row for rebuild`,
    );
    await stopMonitorBox(project, box, 'provider reports the box is removed');
  }
}

// ─── Budget ─────────────────────────────────────────────────────────────────

/**
 * This calendar month's monitor compute for one project, including the accrual
 * on the currently-open window. Mirrors apps/budget.ts's
 * `appMonthlyComputeCost`; the join is `sandbox_id = box_id` because a monitor
 * window's sandbox id IS its box id.
 */
export async function monitorMonthlyComputeCost(
  projectId: string,
  now = new Date(),
): Promise<number> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const rows = await db
    .select({
      costUsd: sandboxComputeSessions.costUsd,
      endedAtValue: sandboxComputeSessions.endedAt,
      lastBilledAt: sandboxComputeSessions.lastBilledAt,
      provider: sandboxComputeSessions.provider,
      cpuCores: sandboxComputeSessions.cpuCores,
      memoryGb: sandboxComputeSessions.memoryGb,
      diskGb: sandboxComputeSessions.diskGb,
    })
    .from(sandboxComputeSessions)
    .innerJoin(projectMonitorBoxes, eq(projectMonitorBoxes.boxId, sandboxComputeSessions.sandboxId))
    .where(
      and(
        eq(projectMonitorBoxes.projectId, projectId),
        gte(sandboxComputeSessions.startedAt, monthStart.toISOString()),
      ),
    );
  let total = 0;
  for (const row of rows) {
    total += Number(row.costUsd || 0);
    if (!row.endedAtValue) {
      const unbilledSeconds = Math.max(
        0,
        (now.getTime() - new Date(row.lastBilledAt).getTime()) / 1000,
      );
      total += calculateComputeCost(
        {
          cpuCores: row.cpuCores,
          memoryGb: row.memoryGb,
          diskGb: row.diskGb,
          gpuCount: 0,
        },
        unbilledSeconds,
        row.provider as ProviderName,
      );
    }
  }
  return total;
}

// ─── Retention ──────────────────────────────────────────────────────────────

/**
 * Delete monitor events past the retention horizon. Bounded per pass — the log
 * is append-only and a busy project can produce thousands of rows a day, so an
 * unbounded DELETE would be a lock-holding surprise on the maintenance tick.
 */
export async function purgeExpiredMonitorEvents(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - MONITOR_EVENT_RETENTION_DAYS * 24 * 60 * 60_000);
  const doomed = await db
    .select({ eventId: projectMonitorEvents.eventId })
    .from(projectMonitorEvents)
    .where(lt(projectMonitorEvents.ingestedAt, cutoff))
    .orderBy(asc(projectMonitorEvents.ingestedAt))
    .limit(MONITOR_RETENTION_BATCH);
  if (doomed.length === 0) return 0;
  await db.delete(projectMonitorEvents).where(
    inArray(
      projectMonitorEvents.eventId,
      doomed.map((row) => row.eventId),
    ),
  );
  return doomed.length;
}

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * One monitor-box reconcile pass, wired into `runProjectMaintenance`.
 *
 * A no-op when the flag's provider is not configured: without Platinum there is
 * no runtime that can host a persistent box, and the `monitors` flag already
 * reports `available: false` in that environment.
 */
export async function reconcileMonitorBoxes(
  now = new Date(),
  store: MonitorBoxStore = databaseMonitorBoxStore,
): Promise<MonitorReconcileResult> {
  if (!monitorProviderConfigured()) return emptyMonitorReconcileResult();
  return reconcileMonitorBoxesWithStore(store, now);
}
