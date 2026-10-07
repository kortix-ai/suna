/**
 * Day-two operations on a running backend: resize, backups, snapshots, restore.
 * All of them are Platinum primitives on the backend's one machine.
 *
 * - Backup: Platinum copies the machine disk to S3 on its own (hourly), so a
 *   host loss restores onto a new host. Maintenance runs that restore
 *   (`recoverBackend`); a user cannot pick a backup.
 * - Snapshot: memory + disk of the running machine. Restore rolls the running
 *   machine back to it in place, so Convex and its SQLite come back mutually
 *   consistent (verified 2026-10-06: healthy 2 s after restore, data rolled back).
 *   Three kinds, recorded in `metadata.snapshotLabels` (Platinum has no label):
 *   `manual` (taken by a user, kept until deleted, at most MAX_MANUAL_SNAPSHOTS),
 *   `automatic` (daily, kept AUTOMATIC_SNAPSHOT_RETENTION_MS) and `resize`
 *   (taken before a resize, kept RESIZE_SNAPSHOT_RETENTION_MS; the next resize
 *   replaces it, so a backend holds at most one). A snapshot with no label is
 *   manual. Kortix deletes only an expired automatic or resize snapshot and a
 *   resize snapshot the next resize replaces; the API shows the expiry first.
 *   Expiry also runs for a parked backend, whose machine is stopped.
 * - Resize: stop → resize (which boots) → healthy. Verified 4 s of downtime,
 *   data intact. A snapshot is taken first. A memory snapshot restores the CPU,
 *   memory and disk image it was taken with (Platinum host agent `restoreVM`
 *   boots the snapshot's own config.json and rootfs), so a snapshot taken
 *   before an applied resize cannot be restored: 409 `snapshot_predates_resize`.
 *   The resize snapshot undoes a resize that failed before the size changed.
 * - Admin-key rotation: a new Convex instance secret, then a Convex restart
 *   (verified on CONVEX_BACKEND_IMAGE: under 1 s of downtime; the old key gets
 *   401 BadAdminKey; documents, files and environment variables are kept).
 * - Recovery: start a stopped machine, re-spawn a lost or system-tombstoned one
 *   from its last automatic backup. Maintenance runs it (./maintenance.ts).
 * - A restore (backup or snapshot) of a backend whose admin key was ever
 *   rotated rotates it again, so a key rotated away never works again. The
 *   restore sets `metadata.rotateAfterRestore` before it starts, and only the
 *   new rotation clears it: a restore that fails, or whose API process dies,
 *   is rotated again by the recovery or by the next health probe.
 * - Delete: `metadata.deleting` (a timestamp the delete refreshes) blocks every
 *   new operation, so no snapshot starts on a machine whose snapshots the
 *   delete already listed.
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
  deleteBackend,
  execInBackend,
  keepAlive,
  lastHeartbeat,
  sealAdminKey,
  waitHealthy,
} from './provision';

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

/** A provider 404: the machine or snapshot is gone already. */
const isGone = (error: unknown) => error instanceof PlatinumHttpError && error.status === 404;

export { BackendOperationError, backendFailureMessage, backendProviderFailure } from './errors';

function machine(row: BackendRow): string {
  if (row.status !== 'running' || !row.externalId || !row.url) {
    throw new BackendOperationError(`backend is ${row.status}`, 'backend_not_running');
  }
  return row.externalId;
}

export const BACKEND_OPERATIONS = ['resizing', 'rotating_key', 'recovering', 'snapshotting', 'restoring'] as const;
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
    .where(and(eq(projectBackends.backendId, backendId), isNull(projectBackends.deletedAt), operationFree(), notDeleting()))
    .returning({ id: projectBackends.backendId });
  return claimed.length === 1;
}

