/**
 * The `convex` App sweep of the project maintenance tick (every 5 min), run
 * through the kind module (../index.ts maintainAppKinds).
 *
 * 1. Resume: a `provisioning` row whose heartbeat stopped lost its API process
 *    (a deploy, an OOM). Provisioning runs again: the create replays with the
 *    same Idempotency-Key, so Platinum returns the same machine. A row that
 *    needed MAX_PROVISION_ATTEMPTS attempts becomes `error`.
 * 2. Take over: an operation (resize, rotation, recovery) whose heartbeat
 *    stopped is recovered: the machine is started if it is down, the admin key
 *    is re-sealed, the size is read back, and `last_operation_error` says it
 *    was interrupted.
 * 3. Park and unpark (./lifecycle.ts): the machines of an archived project
 *    stop, those of a project that is active again come back.
 * 4. Move: a backend that still stores its Platinum URLs moves to its Kortix
 *    hosts (./hosts.ts): new Convex origins, private ports, new URLs.
 * 4b. Probe: every running backend of an active project. Platinum's view of the
 *    machine plus `GET /version` (5 s, through the private exposure) and disk use. The result is
 *    `metadata.health` (the API's `health`). A stopped machine is started; a
 *    lost or system-tombstoned one is restored from its last automatic backup.
 *    A machine Platinum no longer has turns the row `error` after
 *    UNHEALTHY_ALERT_AFTER probes. Three failed probes in a row log at error
 *    level, which alerts. The probe is also the meter: a running machine has
 *    an open compute window (workload_type `backend`) and its liveness is
 *    recorded; a machine that is not running has its window closed.
 * 5. Snapshots: every running backend of an active project gets a daily
 *    automatic snapshot (kept 7 days), and expired automatic and resize
 *    snapshots are deleted (./operations.ts), on parked machines too. At most SNAPSHOT_JOBS_PER_TICK
 *    start per tick, each under the `snapshotting` lock.
 * 6. Orphans (./lifecycle.ts): retry failed machine deletes; once an hour,
 *    delete machines no App references; purge deleted Apps whose retention
 *    (`metadata.purgeAfter`) ran out.
 * 7. Budget: the App's monthly budget alerts at 80 % and at 100 % (once per
 *    month each): an audit event `app.budget.alert`, `metadata.budgetAlert`
 *    (the API's `instance.budget_alert`) and a warn log. It never stops the
 *    machine: a stopped database breaks every client.
 *
 * Steps 1, 2 and 5 and the repairs in step 4 run detached: they heartbeat, so a
 * later tick never starts a second copy, and a process that dies mid-way is
 * taken over again.
 */

