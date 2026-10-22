// Conflict copies on drives. When two writers change one file of a drive at
// once, storage keeps both: the other version lands beside the original as
// "<name> (conflict <date> <time>)<ext>". Storage reports only some of these
// (a merge's side commit); copies made inside a sandbox arrive as plain new
// files. So the scanner reads the drive itself: whenever a drive's head moved,
// it lists the drive and records every conflict copy it finds, and closes the
// record once the copy is gone.

import { logger } from '../lib/logger';
import { driveConflicts, drives, sessionSandboxes } from '@kortix/db';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { conflictOriginal } from './access';
import { DRIVE_MOUNTS_METADATA_KEY, type DriveRow, recordedDriveMounts, refreshDriveNotes } from './service';
import { getDriveVolume, isMissingVolume, listVolumeFiles, readVolumeFile } from './volumes';

/** Drives written through the API lately: scanned even when no session mounts them. */
// replica-local: a hint for the scanner on this replica. The scanner also
// scans every drive a session mounts, so only conflicts made by API writes
// alone through another replica wait for a write or a mount seen here.
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
  const candidates = [...found.keys()].filter((p) => !known.has(p) || known.get(p) !== null);
  const now = new Date();
  const sizes = new Map(entries.map((e) => [e.path, Number(e.size ?? -1)]));
  const fresh: string[] = [];
  for (const path of candidates) {
    // A copy byte-for-byte equal to the version kept at the path loses
    // nothing: storage can leave several for one race. Record it closed so
    // nobody is asked to resolve a duplicate.
    const redundant = await sameBytes(drive.platinumVolumeName, path, found.get(path)!, sizes).catch(() => false);
    if (!redundant) fresh.push(path);
    // New, or back after it was resolved: a new conflict, so a dismissal of the old one no longer applies.
    await db
      .insert(driveConflicts)
      .values({ driveId: drive.driveId, path, originalPath: found.get(path)!, resolvedAt: redundant ? now : null })
      .onConflictDoUpdate({
        target: [driveConflicts.driveId, driveConflicts.path],
        set: {
          resolvedAt: redundant ? now : null,
          dismissedAt: null,
          dismissedBy: null,
          detectedAt: now,
          originalPath: found.get(path)!,
        },
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

const SAME_BYTES_LIMIT = 4 * 1024 * 1024;

/** Whether a conflict copy holds exactly the bytes of the file it was made from (small files only). */
async function sameBytes(volume: string, copy: string, original: string, sizes: Map<string, number>): Promise<boolean> {
  const a = sizes.get(copy);
  const b = sizes.get(original);
  if (a === undefined || b === undefined || a !== b || a < 0 || a > SAME_BYTES_LIMIT) return false;
  const [x, y] = await Promise.all([readVolumeFile(volume, copy), readVolumeFile(volume, original)]);
  const [bx, by] = await Promise.all([x.arrayBuffer(), y.arrayBuffer()]);
  return Buffer.from(bx).equals(Buffer.from(by));
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
            logger.info(`[drives] ${fresh.length} new conflict copy(ies) on drive ${drive.driveId}`);
          }
        } catch (err) {
          logger.warn(`[drives] conflict scan of ${drive.driveId} failed:`, { error: err instanceof Error ? err.message : String(err) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));
    for (const sessionId of await sessionsMounting(changed)) void refreshDriveNotes(sessionId);
  } finally {
    scanning = false;
  }
}