/** SQL: no delete runs. A delete marker the delete stopped refreshing (its API process died) no longer blocks. */
function notDeleting(now = Date.now()) {
  const meta = projectBackends.metadata;
  const staleBefore = new Date(now - OPERATION_STALE_MS).toISOString();
  return sql`(not (coalesce(${meta}, '{}'::jsonb) ? 'deleting') or (${meta}->>'deleting')::timestamptz < ${staleBefore}::timestamptz)`;
}

/**
 * Marks the backend `deleting` in one conditional UPDATE. No operation can be
 * claimed while the mark is fresh, so the daily snapshot job never starts a
 * snapshot after the delete listed the snapshots. Succeeds when no operation
 * runs, during `recovering` (a broken backend stays deletable), over a stale
 * marker and over an earlier delete. `force` (account deletion) marks the
 * backend whatever runs.
 */
async function claimDelete(backendId: string, force: boolean): Promise<boolean> {
  const meta = projectBackends.metadata;
  const claimed = await db
    .update(projectBackends)
    .set({
      updatedAt: new Date(),
      metadata: sql`coalesce(${meta}, '{}'::jsonb) || ${JSON.stringify({ deleting: new Date().toISOString() })}::jsonb`,
    })
    .where(
      and(
        eq(projectBackends.backendId, backendId),
        isNull(projectBackends.deletedAt),
        force ? undefined : sql`(${operationFree()} or ${meta}->>'operation' = 'recovering')`,
      ),
    )
    .returning({ id: projectBackends.backendId });
  return claimed.length === 1;
}

/**
 * Deletes the backend (machine, snapshots, compute window, row) under the
 * delete mark, refreshed while it runs. False, with nothing changed, when an
 * operation other than `recovering` runs; never with `force`. A failed delete
 * clears the mark, so the backend takes operations again, and throws.
 */
export async function deleteBackendExclusive(row: BackendRow, { force = false } = {}): Promise<boolean> {
  if (!(await claimDelete(row.backendId, force))) return false;
  const stopRefresh = keepAlive(row.backendId, 'deleting');
  try {
    await deleteBackend(row);
    return true;
  } catch (error) {
    await db
      .update(projectBackends)
      .set({ metadata: sql`coalesce(${projectBackends.metadata}, '{}'::jsonb) - 'deleting'` })
      .where(eq(projectBackends.backendId, row.backendId))
      .catch(() => {});
    throw error;
  } finally {
    stopRefresh();
  }
}

/**
 * Clears the marker. `error` becomes `last_operation_error`; success clears it.
 * `keepParked`: the operation never started or stopped the machine (the
 * snapshot job), so a parked backend stays parked.
 */
export async function releaseOperation(backendId: string, error: string | null, { keepParked = false } = {}): Promise<void> {
  const meta = projectBackends.metadata;
  const cleared = sql`coalesce(${meta}, '{}'::jsonb) - 'operation' - 'operationStartedAt' - 'heartbeatAt' - 'lastOperationError'`;
  await db
    .update(projectBackends)
    .set({
      updatedAt: new Date(),
      // An operation ends with the machine running, so `parked` goes too: the
      // backend of an archived project is parked again on the next tick.
      metadata: sql`(${keepParked ? cleared : sql`${cleared} - 'parked'`}) || ${JSON.stringify(error ? { lastOperationError: error.slice(0, 600) } : {})}::jsonb`,
    })
    .where(eq(projectBackends.backendId, backendId));
}

// ── Backups and snapshots ────────────────────────────────────────────────────

export const SNAPSHOT_KINDS = ['manual', 'automatic', 'resize'] as const;
export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number];

