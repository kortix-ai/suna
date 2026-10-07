/**
 * The backends sweep of the project maintenance tick (every 5 min).
 *
 * 1. Resume: a `provisioning` row whose heartbeat stopped lost its API process
 *    (a deploy, an OOM). Provisioning runs again: the create replays with the
 *    same Idempotency-Key, so Platinum returns the same machine. A row that
 *    needed MAX_PROVISION_ATTEMPTS attempts becomes `error`.
 * 2. Take over: an operation (resize, rotation, recovery) whose heartbeat
 *    stopped is recovered: the machine is started if it is down, the admin key
 *    is re-sealed, the size is read back, and `last_operation_error` says it
 *    was interrupted.
 * 3. Park and unpark (./lifecycle.ts): the backends of an archived project
 *    stop, those of a project that is active again come back.
 * 4. Probe: every running backend of an active project. Platinum's view of the
 *    machine plus `GET <url>/version` (5 s) and disk use. The result is
 *    `metadata.health` (the API's `health`). A stopped machine is started; a
 *    lost or system-tombstoned one is restored from its last automatic backup.
 *    A machine Platinum no longer has turns the row `error` after
 *    UNHEALTHY_ALERT_AFTER probes. Three failed probes in a row log at error
 *    level, which alerts. The probe is also the meter: a running machine has
 *    an open compute window (workload_type `backend`) and its liveness is
 *    recorded; a machine that is not running has its window closed.
 * 5. Snapshots: every running backend of an active project gets a daily
 *    automatic snapshot (kept 7 days), and expired automatic and resize
 *    snapshots are deleted (./operations.ts). At most SNAPSHOT_JOBS_PER_TICK
 *    start per tick, each under the `snapshotting` lock.
 * 6. Orphans (./lifecycle.ts): retry failed machine deletes; once an hour,
 *    delete backend machines no live row references.
 *
 * Steps 1, 2 and 5 and the repairs in step 4 run detached: they heartbeat, so a
 * later tick never starts a second copy, and a process that dies mid-way is
 * taken over again.
 */

import { projectBackends, projects } from '@kortix/db';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { isPlatinumConfigured, platinumJson } from '../shared/platinum';
import { mapWithConcurrency } from '../shared/map-with-concurrency';
import {
  markComputeSessionAlive,
  pauseComputeSession,
  startComputeSession,
} from '../billing/services/compute-metering';
import { parkAndUnparkBackends, reapOrphanBackendMachines, retryPendingMachineDeletes } from './lifecycle';
import { resolveSessionSandboxRegion } from '../platform/services/sandbox-region';
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
  runSnapshotMaintenance,
} from './operations';
import { BACKEND_PROVIDER, type BackendRow, discardMachine, provisionBackend } from './provision';

export const MAX_PROVISION_ATTEMPTS = 3;
/** Consecutive failed probes before an error-level log, and before a missing machine turns the row `error`. */
export const UNHEALTHY_ALERT_AFTER = 3;
/** Disk use at which the probe warns. */
export const DISK_WARN_PCT = 80;
const PROBE_CONCURRENCY = 4;
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
function startRecovery(row: BackendRow, interrupted: string | null): void {
  void (async () => {
    let error: string | null = null;
    try {
      const action = await recoverBackend(row);
      logger.warn('[backends] recovered', { backendId: row.backendId, action, interrupted });
      if (interrupted) error = `The ${INTERRUPTED_NAMES[interrupted] ?? interrupted} was interrupted. The backend runs again; retry it.`;
    } catch (recoverError) {
      error = `Recovery failed: ${backendFailureMessage(recoverError)}`;
      logger.error('[backends] recovery failed', { backendId: row.backendId, interrupted, error: String(recoverError) });
    }
    await releaseOperation(row.backendId, error).catch(() => {});
  })();
}

