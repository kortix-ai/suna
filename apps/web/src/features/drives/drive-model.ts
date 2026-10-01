/**
 * Kortix Drive view model: the shapes the web app reads from the drives API,
 * plus the small pure helpers the page and the composer chip share.
 *
 * The SDK owns the wire types. These mirror the v1 contract so the view code
 * is typed against what it renders, and the normalizers below absorb the two
 * shapes a list call can come back in (a bare array or the `{ drives }`
 * envelope the route returns).
 */

export type DriveKind = 'personal' | 'agent' | 'company';
export type DriveAccess = 'read' | 'write';

export interface DriveRecord {
  driveId: string;
  accountId: string;
  kind: DriveKind;
  name: string;
  ownerUserId: string | null;
  projectId: string | null;
  agentName: string | null;
  isDefault: boolean;
  sizeBytes?: number | null;
  fileCount?: number | null;
  lastChangeAt?: string | null;
  createdAt: string;
  updatedAt: string;
  mountPath?: string | null;
  sizeLimitBytes?: number | null;
  /** What the viewer may do: `read`, `write` (files) or `manage` (also rename, delete, grant). */
  access?: 'read' | 'write' | 'manage';
  /** A personal drive someone else owns and shared with the viewer. */
  shared?: boolean;
  ownerEmail?: string | null;
  /** Conflict copies nobody resolved or dismissed yet. */
  openConflicts?: number;
  /** Listed with a project: this project's grant on a company drive, else null. */
  projectAccess?: DriveAccess | null;
  /** Listed with a project: a company drive's grants to this project's agents. */
  agentGrants?: Array<{ agentName: string; access: DriveAccess }>;
}

export interface DriveEntry {
  path: string;
  name: string;
  type: 'file' | 'dir' | 'symlink';
  size?: number | null;
  mtime?: string | number | null;
}

export interface DriveVersion {
  id: string;
  createdAt: string;
  /** created | edit | sync | restore */
  kind?: string | null;
  /** Where the change came from: drive (this page), session, system. */
  author?: string | null;
  changes?: { changed?: number; deleted?: number } | null;
}

export interface SessionDriveMount {
  driveId: string;
  name: string;
  kind: DriveKind;
  mountPath: string;
  readOnly: boolean;
  subdir?: string;
  /** The writable "From agents" folder of the session owner's drive. */
  fromAgents?: boolean;
  /** `me`: the session owner's own drive; `agent`: the session agent's drive. */
  role?: 'me' | 'agent' | 'drive';
  openConflicts?: number;
  ownerEmail?: string;
}

/** One drive in a session, its mounts folded together (your drive + its From agents folder). */
export interface SessionDriveRow {
  driveId: string;
  name: string;
  kind: DriveKind;
  role: 'me' | 'agent' | 'drive';
  mountPath: string;
  readOnly: boolean;
  /** Your drive is read-only and agents write its From agents folder. */
  fromAgentsPath: string | null;
  openConflicts: number;
  ownerEmail?: string;
}

export function foldSessionDrives(mounts: SessionDriveMount[]): SessionDriveRow[] {
  const rows: SessionDriveRow[] = [];
  for (const mount of mounts) {
    if (mount.fromAgents) continue;
    rows.push({
      driveId: mount.driveId,
      name: mount.name,
      kind: mount.kind,
      role: mount.role ?? (mount.kind === 'agent' ? 'agent' : 'drive'),
      mountPath: mount.mountPath,
      readOnly: mount.readOnly,
      fromAgentsPath:
        mounts.find((m) => m.fromAgents && m.driveId === mount.driveId)?.mountPath ?? null,
      openConflicts: mount.openConflicts ?? 0,
      ...(mount.ownerEmail ? { ownerEmail: mount.ownerEmail } : {}),
    });
  }
  const rank = (role: SessionDriveRow['role']) => (role === 'me' ? 0 : role === 'agent' ? 1 : 2);
  return rows.sort((a, b) => rank(a.role) - rank(b.role));
}

