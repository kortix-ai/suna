// Drive sync: the drives of a session that does not run on Platinum. A
// Platinum volume mounts only into a Platinum sandbox, so on any other
// provider the box's daemon copies each drive into the same path under
// /drives and keeps it in sync through the Kortix API (routes in
// projects/routes/session-drive-sync.ts). The box never holds a storage
// credential: every file call is authorized against the drives the session
// was given, as recorded on its sandbox row.

import type { RecordedDriveMount } from './service';

/** The box env var that turns the daemon's drive sync on. */
export const DRIVE_SYNC_ENV = 'KORTIX_DRIVE_SYNC';

/** The sandbox metadata key that marks a box whose drives are synced, not mounted. */
export const DRIVE_SYNC_METADATA_KEY = 'driveSync';

/**
 * Operator switch, off by default: KORTIX_DRIVES_SYNC=on lets a project with
 * drives boot its sessions on a provider other than Platinum, with the drives
 * synced in. Off, such a session refuses to boot (drives are Platinum only).
 */
export function driveSyncEnabled(): boolean {
  const raw = (process.env.KORTIX_DRIVES_SYNC ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes';
}

export function isDriveSyncBox(row: { provider: string; metadata: unknown } | null | undefined): boolean {
  if (!row || row.provider === 'platinum') return false;
  return (row.metadata as Record<string, unknown> | null | undefined)?.[DRIVE_SYNC_METADATA_KEY] === true;
}

/** True when `path` (drive-relative, absolute) is `dir` or inside it. */
export function pathWithin(path: string, dir: string | undefined): boolean {
  if (!dir || dir === '/') return true;
  const base = dir.endsWith('/') ? dir.slice(0, -1) : dir;
  return path === base || path.startsWith(`${base}/`);
}

/**
 * May the session read (or write) `path` of this drive? Only through a drive
 * it was given, only inside the folder that mount covers, and a write only
 * through a read-write mount.
 */
export function syncMountAllows(
  mounts: RecordedDriveMount[],
  driveId: string,
  path: string,
  need: 'read' | 'write',
): boolean {
  return mounts.some(
    (m) => m.driveId === driveId && pathWithin(path, m.subdir) && (need === 'read' || !m.readOnly),
  );
}

/**
 * The version token the box compares: "size:mtime" of the file, or "absent".
 * Storage's listing carries only size and mtime, so the box can only know this.
 */
export function syncVersionToken(stat: { size: number; mtime: number } | null): string {
  return stat ? `${Number(stat.size)}:${Number(stat.mtime)}` : 'absent';
}

const pathLocks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` alone for this drive path within this API process. Storage has no
 * conditional write, so a sync write checks the drive's current version and
 * writes under this lock: two sync writers to one path through one API
 * process can no longer both pass the check. Not covered: a write through
 * another API replica, the web app's file routes, or a Platinum session's
 * mount landing between the check and the write. Those race exactly as a
 * merge of two mounts does, and the drive's conflict scanner reports them.
 */
export async function withSyncPathLock<T>(driveId: string, path: string, fn: () => Promise<T>): Promise<T> {
  const key = `${driveId}\0${path}`;
  const prev = pathLocks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  pathLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (pathLocks.get(key) === tail) pathLocks.delete(key);
  }
}