/** Manual snapshots a backend holds. At the cap a new one answers 409 `snapshot_limit`; nothing is dropped. */
export const MAX_MANUAL_SNAPSHOTS = 10;
const HOUR_MS = 3_600_000;
export const AUTOMATIC_SNAPSHOT_INTERVAL_MS = 24 * HOUR_MS;
export const AUTOMATIC_SNAPSHOT_RETENTION_MS = 7 * 24 * HOUR_MS;
export const RESIZE_SNAPSHOT_RETENTION_MS = 24 * HOUR_MS;
/** A failed automatic snapshot is tried again after this long. */
export const AUTOMATIC_SNAPSHOT_RETRY_MS = HOUR_MS;
/**
 * Platinum's POST /snapshot waits up to 180 s, then answers 202 and the row
 * appears when the host finishes (8 GiB machines take 80-90 s). Poll this long
 * after that before answering `snapshot_pending`.
 */
const SNAPSHOT_WAIT_MS = 5 * 60_000;
/** The budget of the snapshot POST itself: above Platinum's own 180 s wait, never the 20 s Platinum call default. */
export const SNAPSHOT_POST_TIMEOUT_MS = 200_000;
const RETENTION_MS: Record<Exclude<SnapshotKind, 'manual'>, number> = {
  automatic: AUTOMATIC_SNAPSHOT_RETENTION_MS,
  resize: RESIZE_SNAPSHOT_RETENTION_MS,
};

type SnapshotLabel = { kind: Exclude<SnapshotKind, 'manual'>; expiresAt: string };
type SnapshotMeta = {
  snapshotLabels?: Record<string, SnapshotLabel>;
  lastAutomaticSnapshotAt?: string;
  automaticSnapshotAttemptAt?: string;
  lastResizeAt?: string;
};

const snapshotMeta = (row: Pick<BackendRow, 'metadata'>) => (row.metadata ?? {}) as SnapshotMeta;

/** Kortix-made snapshots by id. A snapshot not listed here is manual. */
export function snapshotLabels(row: Pick<BackendRow, 'metadata'>): Record<string, SnapshotLabel> {
  const labels = snapshotMeta(row).snapshotLabels;
  return labels && typeof labels === 'object' ? labels : {};
}

export interface BackendSnapshotInfo {
  snapshot_id: string;
  created_at: string;
  size_bytes: number | null;
  kind: SnapshotKind;
  /** When Kortix deletes it; null for a manual snapshot, which stays until someone deletes it. */
  expires_at: string | null;
}

function describeSnapshot(row: Pick<BackendRow, 'metadata'>, snapshot: PlatinumSnapshot): BackendSnapshotInfo {
  const label = snapshotLabels(row)[snapshot.id];
  return {
    snapshot_id: snapshot.id,
    created_at: snapshot.createdAt,
    size_bytes: snapshot.sizeBytes ?? null,
    kind: label?.kind ?? 'manual',
    expires_at: label?.expiresAt ?? null,
  };
}

const newestFirst = (snapshots: PlatinumSnapshot[]) => [...snapshots].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

/** True when the daily automatic snapshot is due: 24 h since the last one (or since creation), 1 h since a failed try. */
export function automaticSnapshotDue(row: Pick<BackendRow, 'metadata' | 'createdAt'>, now = Date.now()): boolean {
  const meta = snapshotMeta(row);
  const last = Date.parse(meta.lastAutomaticSnapshotAt ?? '') || row.createdAt.getTime();
  const attempt = Date.parse(meta.automaticSnapshotAttemptAt ?? '') || 0;
  return now - last >= AUTOMATIC_SNAPSHOT_INTERVAL_MS && now - attempt >= AUTOMATIC_SNAPSHOT_RETRY_MS;
}

/**
 * Snapshots Kortix deletes now: an expired resize snapshot, and an expired
 * automatic one when a newer automatic snapshot exists. The newest automatic
 * snapshot stays past its expiry until the next one exists, so a backend that
 * cannot snapshot (parked, failing) never loses its last one. `listed` (the
 * ids Platinum lists): only a listed snapshot counts as the newer one. A
 * labelled snapshot the host has not finished may still fail.
 */