export interface DriveGrantRecord {
  grantId: string;
  type: 'project' | 'user' | 'agent';
  projectId: string | null;
  projectName: string | null;
  userId: string | null;
  userEmail: string | null;
  agentName: string | null;
  access: DriveAccess;
  createdAt: string;
}

export interface DriveConflictRecord {
  conflictId: string;
  path: string;
  originalPath: string;
  detectedAt: string;
}

export function listOf<T>(
  value: T[] | { [key: string]: T[] } | null | undefined,
  key: string,
): T[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  const inner = (value as Record<string, T[] | undefined>)[key];
  return Array.isArray(inner) ? inner : [];
}

/** Largest single upload the drive accepts. Mirrors the API's body cap. */
export const DRIVE_UPLOAD_LIMIT_BYTES = 64 * 1024 * 1024;

export function joinDrivePath(dir: string, name: string): string {
  const base = dir === '/' || dir === '' ? '' : dir.replace(/\/+$/, '');
  return `${base}/${name.replace(/^\/+/, '')}`;
}

export function parentDrivePath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const at = trimmed.lastIndexOf('/');
  return at <= 0 ? '/' : trimmed.slice(0, at);
}

export function driveCrumbs(path: string): { name: string; path: string }[] {
  const parts = path.split('/').filter(Boolean);
  return parts.map((name, index) => ({ name, path: `/${parts.slice(0, index + 1).join('/')}` }));
}

/** A file or folder name the drive can hold: non-empty, one segment. */
export function isValidEntryName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed !== '.' && trimmed !== '..' && !trimmed.includes('/');
}

export function sortEntries(entries: DriveEntry[]): DriveEntry[] {
  return [...entries].sort((a, b) => {
    const aDir = a.type === 'dir' ? 0 : 1;
    const bDir = b.type === 'dir' ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

export function entryDate(mtime: DriveEntry['mtime']): Date | null {
  if (mtime === null || mtime === undefined || mtime === '' || mtime === 0) return null;
  // Epoch seconds and epoch milliseconds both occur in file listings.
  const date =
    typeof mtime === 'number' ? new Date(mtime < 1e12 ? mtime * 1000 : mtime) : new Date(mtime);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function canManageDrive(drive: DriveRecord): boolean {
  return drive.access === 'manage';
}

export function canWriteDrive(drive: DriveRecord): boolean {
  return drive.access === 'manage' || drive.access === 'write';
}

export function projectAccessOf(drive: DriveRecord): DriveAccess | null {
  return drive.kind === 'company' ? (drive.projectAccess ?? null) : null;
}

export function groupDrives(drives: DriveRecord[]) {
  const byName = (a: DriveRecord, b: DriveRecord) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  };
  return {
    personal: drives.filter((drive) => drive.kind === 'personal' && !drive.shared).sort(byName),
    shared: drives.filter((drive) => drive.kind === 'personal' && drive.shared).sort(byName),
    company: drives.filter((drive) => drive.kind === 'company').sort(byName),
    agent: drives.filter((drive) => drive.kind === 'agent').sort(byName),
  };
}

/** Calendar-day bucket key in the viewer's local time. */
export function dayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function groupVersionsByDay(
  versions: DriveVersion[],
): { day: string; versions: DriveVersion[] }[] {
  const sorted = [...versions].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const groups: { day: string; versions: DriveVersion[] }[] = [];
  for (const version of sorted) {
    const day = dayKey(version.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.versions.push(version);
    else groups.push({ day, versions: [version] });
  }
  return groups;
}

export function formatBytes(bytes: number | null | undefined, locale: string): string {
  const value = typeof bytes === 'number' && Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;
  let index = 0;
  let scaled = value;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: units[index],
    unitDisplay: index === 0 ? 'long' : 'short',
    maximumFractionDigits: index === 0 || scaled >= 10 ? 0 : 1,
  }).format(scaled);
}
