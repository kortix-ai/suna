/**
 * Day-two operations on a running backend: resize, backups, snapshots, restore.
 * All of them are Platinum primitives on the backend's one machine.
 *
 * - Backup: Platinum copies the machine disk to S3 on its own (hourly), so a
 *   host loss restores onto a new host. Read-only here.
 * - Snapshot: memory + disk of the running machine. Restore rolls the running
 *   machine back to it in place, so Convex and its SQLite come back mutually
 *   consistent (verified 2026-10-06: healthy 2 s after restore, data rolled back).
 *   A snapshot is a full disk image, so a backend keeps the newest
 *   MAX_SNAPSHOTS and drops the rest.
 * - Resize: stop → resize (which boots) → healthy. Verified 4 s of downtime,
 *   data intact. A snapshot is taken first, so a bad resize can be undone.
 * - Admin-key rotation: a new Convex instance secret, then a Convex restart
 *   (verified on CONVEX_BACKEND_IMAGE: under 1 s of downtime; the old key gets
 *   401 BadAdminKey; documents, files and environment variables are kept).
 * - Recovery: start a stopped machine, re-spawn a lost or system-tombstoned one
 *   from its last automatic backup. Maintenance runs it (./maintenance.ts).
 *
 * One operation at a time per backend (`metadata.operation`). A running
 * operation heartbeats (`keepAlive`); one silent for OPERATION_STALE_MS lost
 * its API process, and maintenance takes it over and recovers the backend.
 */

import { projectBackends } from '@kortix/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { PlatinumHttpError, platinumJson } from '../shared/platinum';
import { logger } from '../lib/logger';
import { BackendOperationError, backendFailureMessage, backendProviderFailure } from './errors';
import { CONVEX_LOG_FILE } from './convex-image';
import { pauseComputeSession } from '../billing/services/compute-metering';
import {
  type BackendRow,
  type BackendSize,
  BACKEND_MACHINE_LIMITS,
  execInBackend,
  keepAlive,
  lastHeartbeat,
  sealAdminKey,
  waitHealthy,
} from './provision';

export const MAX_SNAPSHOTS = 5;
const STOP_WAIT_MS = 60_000;

export type PlatinumSandboxState = {
  state?: string;
  /** Whether a public request wakes the stopped machine. Absent on Platinum builds before #1335. */
  autoResume?: boolean;
  /** Set on a machine Platinum's reconciler tombstoned while a completed backup existed. */
  recoverable?: boolean;
  cpu?: number;
  ramMb?: number;
  diskGb?: number;
  backupState?: string | null;
  lastBackupAt?: string | null;
  backupSizeBytes?: number | null;
  backupIntervalMin?: number | null;
};
type PlatinumSnapshot = { id: string; createdAt: string; sizeBytes?: number | null };

export { BackendOperationError, backendFailureMessage, backendProviderFailure } from './errors';

function machine(row: BackendRow): string {
  if (row.status !== 'running' || !row.externalId || !row.url) {
    throw new BackendOperationError(`backend is ${row.status}`, 'backend_not_running');
  }
  return row.externalId;
}

export const BACKEND_OPERATIONS = ['resizing', 'rotating_key', 'recovering'] as const;
export type BackendOperationKind = (typeof BACKEND_OPERATIONS)[number];

/** An operation with no heartbeat this long lost its API process. */
export const OPERATION_STALE_MS = 2 * 60_000;

/** The operation in flight, from row metadata. A stale one counts as none. */
export function backendOperation(row: BackendRow, now = Date.now()): BackendOperationKind | null {
  const meta = row.metadata as { operation?: string; heartbeatAt?: string; operationStartedAt?: string };
  const kind = BACKEND_OPERATIONS.find((k) => k === meta.operation);
  if (!kind) return null;
  // A marker with no timestamp at all never goes stale (the SQL claim agrees).
  if (!meta.heartbeatAt && !meta.operationStartedAt) return kind;
  return now - lastHeartbeat(row) > OPERATION_STALE_MS ? null : kind;
}

