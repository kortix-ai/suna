import { eq, sql } from 'drizzle-orm';
import { sandboxes } from '@kortix/db';
import { db } from '../shared/db';
import { config } from '../config';
import type { UpdateStatus, UpdatePhase } from './types';
import { IDLE_STATUS } from './types';

const TERMINAL_PHASES = new Set<UpdatePhase>(['idle', 'complete', 'failed']);
const SELF_UPDATE_RECOVERY_PHASES = new Set<UpdatePhase>(['restarting', 'verifying']);

const UPDATE_PHASE_TIMEOUT_MS: Record<Exclude<UpdatePhase, 'idle' | 'complete' | 'failed'>, number> = {
  pulling: 30 * 60_000,
  patching: 10 * 60_000,
  backing_up: 30 * 60_000,
  stopping: 3 * 60_000,
  restarting: 3 * 60_000,
  verifying: 3 * 60_000,
};

export function coerceStaleUpdateStatus(status: UpdateStatus, now = Date.now()): UpdateStatus {
  if (TERMINAL_PHASES.has(status.phase)) return status;
  if (!status.updatedAt) return status;

  const updatedAtMs = Date.parse(status.updatedAt);
  if (Number.isNaN(updatedAtMs)) return status;

  const timeoutMs = UPDATE_PHASE_TIMEOUT_MS[status.phase as keyof typeof UPDATE_PHASE_TIMEOUT_MS];
  if (!timeoutMs || now - updatedAtMs <= timeoutMs) return status;

  const minutes = Math.round((now - updatedAtMs) / 60_000);
  return {
    ...status,
    phase: 'failed',
    progress: 0,
    error: status.error || `Update got stuck during ${status.phase}`,
    message: `Update failed: stuck in ${status.phase} for ${minutes} minute${minutes === 1 ? '' : 's'} with no progress update`,
    updatedAt: new Date(now).toISOString(),
  };
}

function normalizeVersion(version: string | null | undefined): string | null {
  if (!version) return null;
  return version.replace(/^v/, '').trim() || null;
}

export function reconcileRecoveredUpdateStatus(status: UpdateStatus): UpdateStatus {
  if (status.phase === 'backing_up' && status.cancelRequested === true) {
    return {
      ...status,
      phase: 'failed',
      progress: 0,
      error: 'Update cancelled before destructive changes started',
      message: 'Update cancelled before destructive changes started',
      updatedAt: new Date().toISOString(),
    };
  }

  if (!SELF_UPDATE_RECOVERY_PHASES.has(status.phase)) return status;

  const targetVersion = normalizeVersion(status.targetVersion);
  const runtimeVersion = normalizeVersion(process.env.SANDBOX_VERSION ?? null);
  const imageVersion = normalizeVersion(config.SANDBOX_IMAGE.split(':').pop() ?? null);
  const effectiveVersion = runtimeVersion ?? imageVersion;

  if (!targetVersion || !effectiveVersion || targetVersion !== effectiveVersion) {
    return status;
  }

  return {
    ...status,
    phase: 'complete',
    progress: 100,
    message: `Updated to v${targetVersion}`,
    currentVersion: targetVersion,
    error: null,
    updatedAt: new Date().toISOString(),
  };
}

export async function getUpdateStatus(sandboxId: string): Promise<UpdateStatus> {
  const [row] = await db
    .select({ metadata: sandboxes.metadata })
    .from(sandboxes)
    .where(eq(sandboxes.sandboxId, sandboxId))
    .limit(1);

  if (!row) return { ...IDLE_STATUS };
  const meta = (row.metadata as Record<string, unknown>) ?? {};
  const status = (meta.updateStatus as UpdateStatus) ?? { ...IDLE_STATUS };
  const recovered = reconcileRecoveredUpdateStatus(status);
  const coerced = coerceStaleUpdateStatus(recovered);
  if (coerced !== status) {
    await setUpdateStatus(sandboxId, coerced);
  }
  return coerced;
}

export async function setUpdateStatus(
  sandboxId: string,
  update: Partial<UpdateStatus>,
): Promise<void> {
  const patch = { updateStatus: { ...update, updatedAt: new Date().toISOString() } };
  await db
    .update(sandboxes)
    .set({
      metadata: sql`metadata || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(sandboxes.sandboxId, sandboxId));
}

export async function setPhase(
  sandboxId: string,
  phase: UpdatePhase,
  progress: number,
  message: string,
  extra?: Partial<UpdateStatus>,
): Promise<void> {
  await setUpdateStatus(sandboxId, { phase, progress, message, cancelRequested: false, ...extra });
}

export async function isUpdateCancellationRequested(sandboxId: string): Promise<boolean> {
  const status = await getUpdateStatus(sandboxId);
  return status.cancelRequested === true;
}

export async function requestUpdateCancellation(sandboxId: string): Promise<UpdateStatus> {
  const status = await getUpdateStatus(sandboxId);
  const cancelledMessage = 'Update cancelled before destructive changes started';
  const next: UpdateStatus = {
    ...status,
    phase: status.phase === 'backing_up' ? 'failed' : status.phase,
    progress: status.phase === 'backing_up' ? 0 : status.progress,
    error: status.phase === 'backing_up' ? cancelledMessage : status.error,
    cancelRequested: true,
    message: status.phase === 'backing_up'
      ? cancelledMessage
      : status.message,
    updatedAt: new Date().toISOString(),
  };
  await setUpdateStatus(sandboxId, next);
  return next;
}

export async function resetUpdateStatus(sandboxId: string): Promise<void> {
  await setUpdateStatus(sandboxId, { ...IDLE_STATUS });
}

export async function clearUpdateStatus(sandboxId: string, version: string): Promise<void> {
  await db
    .update(sandboxes)
    .set({
      metadata: sql`(metadata - 'updateStatus') || ${JSON.stringify({ version })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(sandboxes.sandboxId, sandboxId));
}
