// Singleton drive workers (scheduler leader only):
//
// - the conflict scanner (see drives/conflicts.ts);
// - the volume deletion queue: `kortix.platinum_volume_deletions` holds every
//   volume whose owner row is gone (a drive, a session's state volume). A
//   trigger fills it on every delete path, cascades included; this drains it.
//   A volume still held by a sandbox answers 409 and is retried with backoff.
// - the revocation retry: a session sandbox whose folder access narrowed but
//   whose detach did not land is brought in line again until it does.

import { logger } from '../lib/logger';
import { platinumVolumeDeletions } from '@kortix/db';
import { asc, eq, lte, sql } from 'drizzle-orm';
import { runWorkerTick } from '../shared/audit-scope';
import { db } from '../shared/db';
import { configuredTimeoutMs } from '../shared/with-timeout';
import { runConflictScan } from '../drives/conflicts';
import { DriveStorageError, deleteDriveVolume, driveStorageAvailable } from '../drives/volumes';

const SCAN_MS = configuredTimeoutMs('KORTIX_DRIVE_CONFLICT_SCAN_MS', 15_000, 2_000);
const DRAIN_MS = configuredTimeoutMs('KORTIX_VOLUME_DELETE_DRAIN_MS', 30_000, 5_000);
const MAX_BACKOFF_MS = 60 * 60_000;

let scanTimer: ReturnType<typeof setInterval> | null = null;
let drainTimer: ReturnType<typeof setInterval> | null = null;
let revocationTimer: ReturnType<typeof setInterval> | null = null;
let draining = false;
let retryingRevocations = false;

/** How often a revocation whose detach did not land is tried again (each row backs off on its own). */
const REVOCATION_TICK_MS = 15_000;

/** Queue a volume for deletion (idempotent). `delayMs` lets a box that still holds it go first. */
export async function queueVolumeDeletion(volumeName: string, reason: string, delayMs = 0): Promise<void> {
  await db
    .insert(platinumVolumeDeletions)
    .values({ volumeName, reason, notBefore: new Date(Date.now() + delayMs) })
    .onConflictDoNothing();
}

export async function drainVolumeDeletions(limit = 20): Promise<{ deleted: number; deferred: number }> {
  if (draining || !driveStorageAvailable()) return { deleted: 0, deferred: 0 };
  draining = true;
  let deleted = 0;
  let deferred = 0;
  try {
    const due = await db
      .select()
      .from(platinumVolumeDeletions)
      .where(lte(platinumVolumeDeletions.notBefore, new Date()))
      .orderBy(asc(platinumVolumeDeletions.notBefore))
      .limit(limit);
    for (const row of due) {
      try {
        await deleteDriveVolume(row.volumeName);
        await db.delete(platinumVolumeDeletions).where(eq(platinumVolumeDeletions.volumeName, row.volumeName));
        deleted++;
        logger.info(`[drives] deleted volume ${row.volumeName} (${row.reason})`);
      } catch (err) {
        deferred++;
        const backoff = Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** Math.min(row.attempts, 10));
        const message = err instanceof DriveStorageError ? `${err.status} ${err.code ?? ''} ${err.message}` : String(err);
        await db
          .update(platinumVolumeDeletions)
          .set({
            attempts: sql`${platinumVolumeDeletions.attempts} + 1`,
            lastError: message.slice(0, 500),
            notBefore: new Date(Date.now() + backoff),
          })
          .where(eq(platinumVolumeDeletions.volumeName, row.volumeName));
      }
    }
  } finally {
    draining = false;
  }
  return { deleted, deferred };
}

/** One pass over the revocations whose mounts are not in line yet (see drives/service.ts). */
export async function retryPendingRevocations(): Promise<void> {
  if (retryingRevocations) return;
  retryingRevocations = true;
  try {
    const { retryMountRevocations } = await import('../drives/service');
    const { retried, failed } = await retryMountRevocations();
    if (retried) logger.info(`[drives] revocation retry: ${retried} sandbox(es), ${failed} still pending`);
  } finally {
    retryingRevocations = false;
  }
}

export function startDriveWorkers(): void {
  if (!driveStorageAvailable()) return;
  if (!scanTimer) {
    scanTimer = setInterval(() => {
      runWorkerTick('drive-conflict-scan', runConflictScan).catch((err) =>
        logger.warn('[drives] conflict scan pass failed:', { error: err instanceof Error ? err.message : String(err) }),
      );
    }, SCAN_MS);
  }
  if (!drainTimer) {
    drainTimer = setInterval(() => {
      runWorkerTick('volume-deletions', () => drainVolumeDeletions()).catch((err) =>
        logger.warn('[drives] volume deletion pass failed:', { error: err instanceof Error ? err.message : String(err) }),
      );
    }, DRAIN_MS);
  }
  if (!revocationTimer) {
    revocationTimer = setInterval(() => {
      runWorkerTick('drive-mount-revocations', retryPendingRevocations).catch((err) =>
        logger.warn('[drives] revocation retry pass failed:', { error: err instanceof Error ? err.message : String(err) }),
      );
    }, REVOCATION_TICK_MS);
  }
}

export function stopDriveWorkers(): void {
  if (scanTimer) clearInterval(scanTimer);
  if (drainTimer) clearInterval(drainTimer);
  if (revocationTimer) clearInterval(revocationTimer);
  scanTimer = null;
  drainTimer = null;
  revocationTimer = null;
}