/** 1. Provisions whose API process died. */
async function resumeProvisions(result: BackendSweepResult): Promise<void> {
  const meta = projectBackends.metadata;
  const claimed = await db
    .update(projectBackends)
    .set({
      metadata: sql`coalesce(${meta}, '{}'::jsonb) || jsonb_build_object('heartbeatAt', ${new Date().toISOString()}::text, 'provisionAttempts', coalesce((${meta}->>'provisionAttempts')::int, 1) + 1)`,
    })
    .where(
      and(
        eq(projectBackends.status, 'provisioning'),
        isNull(projectBackends.deletedAt),
        sql`coalesce((${meta}->>'heartbeatAt')::timestamptz, ${projectBackends.createdAt}) < ${staleBefore()}::timestamptz`,
      ),
    )
    .returning();
  for (const row of claimed) {
    const attempts = Number((row.metadata as { provisionAttempts?: unknown }).provisionAttempts);
    const [project] = await db.select({ metadata: projects.metadata }).from(projects).where(eq(projects.projectId, row.projectId));
    if (attempts > MAX_PROVISION_ATTEMPTS || !project) {
      result.failedProvisions += 1;
      logger.error('[backends] provisioning abandoned', { backendId: row.backendId, attempts });
      const pending = await discardMachine(row.backendId, row.externalId);
      await db
        .update(projectBackends)
        .set({
          status: 'error',
          updatedAt: new Date(),
          metadata: {
            lastError: `Provisioning was interrupted ${MAX_PROVISION_ATTEMPTS} times. Delete this backend and create it again.`,
            ...pending,
          },
        })
        .where(and(eq(projectBackends.backendId, row.backendId), eq(projectBackends.status, 'provisioning')));
      continue;
    }
    result.resumed += 1;
    logger.warn('[backends] resuming an interrupted provision', { backendId: row.backendId, attempts });
    void provisionBackend(row, resolveSessionSandboxRegion(project.metadata)).catch((error) =>
      logger.error('[backends] resumed provision failed', { backendId: row.backendId, error: String(error) }),
    );
  }
}

/** 2. Operations whose API process died. */
async function takeOverOperations(result: BackendSweepResult): Promise<void> {
  const meta = projectBackends.metadata;
  const stale = await db
    .select()
    .from(projectBackends)
    .where(
      and(
        isNull(projectBackends.deletedAt),
        isNotNull(projectBackends.externalId),
        sql`${meta} ? 'operation'`,
        sql`coalesce((${meta}->>'heartbeatAt')::timestamptz, (${meta}->>'operationStartedAt')::timestamptz) < ${staleBefore()}::timestamptz`,
      ),
    );
  for (const row of stale) {
    const interrupted = String((row.metadata as { operation?: unknown }).operation);
    if (!(await claimOperation(row.backendId, 'recovering'))) continue;
    result.recovered += 1;
    startRecovery(row, interrupted === 'recovering' ? null : interrupted);
  }
}

function previousFailures(row: BackendRow): number {
  const health = (row.metadata as { health?: Partial<BackendHealth> }).health;
  return typeof health?.failures === 'number' ? health.failures : 0;
}

