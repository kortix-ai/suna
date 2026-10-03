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
