// Conflict copies on drives. When two writers change one file of a drive at
// once, storage keeps both: the other version lands beside the original as
// "<name> (conflict <date> <time>)<ext>". Storage reports only some of these
// (a merge's side commit); copies made inside a sandbox arrive as plain new
// files. So the scanner reads the drive itself: whenever a drive's head moved,
// it lists the drive and records every conflict copy it finds, and closes the
// record once the copy is gone.

import { driveConflicts, drives, sessionSandboxes } from '@kortix/db';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { conflictOriginal } from './access';
import { DRIVE_MOUNTS_METADATA_KEY, type DriveRow, recordedDriveMounts, refreshDriveNotes } from './service';
import { getDriveVolume, isMissingVolume, listVolumeFiles } from './volumes';

/** Drives written through the API lately: scanned even when no session mounts them. */
const recentWrites = new Map<string, number>();
const RECENT_MS = 15 * 60_000;

export function noteDriveWrite(driveId: string): void {
  recentWrites.set(driveId, Date.now());
  if (recentWrites.size > 5_000) {
    const cutoff = Date.now() - RECENT_MS;
    for (const [id, at] of recentWrites) if (at < cutoff) recentWrites.delete(id);
  }
}

/** Drives worth a scan now: mounted by a running session, or written through the API lately. */
async function activeDriveIds(): Promise<string[]> {
  const ids = new Set<string>();
  const cutoff = Date.now() - RECENT_MS;
  for (const [id, at] of recentWrites) {
    if (at >= cutoff) ids.add(id);
    else recentWrites.delete(id);
  }
  const rows = await db
    .select({ metadata: sessionSandboxes.metadata })
    .from(sessionSandboxes)
    .where(and(eq(sessionSandboxes.status, 'active'), sql`${sessionSandboxes.metadata} ? ${DRIVE_MOUNTS_METADATA_KEY}`));
  for (const r of rows) for (const m of recordedDriveMounts(r.metadata)) ids.add(m.driveId);
  return [...ids];
}

/**
 * Scan one drive when its head moved since the last scan. Returns the
 * conflict copies it found for the first time.
 */
export async function scanDriveConflicts(drive: DriveRow): Promise<string[]> {
  if (!drive.platinumVolumeId) return [];
  let head: string | null;
  try {
    head = (await getDriveVolume(drive.platinumVolumeName, AbortSignal.timeout(5_000))).head_commit_id ?? null;
  } catch (err) {
    if (isMissingVolume(err)) return [];
    throw err;
  }
  if (head && head === drive.conflictScanHead) return [];
  const entries = await listVolumeFiles(drive.platinumVolumeName, '/', true, AbortSignal.timeout(30_000));
  const found = new Map<string, string>();
  for (const e of entries) {
    const original = conflictOriginal(e.path);
    if (original) found.set(e.path, original);
  }
  const open = await db
    .select({ path: driveConflicts.path, resolvedAt: driveConflicts.resolvedAt })
    .from(driveConflicts)
    .where(eq(driveConflicts.driveId, drive.driveId));
  const known = new Map(open.map((r) => [r.path, r.resolvedAt]));
  const fresh = [...found.keys()].filter((p) => !known.has(p) || known.get(p) !== null);
  const now = new Date();
  for (const path of fresh) {
    // New, or back after it was resolved: a new conflict, so a dismissal of the old one no longer applies.
    await db
      .insert(driveConflicts)
      .values({ driveId: drive.driveId, path, originalPath: found.get(path)! })
      .onConflictDoUpdate({
        target: [driveConflicts.driveId, driveConflicts.path],
        set: { resolvedAt: null, dismissedAt: null, dismissedBy: null, detectedAt: now, originalPath: found.get(path)! },
      });
  }
  const gone = [...known.entries()].filter(([path, resolvedAt]) => resolvedAt === null && !found.has(path)).map(([p]) => p);
  if (gone.length) {
    await db
      .update(driveConflicts)
      .set({ resolvedAt: now })
      .where(and(eq(driveConflicts.driveId, drive.driveId), inArray(driveConflicts.path, gone), isNull(driveConflicts.resolvedAt)));
  }
  await db.update(drives).set({ conflictScanHead: head }).where(eq(drives.driveId, drive.driveId));
  return fresh;
}

/** Sessions whose running sandbox mounts one of these drives. */
async function sessionsMounting(driveIds: string[]): Promise<string[]> {
  if (!driveIds.length) return [];
  const rows = await db
    .select({ sessionId: sessionSandboxes.sessionId, metadata: sessionSandboxes.metadata })
    .from(sessionSandboxes)
    .where(and(eq(sessionSandboxes.status, 'active'), isNotNull(sessionSandboxes.externalId)));
  const wanted = new Set(driveIds);
  return rows.filter((r) => recordedDriveMounts(r.metadata).some((m) => wanted.has(m.driveId))).map((r) => r.sessionId);
}

let scanning = false;

/** One pass over the active drives; new conflicts update the notes file of every session that mounts the drive. */
export async function runConflictScan(): Promise<void> {
  if (scanning) return;
  scanning = true;
  try {
    const ids = await activeDriveIds();
    if (!ids.length) return;
    const rows = await db.select().from(drives).where(inArray(drives.driveId, ids));
    const changed: string[] = [];
    let i = 0;
    const worker = async () => {
      while (i < rows.length) {
        const drive = rows[i++]!;
        try {
          const fresh = await scanDriveConflicts(drive);
          if (fresh.length) {
            changed.push(drive.driveId);
            console.info(`[drives] ${fresh.length} new conflict copy(ies) on drive ${drive.driveId}`);
          }
        } catch (err) {
          console.warn(`[drives] conflict scan of ${drive.driveId} failed:`, err instanceof Error ? err.message : err);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));
    for (const sessionId of await sessionsMounting(changed)) void refreshDriveNotes(sessionId);
  } finally {
    scanning = false;
  }
}
