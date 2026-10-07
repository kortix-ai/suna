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
 */

import { projectBackends } from '@kortix/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { platinumJson } from '../shared/platinum';
import { logger } from '../lib/logger';
import { BackendOperationError, backendFailureMessage } from './errors';
import { type BackendRow, type BackendSize, BACKEND_MACHINE_LIMITS, waitHealthy } from './provision';

export const MAX_SNAPSHOTS = 5;
const STOP_WAIT_MS = 60_000;

type PlatinumSandboxState = {
  state?: string;
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

/** A resize never takes this long; past it the API process that ran it died. */
export const OPERATION_STALE_MS = 10 * 60_000;

/** The operation in flight, from row metadata. A stale one counts as none. */
export function backendOperation(row: BackendRow, now = Date.now()): 'resizing' | null {
  const meta = row.metadata as { operation?: string; operationStartedAt?: string };
  if (meta.operation !== 'resizing') return null;
  const started = Date.parse(meta.operationStartedAt ?? '');
  return Number.isFinite(started) && now - started > OPERATION_STALE_MS ? null : 'resizing';
}

/**
 * Marks the backend busy in one conditional UPDATE, so two concurrent
 * requests cannot both start an operation. A stale marker is taken over.
 */
async function claimOperation(backendId: string): Promise<boolean> {
  const staleBefore = new Date(Date.now() - OPERATION_STALE_MS).toISOString();
  const claimed = await db
    .update(projectBackends)
    .set({
      updatedAt: new Date(),
      metadata: sql`coalesce(${projectBackends.metadata}, '{}'::jsonb) || ${JSON.stringify({ operation: 'resizing', operationStartedAt: new Date().toISOString() })}::jsonb`,
    })
    .where(
      and(
        eq(projectBackends.backendId, backendId),
        isNull(projectBackends.deletedAt),
        sql`(not (coalesce(${projectBackends.metadata}, '{}'::jsonb) ? 'operation') or (${projectBackends.metadata}->>'operationStartedAt') < ${staleBefore})`,
      ),
    )
    .returning({ id: projectBackends.backendId });
  return claimed.length === 1;
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
  if (!(await claimOperation(row.backendId))) {
    throw new BackendOperationError('a resize is already running', 'backend_busy');
  }
  return next;
}

/** Safety snapshot → stop → resize (boots) → healthy → record the size. Clears `resizing` either way. */
export async function runResize(row: BackendRow, next: BackendSize): Promise<void> {
  const externalId = row.externalId!;
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
    await waitHealthy(row.url!);
    await db
      .update(projectBackends)
      .set({
        updatedAt: new Date(),
        metadata: sql`(coalesce(${projectBackends.metadata}, '{}'::jsonb) - 'operation' - 'operationStartedAt' - 'lastOperationError')`,
      })
      .where(eq(projectBackends.backendId, row.backendId));
  } catch (error) {
    logger.error('[backends] resize failed', { backendId: row.backendId, error: String(error) });
    // Never leave the backend down: boot it again at whatever size it has.
    const state = await platinumJson<PlatinumSandboxState>(`/v1/sandboxes/${externalId}`).catch(() => null);
    if (state?.state === 'stopped') {
      await platinumJson(`/v1/sandboxes/${externalId}/start`, { method: 'POST', body: '{}' }).catch(() => {});
    }
    await db
      .update(projectBackends)
      .set({
        updatedAt: new Date(),
        metadata: sql`(coalesce(${projectBackends.metadata}, '{}'::jsonb) - 'operation' - 'operationStartedAt') || ${JSON.stringify({ lastOperationError: `resize failed: ${backendFailureMessage(error).slice(0, 500)}` })}::jsonb`,
      })
      .where(eq(projectBackends.backendId, row.backendId))
      .catch(() => {});
  }
}
