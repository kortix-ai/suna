// Singleton drive workers (scheduler leader only):
//
// - the conflict scanner (see drives/conflicts.ts);
// - the volume deletion queue: `kortix.platinum_volume_deletions` holds every
//   volume whose owner row is gone (a drive, a session's state volume). A
//   trigger fills it on every delete path, cascades included; this drains it.
//   A volume still held by a sandbox answers 409 and is retried with backoff.

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
let draining = false;

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
        console.info(`[drives] deleted volume ${row.volumeName} (${row.reason})`);
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

export function startDriveWorkers(): void {
  if (!driveStorageAvailable()) return;
  if (!scanTimer) {
    scanTimer = setInterval(() => {
      runWorkerTick('drive-conflict-scan', runConflictScan).catch((err) =>
        console.warn('[drives] conflict scan pass failed:', err),
      );
    }, SCAN_MS);
  }
  if (!drainTimer) {
    drainTimer = setInterval(() => {
      runWorkerTick('volume-deletions', () => drainVolumeDeletions()).catch((err) =>
        console.warn('[drives] volume deletion pass failed:', err),
      );
    }, DRAIN_MS);
  }
}

export function stopDriveWorkers(): void {
  if (scanTimer) clearInterval(scanTimer);
  if (drainTimer) clearInterval(drainTimer);
  scanTimer = null;
  drainTimer = null;
}