export function expiredSnapshotIds(row: Pick<BackendRow, 'metadata'>, now = Date.now(), listed?: ReadonlySet<string>): string[] {
  const labels = Object.entries(snapshotLabels(row));
  const newestAutomatic = labels
    .filter(([id, label]) => label.kind === 'automatic' && (!listed || listed.has(id)))
    .reduce((max, [, label]) => (label.expiresAt > max ? label.expiresAt : max), '');
  return labels
    .filter(([, label]) => Date.parse(label.expiresAt) <= now)
    .filter(([, label]) => label.kind === 'resize' || label.expiresAt < newestAutomatic)
    .map(([id]) => id);
}

async function labelSnapshot(backendId: string, snapshotId: string, kind: Exclude<SnapshotKind, 'manual'>): Promise<string> {
  const expiresAt = new Date(Date.now() + RETENTION_MS[kind]).toISOString();
  const meta = projectBackends.metadata;
  await db
    .update(projectBackends)
    .set({
      metadata: sql`jsonb_set(coalesce(${meta}, '{}'::jsonb), '{snapshotLabels}', coalesce(${meta}->'snapshotLabels', '{}'::jsonb) || ${JSON.stringify({ [snapshotId]: { kind, expiresAt } })}::jsonb)`,
    })
    .where(eq(projectBackends.backendId, backendId));
  return expiresAt;
}

async function unlabelSnapshot(backendId: string, snapshotId: string): Promise<void> {
  const meta = projectBackends.metadata;
  await db
    .update(projectBackends)
    .set({ metadata: sql`${meta} #- array['snapshotLabels', ${snapshotId}::text]` })
    .where(and(eq(projectBackends.backendId, backendId), sql`${meta} ? 'snapshotLabels'`));
}