/** SQL: the row has no operation, or its operation stopped heartbeating. */
function operationFree(now = Date.now()) {
  const staleBefore = new Date(now - OPERATION_STALE_MS).toISOString();
  const meta = projectBackends.metadata;
  return sql`(not (coalesce(${meta}, '{}'::jsonb) ? 'operation') or coalesce((${meta}->>'heartbeatAt')::timestamptz, (${meta}->>'operationStartedAt')::timestamptz) < ${staleBefore}::timestamptz)`;
}

/**
 * Marks the backend busy in one conditional UPDATE, so two concurrent
 * requests cannot both start an operation. A stale marker is taken over.
 */
export async function claimOperation(backendId: string, kind: BackendOperationKind): Promise<boolean> {
  const now = new Date().toISOString();
  const claimed = await db
    .update(projectBackends)
    .set({
      updatedAt: new Date(),
      metadata: sql`coalesce(${projectBackends.metadata}, '{}'::jsonb) || ${JSON.stringify({ operation: kind, operationStartedAt: now, heartbeatAt: now })}::jsonb`,
    })
    .where(and(eq(projectBackends.backendId, backendId), isNull(projectBackends.deletedAt), operationFree()))
    .returning({ id: projectBackends.backendId });
  return claimed.length === 1;
}

/** Clears the marker. `error` becomes `last_operation_error`; success clears it. */
export async function releaseOperation(backendId: string, error: string | null): Promise<void> {
  await db
    .update(projectBackends)
    .set({
      updatedAt: new Date(),
      // An operation ends with the machine running, so `parked` goes too: the
      // backend of an archived project is parked again on the next tick.
      metadata: sql`(coalesce(${projectBackends.metadata}, '{}'::jsonb) - 'operation' - 'operationStartedAt' - 'heartbeatAt' - 'lastOperationError' - 'parked') || ${JSON.stringify(error ? { lastOperationError: error.slice(0, 600) } : {})}::jsonb`,
    })
    .where(eq(projectBackends.backendId, backendId));
}

// ── Backups and snapshots ────────────────────────────────────────────────────

export async function listBackendBackups(row: BackendRow) {
  const externalId = machine(row);
  const [sandbox, snapshots] = await Promise.all([
    platinumJson<PlatinumSandboxState>(`/v1/sandboxes/${externalId}`),
    platinumJson<PlatinumSnapshot[]>(`/v1/sandboxes/${externalId}/snapshots`),
  ]);
  return {
    automatic: {
      state: sandbox.backupState ?? null,
      last_backup_at: sandbox.lastBackupAt ?? null,
      size_bytes: sandbox.backupSizeBytes ?? null,
      interval_minutes: sandbox.backupIntervalMin ?? null,
    },
    snapshots: [...snapshots]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((s) => ({ snapshot_id: s.id, created_at: s.createdAt, size_bytes: s.sizeBytes ?? null })),
    snapshot_limit: MAX_SNAPSHOTS,
  };
}