import { appConvexInstances, apps, projects, sandboxComputeSessions } from '@kortix/db';
import { and, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { monthStartUtc, monthlyComputeColumns, sumMonthlyComputeCost } from '../../../billing/services/compute-accrual';
import { recordAuditEvent } from '../../../shared/audit';
import { logger } from '../../../lib/logger';
import { db } from '../../../shared/db';
import { isPlatinumConfigured, platinumJson } from '../../../shared/platinum';
import { mapWithConcurrency } from '../../../shared/map-with-concurrency';
import {
  markComputeSessionAlive,
  pauseComputeSession,
  startComputeSession,
} from '../../../billing/services/compute-metering';
import { parkAndUnparkBackends, purgeRetiredConvexApps, reapOrphanBackendMachines, retryPendingMachineDeletes } from './lifecycle';
import { resolveSessionSandboxRegion } from '../../../platform/services/sandbox-region';
import { backendFailureMessage } from './errors';
import {
  OPERATION_STALE_MS,
  type PlatinumSandboxState,
  type RecoveryAction,
  automaticSnapshotDue,
  backendOperation,
  claimOperation,
  expiredSnapshotIds,
  readMachine,
  recoverBackend,
  releaseOperation,
  rotationPendingAfterRestore,
  runSnapshotMaintenance,
} from './operations';
import {
  BACKEND_PROVIDER,
  CONVEX_ROW,
  type ConvexRow,
  discardMachine,
  liveConvexApp,
  moveBackendToKortixHosts,
  provisionBackend,
  selectConvexRows,
} from './provision';
import { CONVEX_API_PORT } from './convex-image';
import { backendPublicUrls } from './hosts';
import { machineFetch } from './machine';

export const MAX_PROVISION_ATTEMPTS = 3;
/** Consecutive failed probes before an error-level log, and before a missing machine turns the row `error`. */
export const UNHEALTHY_ALERT_AFTER = 3;
/** Disk use at which the probe warns. */
export const DISK_WARN_PCT = 80;
const PROBE_CONCURRENCY = 4;
/** Backends moved to their Kortix hosts per tick. Each move restarts Convex once (about a second). */
export const HOST_MOVES_PER_TICK = 4;
/** Snapshot jobs started per tick: spreads the first daily round of a fleet over several ticks. */
export const SNAPSHOT_JOBS_PER_TICK = 4;

export interface BackendHealth {
  ok: boolean;
  checked_at: string;
  /** Platinum's machine state: `running`, `stopped`, `restoring`, …; `missing` when Platinum has no such machine; null when Platinum did not answer. */
  machine_state: string | null;
  /** Failed probes in a row. */
  failures: number;
  error: string | null;
  disk_used_pct: number | null;
  /** What the probe did to repair the machine, if anything. */
  repair: Exclude<RecoveryAction, 'none'> | null;
}

export interface BackendSweepResult {
  resumed: number;
  failedProvisions: number;
  recovered: number;
  probed: number;
  unhealthy: number;
  repairs: number;
  parked: number;
  unparked: number;
  machinesDeleted: number;
  /** Snapshot jobs started: a daily automatic snapshot, expired snapshots to delete, or both. */
  snapshotJobs: number;
  /** Backends moved from their Platinum URLs to their Kortix hosts. */
  movedToHosts: number;
  /** Deleted Apps whose stopped machine and snapshots were purged after retention. */
  purged: number;
  /** Budget alerts recorded (80 % or 100 % of the monthly budget). */
  budgetAlerts: number;
  errors: number;
}

const INTERRUPTED_NAMES: Record<string, string> = {
  resizing: 'resize',
  rotating_key: 'admin key rotation',
  snapshotting: 'snapshot',
  restoring: 'restore',
};

const staleBefore = () => new Date(Date.now() - OPERATION_STALE_MS).toISOString();

/** Runs one recovery under the operation lock, detached. `interrupted` names the operation it takes over. */
function startRecovery(row: ConvexRow, interrupted: string | null): void {
  void (async () => {
    let error: string | null = null;
    try {
      // An interrupted restore may have brought back a secret rotated away.
      const action = await recoverBackend(row, { restored: interrupted === 'restoring' });
      logger.warn('[apps:convex] recovered', { appId: row.appId, action, interrupted });
      if (interrupted) error = `The ${INTERRUPTED_NAMES[interrupted] ?? interrupted} was interrupted. The App runs again; retry it.`;
    } catch (recoverError) {
      error = `Recovery failed: ${backendFailureMessage(recoverError)}`;
      logger.error('[apps:convex] recovery failed', { appId: row.appId, interrupted, error: String(recoverError) });
    }
    await releaseOperation(row.appId, error).catch(() => {});
  })();
}

/** 1. Provisions whose API process died. */
async function resumeProvisions(result: BackendSweepResult): Promise<void> {
  const meta = appConvexInstances.metadata;
  const ids = await db
    .update(appConvexInstances)
    .set({
      metadata: sql`coalesce(${meta}, '{}'::jsonb) || jsonb_build_object('heartbeatAt', ${new Date().toISOString()}::text, 'provisionAttempts', coalesce((${meta}->>'provisionAttempts')::int, 1) + 1)`,
    })
    .where(
      and(
        eq(appConvexInstances.status, 'provisioning'),
        sql`coalesce((${meta}->>'heartbeatAt')::timestamptz, ${appConvexInstances.createdAt}) < ${staleBefore()}::timestamptz`,
      ),
    )
    .returning({ appId: appConvexInstances.appId });
  const claimed = ids.length
    ? await selectConvexRows().where(inArray(appConvexInstances.appId, ids.map((r) => r.appId)))
    : [];
  for (const row of claimed) {
    const attempts = Number((row.metadata as { provisionAttempts?: unknown }).provisionAttempts);
    const [project] = await db.select({ metadata: projects.metadata }).from(projects).where(eq(projects.projectId, row.projectId));
    if (attempts > MAX_PROVISION_ATTEMPTS || !project) {
      result.failedProvisions += 1;
      logger.error('[apps:convex] provisioning abandoned', { appId: row.appId, attempts });
      const pending = await discardMachine(row.appId, row.externalId);
      await db
        .update(appConvexInstances)
        .set({
          status: 'error',
          updatedAt: new Date(),
          metadata: {
            lastError: `Provisioning was interrupted ${MAX_PROVISION_ATTEMPTS} times. Delete this App and create it again.`,
            ...pending,
          },
        })
        .where(and(eq(appConvexInstances.appId, row.appId), eq(appConvexInstances.status, 'provisioning')));
      continue;
    }
    result.resumed += 1;
    logger.warn('[apps:convex] resuming an interrupted provision', { appId: row.appId, attempts });
    void provisionBackend(row, resolveSessionSandboxRegion(project.metadata)).catch((error) =>
      logger.error('[apps:convex] resumed provision failed', { appId: row.appId, error: String(error) }),
    );
  }
}

/** 2. Operations whose API process died. */
async function takeOverOperations(result: BackendSweepResult): Promise<void> {
  const meta = appConvexInstances.metadata;
  const stale = await selectConvexRows()
    .where(
      and(
        liveConvexApp(),
        isNotNull(appConvexInstances.externalId),
        sql`${meta} ? 'operation'`,
        sql`coalesce((${meta}->>'heartbeatAt')::timestamptz, (${meta}->>'operationStartedAt')::timestamptz) < ${staleBefore()}::timestamptz`,
      ),
    );
  for (const row of stale) {
    const interrupted = String((row.metadata as { operation?: unknown }).operation);
    if (!(await claimOperation(row.appId, 'recovering'))) continue;
    result.recovered += 1;
    startRecovery(row, interrupted === 'recovering' ? null : interrupted);
  }
}

function previousFailures(row: ConvexRow): number {
  const health = (row.metadata as { health?: Partial<BackendHealth> }).health;
  return typeof health?.failures === 'number' ? health.failures : 0;
}

async function versionAnswers(externalId: string): Promise<string | null> {
  try {
    const res = await machineFetch(externalId, CONVEX_API_PORT, '/version', { signal: AbortSignal.timeout(5_000) });
    return res.ok ? null : `Convex answered HTTP ${res.status}`;
  } catch (error) {
    return error instanceof DOMException && error.name === 'TimeoutError'
      ? 'Convex did not answer within 5 s'
      : 'Convex did not answer';
  }
}

async function diskUsedPct(externalId: string): Promise<number | null> {
  const usage = await platinumJson<{ disk_used_pct?: number | null }>(`/v1/sandboxes/${externalId}/usage`, {
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  return typeof usage?.disk_used_pct === 'number' ? usage.disk_used_pct : null;
}

/** Platinum states the probe repairs: started, or restored from backup. */
const REPAIR_STATES = new Set(['stopped', 'archived', 'failed-start', 'lost', 'tombstoned']);

/** 3. One probe. Returns the health it recorded. */
export async function probeBackend(row: ConvexRow): Promise<BackendHealth> {
  const externalId = row.externalId!;
  let machineState: string | null = null;
  let error: string | null = null;
  let disk: number | null = null;
  let repair: BackendHealth['repair'] = null;
  let machine: PlatinumSandboxState | null = null;
  try {
    machine = await readMachine(externalId);
    machineState = !machine ? 'missing' : machine.recoverable ? 'tombstoned' : (machine.state ?? null);
  } catch (probeError) {
    error = `Kortix could not read the machine state (${backendFailureMessage(probeError)})`;
  }
  if (machineState === 'running') {
    [error, disk] = await Promise.all([versionAnswers(externalId), diskUsedPct(externalId)]);
    // A restore of a rotated backend that was never rotated again: the old key works. Rotate now.
    if (rotationPendingAfterRestore(row) && (await claimOperation(row.appId, 'recovering'))) startRecovery(row, null);
  } else if (machineState === 'missing') {
    error = 'The backend machine no longer exists.';
  } else if (machineState && REPAIR_STATES.has(machineState)) {
    error = `The backend machine is ${machineState}.`;
    if (await claimOperation(row.appId, 'recovering')) {
      repair = machineState === 'lost' || machineState === 'tombstoned' ? 'restored_from_backup' : 'started';
      startRecovery(row, null);
    }
  } else if (machineState) {
    error = `The backend machine is ${machineState}.`;
  }
  const failures = error ? previousFailures(row) + 1 : 0;
  const health: BackendHealth = {
    ok: !error,
    checked_at: new Date().toISOString(),
    machine_state: machineState,
    failures,
    error,
    disk_used_pct: disk,
    repair,
  };
  const lost = machineState === 'missing' && failures >= UNHEALTHY_ALERT_AFTER;
  await db
    .update(appConvexInstances)
    .set({
      metadata: lost
        ? sql`coalesce(${appConvexInstances.metadata}, '{}'::jsonb) || ${JSON.stringify({ health, lastError: 'The App machine no longer exists. Delete this App and create it again.' })}::jsonb`
        : sql`coalesce(${appConvexInstances.metadata}, '{}'::jsonb) || ${JSON.stringify({ health })}::jsonb`,
      ...(lost ? { status: 'error', updatedAt: new Date() } : {}),
    })
    .where(and(eq(appConvexInstances.appId, row.appId), eq(appConvexInstances.status, 'running')));
  await meter(row, machineState).catch((meterError) =>
    logger.warn('[apps:convex] metering failed', { appId: row.appId, error: String(meterError) }),
  );
  const context = { appId: row.appId, projectId: row.projectId, machineState, failures, error, repair };
  if (failures >= UNHEALTHY_ALERT_AFTER) logger.error('[apps:convex] backend unhealthy', context);
  else if (error) logger.warn('[apps:convex] backend probe failed', context);
  if (disk !== null && disk >= DISK_WARN_PCT) {
    logger.warn('[apps:convex] backend disk is filling', { appId: row.appId, diskUsedPct: disk });
  }
  return health;
}

/**
 * A running machine bills its reserved size by wall clock: open the window (a
 * no-op when one is open) and record that the control plane saw it alive. Any
 * other observed state closes the window. Platinum not answering (null) changes
 * nothing; the billing liveness grace bounds the window.
 */
async function meter(row: ConvexRow, machineState: string | null): Promise<void> {
  if (machineState === 'running') {
    await startComputeSession({
      sandboxId: row.appId,
      accountId: row.accountId,
      provider: BACKEND_PROVIDER,
      spec: { cpuCores: row.cpu, memoryGb: row.memoryGb, diskGb: row.diskGb, gpuCount: 0 },
      workloadType: 'backend',
      metadata: { appId: row.appId, projectId: row.projectId, slug: row.slug },
    });
    await markComputeSessionAlive(row.appId);
  } else if (machineState) {
    await pauseComputeSession(row.appId);
  }
}

/** Live backends with a machine, and whether their project is active. An archived project's backends are parked (./lifecycle.ts). */
async function runningBackends(): Promise<Array<{ row: ConvexRow; active: boolean }>> {
  const rows = await db
    .select({ ...CONVEX_ROW, projectStatus: projects.status })
    .from(appConvexInstances)
    .innerJoin(apps, eq(apps.appId, appConvexInstances.appId))
    .innerJoin(projects, eq(projects.projectId, apps.projectId))
    .where(
      and(
        eq(appConvexInstances.status, 'running'),
        liveConvexApp(),
        isNotNull(appConvexInstances.externalId),
        isNotNull(appConvexInstances.url),
      ),
    );
  return rows.map(({ projectStatus, ...row }) => ({ row, active: projectStatus === 'active' }));
}

async function probeRunning(result: BackendSweepResult): Promise<void> {
  // Only active projects: the probe would start a parked machine again.
  const idle = (await runningBackends()).filter(({ row, active }) => active && !backendOperation(row)).map(({ row }) => row);
  const healths = await mapWithConcurrency(idle, PROBE_CONCURRENCY, (row) =>
    probeBackend(row).catch((error) => {
      result.errors += 1;
      logger.warn('[apps:convex] probe crashed', { appId: row.appId, error: String(error) });
      return null;
    }),
  );
  for (const health of healths) {
    if (!health) continue;
    result.probed += 1;
    if (!health.ok) result.unhealthy += 1;
    if (health.repair) result.repairs += 1;
  }
}

/**
 * 4. A backend created before the Kortix hosts still stores its Platinum
 * URLs: move it (./provision.ts moveBackendToKortixHosts) under the
 * `recovering` lock. Active projects only: a parked machine is stopped. A
 * move that fails is retried next tick; the backend keeps working meanwhile.
 */
async function moveHostsStep(result: BackendSweepResult): Promise<void> {
  const pending = (await runningBackends()).filter(
    ({ row, active }) => active && !backendOperation(row) && row.url !== backendPublicUrls(row.appId).url,
  );
  for (const { row } of pending.slice(0, HOST_MOVES_PER_TICK)) {
    if (!(await claimOperation(row.appId, 'recovering'))) continue;
    try {
      await moveBackendToKortixHosts(row);
      result.movedToHosts += 1;
    } catch (error) {
      result.errors += 1;
      logger.warn('[apps:convex] move to the Kortix hosts failed; retried next tick', { appId: row.appId, error: String(error) });
    }
    // No `last_operation_error`: the user did not start this, and nothing changed for them.
    await releaseOperation(row.appId, null).catch(() => {});
  }
}

/** 5. Daily automatic snapshots (active projects) and snapshot expiry (parked backends too: their snapshots still fill the host disk). */
async function snapshotStep(result: BackendSweepResult): Promise<void> {
  const now = Date.now();
  for (const { row, active } of await runningBackends()) {
    if (result.snapshotJobs >= SNAPSHOT_JOBS_PER_TICK) return;
    if (backendOperation(row)) continue;
    const takeAutomatic = active && automaticSnapshotDue(row, now);
    if (!takeAutomatic && expiredSnapshotIds(row, now).length === 0) continue;
    if (!(await claimOperation(row.appId, 'snapshotting'))) continue;
    result.snapshotJobs += 1;
    void runSnapshotMaintenance(row, takeAutomatic).catch((error) =>
      logger.error('[apps:convex] snapshot job crashed', { appId: row.appId, error: String(error) }),
    );
  }
}

export const EMPTY_BACKEND_SWEEP: BackendSweepResult = {
  resumed: 0,
  failedProvisions: 0,
  recovered: 0,
  probed: 0,
  unhealthy: 0,
  repairs: 0,
  parked: 0,
  unparked: 0,
  machinesDeleted: 0,
  snapshotJobs: 0,
  movedToHosts: 0,
  purged: 0,
  budgetAlerts: 0,
  errors: 0,
};

async function parkStep(result: BackendSweepResult): Promise<void> {
  const step = await parkAndUnparkBackends();
  result.parked += step.parked;
  result.unparked += step.unparked;
  result.errors += step.errors;
}

async function orphanStep(result: BackendSweepResult): Promise<void> {
  const retried = await retryPendingMachineDeletes();
  const reaped = await reapOrphanBackendMachines();
  const purged = await purgeRetiredConvexApps();
  result.machinesDeleted += retried.deleted + reaped.deleted;
  result.purged += purged.purged;
  result.errors += retried.errors + reaped.errors + purged.errors;
}

/** Budget shares (percent) at which a `convex` App alerts, once per month each. */
export const BUDGET_ALERT_PERCENTS = [80, 100] as const;

/** This month's metered compute of a `convex` App (its windows: `sandbox_id` = the App id). */
export async function convexMonthlyComputeCost(appId: string, now = new Date()): Promise<number> {
  const rows = await db
    .select(monthlyComputeColumns)
    .from(sandboxComputeSessions)
    .where(
      and(
        eq(sandboxComputeSessions.sandboxId, appId),
        eq(sandboxComputeSessions.workloadType, 'backend'),
        gte(sandboxComputeSessions.startedAt, monthStartUtc(now).toISOString()),
      ),
    );
  return sumMonthlyComputeCost(rows, now);
}

/** The highest alert percent `spent` reached that this month has not alerted yet, or null. */
export function budgetAlertDue(
  row: Pick<ConvexRow, 'metadata'>,
  spentUsd: number,
  budgetUsd: number,
  now = new Date(),
): number | null {
  if (budgetUsd <= 0) return null;
  const percent = (spentUsd / budgetUsd) * 100;
  const reached = BUDGET_ALERT_PERCENTS.filter((p) => percent >= p).pop();
  if (reached === undefined) return null;
  const month = now.toISOString().slice(0, 7);
  const last = (row.metadata as { budgetAlert?: { month?: string; percent?: number } }).budgetAlert;
  return last?.month === month && (last.percent ?? 0) >= reached ? null : reached;
}

/** 7. Budget alerts for every running `convex` App. */
async function budgetStep(result: BackendSweepResult): Promise<void> {
  const now = new Date();
  for (const { row } of await runningBackends()) {
    const budgetUsd = Number(row.monthlyBudgetUsd);
    const spentUsd = await convexMonthlyComputeCost(row.appId, now);
    const percent = budgetAlertDue(row, spentUsd, budgetUsd, now);
    if (percent === null) continue;
    const alert = { month: now.toISOString().slice(0, 7), percent, spentUsd: Math.round(spentUsd * 100) / 100, budgetUsd, at: now.toISOString() };
    await db
      .update(appConvexInstances)
      .set({ metadata: sql`coalesce(${appConvexInstances.metadata}, '{}'::jsonb) || ${JSON.stringify({ budgetAlert: alert })}::jsonb` })
      .where(eq(appConvexInstances.appId, row.appId));
    await recordAuditEvent({
      accountId: row.accountId,
      projectId: row.projectId,
      action: 'app.budget.alert',
      resourceType: 'app',
      resourceId: row.appId,
      metadata: { percent, spent_usd: alert.spentUsd, budget_usd: budgetUsd, month: alert.month },
    }).catch((error) => logger.warn('[apps:convex] budget alert audit failed', { appId: row.appId, error: String(error) }));
    logger.warn('[apps:convex] App reached its monthly budget share; it keeps running', { appId: row.appId, ...alert });
    result.budgetAlerts += 1;
  }
}

export async function sweepBackends(): Promise<BackendSweepResult> {
  const result = { ...EMPTY_BACKEND_SWEEP };
  if (!isPlatinumConfigured()) return result;
  for (const step of [resumeProvisions, takeOverOperations, parkStep, moveHostsStep, probeRunning, snapshotStep, orphanStep, budgetStep]) {
    await step(result).catch((error) => {
      result.errors += 1;
      logger.warn('[apps:convex] sweep step failed', { step: step.name, error: String(error) });
    });
  }
  return result;
}