async function mergeMetadata(backendId: string, patch: Record<string, unknown>): Promise<void> {
  await db
    .update(projectBackends)
    .set({ metadata: sql`coalesce(${projectBackends.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(projectBackends.backendId, backendId));
}

async function dropMetadata(backendId: string, key: string): Promise<void> {
  await db
    .update(projectBackends)
    .set({ metadata: sql`coalesce(${projectBackends.metadata}, '{}'::jsonb) - ${key}::text` })
    .where(eq(projectBackends.backendId, backendId));
}

async function readSnapshots(externalId: string): Promise<PlatinumSnapshot[]> {
  return platinumJson<PlatinumSnapshot[]>(`/v1/sandboxes/${externalId}/snapshots`);
}

export async function listBackendBackups(row: BackendRow) {
  const externalId = machine(row);
  const [sandbox, snapshots] = await Promise.all([
    platinumJson<PlatinumSandboxState>(`/v1/sandboxes/${externalId}`),
    readSnapshots(externalId),
  ]);
  return {
    automatic: {
      state: sandbox.backupState ?? null,
      last_backup_at: sandbox.lastBackupAt ?? null,
      size_bytes: sandbox.backupSizeBytes ?? null,
      interval_minutes: sandbox.backupIntervalMin ?? null,
    },
    snapshots: newestFirst(snapshots).map((s) => describeSnapshot(row, s)),
    snapshot_limit: MAX_MANUAL_SNAPSHOTS,
    snapshot_schedule: {
      automatic_interval_hours: AUTOMATIC_SNAPSHOT_INTERVAL_MS / HOUR_MS,
      automatic_retention_days: AUTOMATIC_SNAPSHOT_RETENTION_MS / (24 * HOUR_MS),
      resize_retention_hours: RESIZE_SNAPSHOT_RETENTION_MS / HOUR_MS,
      last_automatic_at: snapshotMeta(row).lastAutomaticSnapshotAt ?? null,
    },
  };
}

/**
 * Takes one snapshot and waits until Platinum lists it (restorable). A
 * Kortix-made kind is labelled as soon as Platinum names the id, so even a
 * snapshot that completes after the wait carries its kind and expiry. A POST
 * that fails without a 4xx (a timeout, a 5xx, a reset) may still complete on
 * the host: the first snapshot Platinum lists that did not exist before the
 * call is this one, and it gets the label. The caller holds the operation lock,
 * so no other snapshot of this machine starts meanwhile.
 */
async function takeSnapshot(row: BackendRow, kind: SnapshotKind): Promise<BackendSnapshotInfo> {
  const externalId = machine(row);
  const before = new Set((await readSnapshots(externalId)).map((s) => s.id));
  let startedId: string | null = null;
  let postError: unknown = null;
  try {
    startedId = (
      await platinumJson<{ id: string }>(`/v1/sandboxes/${externalId}/snapshot`, {
        method: 'POST',
        body: '{}',
        signal: AbortSignal.timeout(SNAPSHOT_POST_TIMEOUT_MS),
      })
    ).id;
  } catch (error) {
    // A 4xx: Platinum refused, so no snapshot exists.
    if (error instanceof PlatinumHttpError && error.status < 500) throw error;
    postError = error;
    logger.warn('[backends] the snapshot request failed; waiting for the snapshot to appear', {
      backendId: row.backendId,
      kind,
      error: String(error),
    });
  }
  let expiresAt = startedId && kind !== 'manual' ? await labelSnapshot(row.backendId, startedId, kind) : null;
  const deadline = Date.now() + SNAPSHOT_WAIT_MS;
  for (;;) {
    const listed = await readSnapshots(externalId);
    const mine = startedId
      ? listed.find((s) => s.id === startedId)
      : [...listed].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).find((s) => !before.has(s.id));
    if (mine) {
      if (!startedId && kind !== 'manual') expiresAt = await labelSnapshot(row.backendId, mine.id, kind);
      return { snapshot_id: mine.id, created_at: mine.createdAt, size_bytes: mine.sizeBytes ?? null, kind, expires_at: expiresAt };
    }
    if (Date.now() > deadline) {
      if (postError) throw postError;
      throw new BackendOperationError('the snapshot did not complete in time; list backups to see it', 'snapshot_pending');
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/** Runs `work` under the operation lock with a heartbeat; 409 `backend_busy` when another operation runs. */
async function underLock<T>(row: BackendRow, kind: BackendOperationKind, work: () => Promise<T>): Promise<T> {
  machine(row);
  if (!(await claimOperation(row.backendId, kind))) {
    throw new BackendOperationError('another operation is running on this backend; wait for it to finish', 'backend_busy');
  }
  const stopHeartbeat = keepAlive(row.backendId);
  try {
    return await work();
  } finally {
    stopHeartbeat();
    await releaseOperation(row.backendId, null).catch((error) =>
      logger.warn('[backends] could not release the operation', { backendId: row.backendId, kind, error: String(error) }),
    );
  }
}

/** A manual snapshot. 409 `snapshot_limit` at MAX_MANUAL_SNAPSHOTS: delete one first. */
export async function createBackendSnapshot(row: BackendRow): Promise<BackendSnapshotInfo> {
  return underLock(row, 'snapshotting', async () => {
    const labels = snapshotLabels(row);
    const manual = (await readSnapshots(row.externalId!)).filter((s) => !labels[s.id]);
    if (manual.length >= MAX_MANUAL_SNAPSHOTS) {
      throw new BackendOperationError(
        `the backend holds ${MAX_MANUAL_SNAPSHOTS} manual snapshots; delete one first`,
        'snapshot_limit',
      );
    }
    return takeSnapshot(row, 'manual');
  });
}

/** Deletes one snapshot of the backend, whatever its kind. 404 `snapshot_not_found` when the backend has no such snapshot. */
export async function deleteBackendSnapshot(row: BackendRow, snapshotId: string): Promise<void> {
  await underLock(row, 'snapshotting', async () => {
    const externalId = row.externalId!;
    if (!(await readSnapshots(externalId)).some((s) => s.id === snapshotId)) {
      throw new BackendOperationError('no such snapshot on this backend', 'snapshot_not_found', 404);
    }
    await platinumJson(`/v1/sandboxes/${externalId}/snapshots/${snapshotId}`, { method: 'DELETE' }).catch((error) => {
      if (!isGone(error)) throw error;
    });
    await unlabelSnapshot(row.backendId, snapshotId);
  });
}

/**
 * The daily snapshot job for one backend (maintenance claimed `snapshotting`
 * for it): take the automatic snapshot when one is due (`takeAutomatic` is
 * false for a parked backend), then delete expired snapshots. The new snapshot first, so the one it replaces expires in the same
 * pass. Releases the lock; a failure lands in `last_operation_error`.
 */
export async function runSnapshotMaintenance(row: BackendRow, takeAutomatic: boolean): Promise<{ expired: number; taken: boolean }> {
  const stopHeartbeat = keepAlive(row.backendId);
  const externalId = row.externalId!;
  const result = { expired: 0, taken: false };
  const labels = { ...snapshotLabels(row) };
  const failures: string[] = [];
  const attempt = async (what: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      failures.push(`${what}: ${backendFailureMessage(error)}`);
      logger.error(`[backends] ${what} failed`, { backendId: row.backendId, error: String(error) });
    }
  };
  await attempt('the daily snapshot', async () => {
    if (!takeAutomatic) return;
    await mergeMetadata(row.backendId, { automaticSnapshotAttemptAt: new Date().toISOString() });
    const taken = await takeSnapshot(row, 'automatic');
    await mergeMetadata(row.backendId, { lastAutomaticSnapshotAt: taken.created_at });
    labels[taken.snapshot_id] = { kind: 'automatic', expiresAt: taken.expires_at! };
    result.taken = true;
  });
  await attempt('snapshot expiry', async () => {
    // A label whose snapshot Platinum never listed (the host failed it) or no
    // longer lists goes, so a phantom never counts as the newest automatic one.
    const listed = new Set((await readSnapshots(externalId)).map((s) => s.id));
    for (const [snapshotId, label] of Object.entries(labels)) {
      const labelledAt = Date.parse(label.expiresAt) - RETENTION_MS[label.kind];
      if (listed.has(snapshotId) || Date.now() - labelledAt < SNAPSHOT_WAIT_MS * 2) continue;
      await unlabelSnapshot(row.backendId, snapshotId);
      delete labels[snapshotId];
    }
    for (const snapshotId of expiredSnapshotIds({ metadata: { snapshotLabels: labels } }, Date.now(), listed)) {
      await platinumJson(`/v1/sandboxes/${externalId}/snapshots/${snapshotId}`, { method: 'DELETE' }).catch((deleteError) => {
        if (!isGone(deleteError)) throw deleteError;
      });
      await unlabelSnapshot(row.backendId, snapshotId);
      logger.info('[backends] expired snapshot deleted', { backendId: row.backendId, snapshotId, kind: labels[snapshotId]?.kind });
      result.expired += 1;
    }
  });
  stopHeartbeat();
  await releaseOperation(row.backendId, failures.length ? `The snapshot job failed (${failures.join('; ')}).` : null, {
    keepParked: true,
  });
  return result;
}

/** Platinum's restore answers `resuming` at once and the host restores later. A failed restore ends `stopped`. */
const RESTORE_RUNNING_WAIT_MS = 3 * 60_000;

async function waitRestored(externalId: string): Promise<void> {
  const deadline = Date.now() + RESTORE_RUNNING_WAIT_MS;
  for (;;) {
    const state = (await platinumJson<PlatinumSandboxState>(`/v1/sandboxes/${externalId}`)).state;
    if (state === 'running') return;
    if (state !== 'resuming' && state !== 'restoring') throw new Error(`the machine is ${state ?? 'unknown'} after the restore`);
    if (Date.now() > deadline) throw new Error('the restore did not finish in time');
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Rolls the running machine back to one of its snapshots. Answers once
 * Platinum reports the machine `running` again and Convex answers, so no write
 * after the answer is lost to a late restore.
 */
export async function restoreBackendSnapshot(row: BackendRow, snapshotId: string): Promise<void> {
  const externalId = machine(row);
  if (!(await claimOperation(row.backendId, 'restoring'))) {
    throw new BackendOperationError('another operation is running on this backend; wait for it to finish', 'backend_busy');
  }
  const stopHeartbeat = keepAlive(row.backendId);
  let failure: string | null = null;
  try {
    const snapshot = (await readSnapshots(externalId)).find((s) => s.id === snapshotId);
    if (!snapshot) throw new BackendOperationError('no such snapshot on this backend', 'snapshot_not_found', 400);
    const lastResizeAt = snapshotMeta(row).lastResizeAt;
    if (lastResizeAt && Date.parse(snapshot.createdAt) < Date.parse(lastResizeAt)) {
      throw new BackendOperationError(
        'this snapshot was taken before the backend was resized; restoring it would bring back the old machine size. Take a snapshot at the current size, or resize again.',
        'snapshot_predates_resize',
      );
    }
    // Set before the restore starts: whatever ends this request, the recovery
    // or the next probe rotates the restored secret away.
    if (wasRotated(row)) await mergeMetadata(row.backendId, { [ROTATE_AFTER_RESTORE]: true });
    await platinumJson(`/v1/sandboxes/${externalId}/restore`, {
      method: 'POST',
      body: JSON.stringify({ snapshot_id: snapshotId }),
    }).catch(async (error) => {
      // A 4xx: Platinum refused, the machine still runs its own secret.
      if (error instanceof PlatinumHttpError && error.status < 500) await dropMetadata(row.backendId, ROTATE_AFTER_RESTORE);
      throw error;
    });
    try {
      await waitRestored(externalId);
      await waitHealthy(row.url!);
      await rotateAgainAfterRestore(row, externalId);
      await sealAdminKey(row);
    } catch (error) {
      failure = `restore failed: ${backendFailureMessage(error)}`;
      logger.error('[backends] restore failed', { backendId: row.backendId, snapshotId, error: String(error) });
      // Platinum ends a failed restore `stopped`; start it, rotate the restored
      // secret away and seal the key it accepts.
      await recoverBackend(row, { restored: true }).catch((recoverError) =>
        logger.error('[backends] recovery after a failed restore failed', { backendId: row.backendId, error: String(recoverError) }),
      );
      throw new BackendOperationError(
        'the backend did not come back healthy after the restore; retry or restore again',
        'restore_unhealthy',
        502,
      );
    }
  } finally {
    stopHeartbeat();
    await releaseOperation(row.backendId, failure).catch(() => {});
  }
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

/**
 * Deletes every resize snapshot but `keep`: a backend holds at most one, so a
 * resize loop cannot fill the host disk. The newer one undoes the same resize
 * from a later state. A failed delete waits for expiry.
 */
async function dropOlderResizeSnapshots(row: BackendRow, keep: string): Promise<void> {
  for (const [snapshotId, label] of Object.entries(snapshotLabels(row))) {
    if (label.kind !== 'resize' || snapshotId === keep) continue;
    try {
      await platinumJson(`/v1/sandboxes/${row.externalId}/snapshots/${snapshotId}`, { method: 'DELETE' }).catch((error) => {
        if (!isGone(error)) throw error;
      });
      await unlabelSnapshot(row.backendId, snapshotId);
      logger.info('[backends] resize snapshot replaced by a newer one', { backendId: row.backendId, snapshotId, keep });
    } catch (error) {
      logger.warn('[backends] could not delete the previous resize snapshot; expiry deletes it', {
        backendId: row.backendId,
        snapshotId,
        error: String(error),
      });
    }
  }
}

/** Safety snapshot (replacing the previous one) → stop → resize (boots) → healthy → record the size. Clears `resizing` either way. */
export async function runResize(row: BackendRow, next: BackendSize): Promise<void> {
  const externalId = row.externalId!;
  const stopHeartbeat = keepAlive(row.backendId);
  try {
    const safety = await takeSnapshot(row, 'resize');
    await dropOlderResizeSnapshots(row, safety.snapshot_id);
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
    // The machine has the new size from here on, healthy or not. Every older
    // snapshot holds the old size: restore refuses it from now on.
    await db
      .update(projectBackends)
      .set({
        cpu: next.cpu,
        memoryGb: next.memoryGb,
        diskGb: next.diskGb,
        updatedAt: new Date(),
        metadata: sql`coalesce(${projectBackends.metadata}, '{}'::jsonb) || ${JSON.stringify({ lastResizeAt: new Date().toISOString() })}::jsonb`,
      })
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
 * A restored disk (automatic backup or snapshot) carries the instance secret
 * it was taken with. When the admin key was ever rotated, that can be the
 * secret of a key someone rotated away from because it leaked. Rotating again
 * makes sure the old key never comes back. It costs one more Convex restart
 * (under 1 s), and the admin key changes: read it again after a restore.
 */
async function rotateAgainAfterRestore(row: BackendRow, externalId: string): Promise<void> {
  if (!wasRotated(row)) return;
  logger.warn('[backends] restored a backend whose admin key was rotated; rotating again', { backendId: row.backendId });
  await execInBackend(externalId, ROTATE_INSTANCE_SECRET_SCRIPT, 30_000);
  await waitHealthy(row.url!);
  await markRotated(row.backendId);
  await dropMetadata(row.backendId, ROTATE_AFTER_RESTORE);
}

/** Set while a restore of a rotated backend has not been rotated again. Recovery and the health probe act on it. */
export const ROTATE_AFTER_RESTORE = 'rotateAfterRestore';

const wasRotated = (row: Pick<BackendRow, 'metadata'>) =>
  Boolean((row.metadata as { adminKeyRotatedAt?: string } | null)?.adminKeyRotatedAt);

/** True when a restore of this rotated backend still waits for its rotation. */
export const rotationPendingAfterRestore = (row: Pick<BackendRow, 'metadata'>) =>
  wasRotated(row) && Boolean((row.metadata as Record<string, unknown> | null)?.[ROTATE_AFTER_RESTORE]);

/** Records that the admin key was rotated. Rotation writes it before the secret changes, so no crash loses it. */
async function markRotated(backendId: string): Promise<void> {
  await db
    .update(projectBackends)
    .set({
      updatedAt: new Date(),
      metadata: sql`coalesce(${projectBackends.metadata}, '{}'::jsonb) || ${JSON.stringify({ adminKeyRotatedAt: new Date().toISOString() })}::jsonb`,
    })
    .where(eq(projectBackends.backendId, backendId));
}

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
    await markRotated(row.backendId);
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
 * until Convex answers; rotates a restored secret away (after a backup
 * restore, `restored`: a snapshot restore that failed or was interrupted, or a
 * pending `rotateAfterRestore`); seals the admin key the machine accepts now;
 * records the machine's real size. The caller holds the operation lock.
 */
export async function recoverBackend(row: BackendRow, { restored = false } = {}): Promise<RecoveryAction> {
  const externalId = row.externalId;
  if (!externalId || !row.url) throw new BackendOperationError('backend has no machine', 'backend_not_running');
  let current = await readMachine(externalId);
  if (!current) throw new BackendOperationError('The backend machine no longer exists.', 'backend_machine_missing');
  let action: RecoveryAction = 'none';
  if (current.recoverable || current.state === 'lost') {
    if (wasRotated(row)) await mergeMetadata(row.backendId, { [ROTATE_AFTER_RESTORE]: true });
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
  if (action === 'restored_from_backup' || restored || rotationPendingAfterRestore(row)) {
    await rotateAgainAfterRestore(row, externalId);
  }
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