async function versionAnswers(url: string): Promise<string | null> {
  try {
    const res = await fetch(`${url}/version`, { signal: AbortSignal.timeout(5_000) });
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
export async function probeBackend(row: BackendRow): Promise<BackendHealth> {
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
    [error, disk] = await Promise.all([versionAnswers(row.url!), diskUsedPct(externalId)]);
  } else if (machineState === 'missing') {
    error = 'The backend machine no longer exists.';
  } else if (machineState && REPAIR_STATES.has(machineState)) {
    error = `The backend machine is ${machineState}.`;
    if (await claimOperation(row.backendId, 'recovering')) {
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
    .update(projectBackends)
    .set({
      metadata: lost
        ? sql`coalesce(${projectBackends.metadata}, '{}'::jsonb) || ${JSON.stringify({ health, lastError: 'The backend machine no longer exists. Delete this backend and create it again.' })}::jsonb`
        : sql`coalesce(${projectBackends.metadata}, '{}'::jsonb) || ${JSON.stringify({ health })}::jsonb`,
      ...(lost ? { status: 'error', updatedAt: new Date() } : {}),
    })
    .where(and(eq(projectBackends.backendId, row.backendId), eq(projectBackends.status, 'running')));
  await meter(row, machineState).catch((meterError) =>
    logger.warn('[backends] metering failed', { backendId: row.backendId, error: String(meterError) }),
  );
  const context = { backendId: row.backendId, projectId: row.projectId, machineState, failures, error, repair };
  if (failures >= UNHEALTHY_ALERT_AFTER) logger.error('[backends] backend unhealthy', context);
  else if (error) logger.warn('[backends] backend probe failed', context);
  if (disk !== null && disk >= DISK_WARN_PCT) {
    logger.warn('[backends] backend disk is filling', { backendId: row.backendId, diskUsedPct: disk });
  }
  return health;
}

/**
 * A running machine bills its reserved size by wall clock: open the window (a
 * no-op when one is open) and record that the control plane saw it alive. Any
 * other observed state closes the window. Platinum not answering (null) changes
 * nothing; the billing liveness grace bounds the window.
 */
async function meter(row: BackendRow, machineState: string | null): Promise<void> {
  if (machineState === 'running') {
    await startComputeSession({
      sandboxId: row.backendId,
      accountId: row.accountId,
      provider: BACKEND_PROVIDER,
      spec: { cpuCores: row.cpu, memoryGb: row.memoryGb, diskGb: row.diskGb, gpuCount: 0 },
      workloadType: 'backend',
      metadata: { backendId: row.backendId, projectId: row.projectId, name: row.name },
    });
    await markComputeSessionAlive(row.backendId);
  } else if (machineState) {
    await pauseComputeSession(row.backendId);
  }
}

/** Running backends of active projects: the ones the probe and the snapshot job act on. */
async function runningActiveBackends(): Promise<BackendRow[]> {
  const rows = await db
    .select({ backend: projectBackends })
    .from(projectBackends)
    .innerJoin(projects, eq(projects.projectId, projectBackends.projectId))
    .where(
      and(
        eq(projectBackends.status, 'running'),
        isNull(projectBackends.deletedAt),
        isNotNull(projectBackends.externalId),
        isNotNull(projectBackends.url),
        // An archived project's backends are parked (./lifecycle.ts); the probe would start them again.
        eq(projects.status, 'active'),
      ),
    );
  return rows.map((r) => r.backend);
}

async function probeRunning(result: BackendSweepResult): Promise<void> {
  const idle = (await runningActiveBackends()).filter((row) => !backendOperation(row));
  const healths = await mapWithConcurrency(idle, PROBE_CONCURRENCY, (row) =>
    probeBackend(row).catch((error) => {
      result.errors += 1;
      logger.warn('[backends] probe crashed', { backendId: row.backendId, error: String(error) });
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

/** 5. Daily automatic snapshots and snapshot expiry. */
async function snapshotStep(result: BackendSweepResult): Promise<void> {
  const now = Date.now();
  for (const row of await runningActiveBackends()) {
    if (result.snapshotJobs >= SNAPSHOT_JOBS_PER_TICK) return;
    if (backendOperation(row)) continue;
    const takeAutomatic = automaticSnapshotDue(row, now);
    if (!takeAutomatic && expiredSnapshotIds(row, now).length === 0) continue;
    if (!(await claimOperation(row.backendId, 'snapshotting'))) continue;
    result.snapshotJobs += 1;
    void runSnapshotMaintenance(row, takeAutomatic).catch((error) =>
      logger.error('[backends] snapshot job crashed', { backendId: row.backendId, error: String(error) }),
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
  result.machinesDeleted += retried.deleted + reaped.deleted;
  result.errors += retried.errors + reaped.errors;
}

export async function sweepBackends(): Promise<BackendSweepResult> {
  const result = { ...EMPTY_BACKEND_SWEEP };
  if (!isPlatinumConfigured()) return result;
  for (const step of [resumeProvisions, takeOverOperations, parkStep, probeRunning, snapshotStep, orphanStep]) {
    await step(result).catch((error) => {
      result.errors += 1;
      logger.warn('[backends] sweep step failed', { step: step.name, error: String(error) });
    });
  }
  return result;
}