/** Takes a snapshot, waits until restorable, then trims to the newest MAX_SNAPSHOTS. */
export async function createBackendSnapshot(row: BackendRow): Promise<{ snapshot_id: string; created_at: string }> {
  const externalId = machine(row);
  const started = await platinumJson<{ id: string }>(`/v1/sandboxes/${externalId}/snapshot`, {
    method: 'POST',
    body: '{}',
  });
  const deadline = Date.now() + 20_000;
  let snapshots: PlatinumSnapshot[] = [];
  for (;;) {
    snapshots = await platinumJson<PlatinumSnapshot[]>(`/v1/sandboxes/${externalId}/snapshots`);
    if (snapshots.some((s) => s.id === started.id) || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const mine = snapshots.find((s) => s.id === started.id);
  if (!mine) throw new BackendOperationError('the snapshot did not complete in time; list backups to see it', 'snapshot_pending');
  const stale = [...snapshots].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(MAX_SNAPSHOTS);
  for (const s of stale) {
    await platinumJson(`/v1/sandboxes/${externalId}/snapshots/${s.id}`, { method: 'DELETE' }).catch((error) =>
      logger.warn('[backends] snapshot trim failed', { backendId: row.backendId, snapshotId: s.id, error: String(error) }),
    );
  }
  return { snapshot_id: mine.id, created_at: mine.createdAt };
}

/** Rolls the running machine back to one of its snapshots, then waits until it answers. */
export async function restoreBackendSnapshot(row: BackendRow, snapshotId: string): Promise<void> {
  const externalId = machine(row);
  if (backendOperation(row)) throw new BackendOperationError('wait for the resize to finish', 'backend_busy');
  const snapshots = await platinumJson<PlatinumSnapshot[]>(`/v1/sandboxes/${externalId}/snapshots`);
  if (!snapshots.some((s) => s.id === snapshotId)) {
    throw new BackendOperationError('no such snapshot on this backend', 'snapshot_not_found', 400);
  }
  await platinumJson(`/v1/sandboxes/${externalId}/restore`, {
    method: 'POST',
    body: JSON.stringify({ snapshot_id: snapshotId }),
  });
  await waitHealthy(row.url!).catch(() => {
    throw new BackendOperationError('the backend did not come back healthy after the restore; retry or restore again', 'restore_unhealthy');
  });
  // A snapshot taken before an admin-key rotation brings the old instance
  // secret back; Kortix must hold the key the machine accepts now.
  await sealAdminKey(row);
}

// ── Resize ───────────────────────────────────────────────────────────────────

/** The size a resize request asks for, or a 400 reason. Disk only grows. */
export function targetSize(row: BackendRow, want: Partial<BackendSize>): BackendSize {
  const next: BackendSize = {
    cpu: want.cpu ?? row.cpu,
    memoryGb: want.memoryGb ?? row.memoryGb,
    diskGb: want.diskGb ?? row.diskGb,
  };
  for (const key of ['cpu', 'memoryGb', 'diskGb'] as const) {
    const { min, max } = BACKEND_MACHINE_LIMITS[key];
    if (!Number.isInteger(next[key]) || next[key] < min || next[key] > max) {
      throw new BackendOperationError(`${key} must be an integer from ${min} to ${max}`, 'invalid_size', 400);
    }
  }
  if (next.diskGb < row.diskGb) {
    throw new BackendOperationError('disk can only grow', 'disk_shrink_unsupported', 400);
  }
  if (next.cpu === row.cpu && next.memoryGb === row.memoryGb && next.diskGb === row.diskGb) {
    throw new BackendOperationError('the backend already has this size', 'size_unchanged', 400);
  }
  return next;
}

/** Marks the backend `resizing`; the caller then runs `runResize` in the background. */
export async function beginResize(row: BackendRow, want: Partial<BackendSize>): Promise<BackendSize> {
  machine(row);
  const next = targetSize(row, want);
  if (!(await claimOperation(row.backendId, 'resizing'))) {
    throw new BackendOperationError('another operation is running on this backend', 'backend_busy');
  }
  return next;
}

/** Safety snapshot → stop → resize (boots) → healthy → record the size. Clears `resizing` either way. */
export async function runResize(row: BackendRow, next: BackendSize): Promise<void> {
  const externalId = row.externalId!;
  const stopHeartbeat = keepAlive(row.backendId);
  try {
    await createBackendSnapshot(row);
    await platinumJson(`/v1/sandboxes/${externalId}/stop`, { method: 'POST', body: '{}' });
    const deadline = Date.now() + STOP_WAIT_MS;
    while ((await platinumJson<PlatinumSandboxState>(`/v1/sandboxes/${externalId}`)).state !== 'stopped') {
      if (Date.now() > deadline) throw new Error('machine did not stop');
      await new Promise((r) => setTimeout(r, 500));
    }
    await platinumJson(`/v1/sandboxes/${externalId}/resize`, {
      method: 'POST',
      body: JSON.stringify({ cpu: next.cpu, ram_mb: next.memoryGb * 1024, disk_gb: next.diskGb }),
    });
    // The machine has the new size from here on, healthy or not.
    await db
      .update(projectBackends)
      .set({ cpu: next.cpu, memoryGb: next.memoryGb, diskGb: next.diskGb, updatedAt: new Date() })
      .where(and(eq(projectBackends.backendId, row.backendId), isNull(projectBackends.deletedAt)));
    // Close the window at the old size; the next probe opens one at the new size.
    await pauseComputeSession(row.backendId).catch((error) =>
      logger.warn('[backends] could not close the compute window after a resize', { backendId: row.backendId, error: String(error) }),
    );
    await waitHealthy(row.url!);
    await releaseOperation(row.backendId, null);
  } catch (error) {
    logger.error('[backends] resize failed', { backendId: row.backendId, error: String(error) });
    // Never leave the backend down: boot it again at whatever size it has.
    const state = await platinumJson<PlatinumSandboxState>(`/v1/sandboxes/${externalId}`).catch(() => null);
    if (state?.state === 'stopped') {
      await platinumJson(`/v1/sandboxes/${externalId}/start`, { method: 'POST', body: '{}' }).catch(() => {});
    }
    await releaseOperation(row.backendId, `resize failed: ${backendFailureMessage(error)}`).catch(() => {});
  } finally {
    stopHeartbeat();
  }
}

// ── Admin-key rotation ───────────────────────────────────────────────────────

/**
 * Writes a new Convex instance secret (fsynced temp file, then rename: the
 * guest disk has no journal, kortix-ai/platinum#1450) and stops Convex. The
 * supervisor starts it again 1 s later, on the new secret. The pattern matches
 * the Convex process only, never this script's own `bash -c` command line.
 */
export const ROTATE_INSTANCE_SECRET_SCRIPT = `set -e
d=/convex/data/credentials
p='^\\./convex-local-backend '
openssl rand -hex 32 > "$d/instance_secret.next"
sync "$d/instance_secret.next"
mv "$d/instance_secret.next" "$d/instance_secret"
sync "$d"
pkill -f "$p" || true
for i in $(seq 150); do
  pgrep -f "$p" > /dev/null || exit 0
  if [ "$i" = 100 ]; then pkill -9 -f "$p" || true; fi
  sleep 0.1
done
echo 'convex did not stop' >&2
exit 1`;

/**
 * Replaces the backend's admin key: every key handed out before stops working.
 * Convex derives admin keys from its instance secret, so the secret changes
 * and Convex restarts (under 1 s). Data, files and environment variables stay.
 * Also invalidated: upload URLs not yet used and open pagination cursors.
 */
export async function rotateBackendAdminKey(row: BackendRow): Promise<void> {
  const externalId = machine(row);
  if (!(await claimOperation(row.backendId, 'rotating_key'))) {
    throw new BackendOperationError('another operation is running on this backend', 'backend_busy');
  }
  const stopHeartbeat = keepAlive(row.backendId);
  try {
    await execInBackend(externalId, ROTATE_INSTANCE_SECRET_SCRIPT, 30_000);
    await waitHealthy(row.url!);
    await sealAdminKey(row);
    await releaseOperation(row.backendId, null);
  } catch (error) {
    logger.error('[backends] admin key rotation failed', { backendId: row.backendId, error: String(error) });
    // The secret may have changed already: Kortix must still hold a key the machine accepts.
    await recoverBackend(row).catch((recoverError) =>
      logger.error('[backends] recovery after a failed rotation failed', { backendId: row.backendId, error: String(recoverError) }),
    );
    await releaseOperation(row.backendId, `admin key rotation failed: ${backendFailureMessage(error)}`).catch(() => {});
    throw backendProviderFailureOr(error, 'The admin key could not be rotated. Try again.', 'rotation_failed');
  } finally {
    stopHeartbeat();
  }
}

function backendProviderFailureOr(error: unknown, message: string, code: string): BackendOperationError {
  if (error instanceof BackendOperationError) return error;
  return backendProviderFailure(error) ?? new BackendOperationError(message, code, 502);
}

// ── Logs ─────────────────────────────────────────────────────────────────────

export const MAX_LOG_LINES = 1_000;

/** The last `lines` lines of the Convex process log, across the current and the previous (capped) file, without color codes. */
export async function readBackendLog(row: BackendRow, lines: number): Promise<string> {
  const externalId = machine(row);
  const n = Math.max(1, Math.min(MAX_LOG_LINES, Math.floor(lines)));
  const out = await execInBackend(externalId, `cat ${CONVEX_LOG_FILE}.1 ${CONVEX_LOG_FILE} 2>/dev/null | tail -n ${n}`, 15_000);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI color escapes
  return out.replace(/\x1b\[[0-9;]*m/g, '');
}

// ── Recovery ─────────────────────────────────────────────────────────────────

/** Platinum states a `start` call boots from. */
const START_STATES = new Set(['stopped', 'archived', 'failed-start']);
/** A restore from backup copies the disk from object storage. */
const RECOVER_RUNNING_WAIT_MS = 10 * 60_000;

/** The machine as Platinum sees it, including a recoverable tombstone; null when it is gone. */
export async function readMachine(externalId: string): Promise<PlatinumSandboxState | null> {
  try {
    return await platinumJson<PlatinumSandboxState>(`/v1/sandboxes/${externalId}?include_deleted=true`, {
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (error instanceof PlatinumHttpError && error.status === 404) return null;
    throw error;
  }
}

export type RecoveryAction = 'started' | 'restored_from_backup' | 'none';

/**
 * Brings the backend back and makes the row match the machine: starts a
 * stopped machine; re-spawns a lost or system-tombstoned one from its last
 * automatic backup (same id and URLs; data since that backup is lost); waits
 * until Convex answers; seals the admin key the machine accepts now; records
 * the machine's real size. The caller holds the operation lock.
 */
export async function recoverBackend(row: BackendRow): Promise<RecoveryAction> {
  const externalId = row.externalId;
  if (!externalId || !row.url) throw new BackendOperationError('backend has no machine', 'backend_not_running');
  let current = await readMachine(externalId);
  if (!current) throw new BackendOperationError('The backend machine no longer exists.', 'backend_machine_missing');
  let action: RecoveryAction = 'none';
  if (current.recoverable || current.state === 'lost') {
    await platinumJson(`/v1/sandboxes/${externalId}/restore-from-backup`, { method: 'POST', body: '{}' });
    action = 'restored_from_backup';
  } else if (current.state && START_STATES.has(current.state)) {
    await platinumJson(`/v1/sandboxes/${externalId}/start`, { method: 'POST', body: '{}' });
    action = 'started';
  }
  const deadline = Date.now() + RECOVER_RUNNING_WAIT_MS;
  while (current?.state !== 'running' || current.recoverable) {
    if (Date.now() > deadline) throw new Error(`machine did not reach running (state ${current?.state ?? 'missing'})`);
    await new Promise((r) => setTimeout(r, 1_000));
    current = await readMachine(externalId);
  }
  await waitHealthy(row.url);
  await sealAdminKey(row);
  const size = {
    cpu: current.cpu,
    memoryGb: typeof current.ramMb === 'number' ? Math.round(current.ramMb / 1024) : undefined,
    diskGb: current.diskGb,
  };
  if (Object.values(size).every((v) => typeof v === 'number' && v > 0)) {
    await db
      .update(projectBackends)
      .set({ ...(size as BackendSize), updatedAt: new Date() })
      .where(and(eq(projectBackends.backendId, row.backendId), isNull(projectBackends.deletedAt)));
  }
  return action;
}
