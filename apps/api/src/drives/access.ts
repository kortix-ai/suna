// Who may do what with a drive, and where a session sees each drive. Pure, so
// the rules are tested without a database.

export type DriveKind = 'personal' | 'agent' | 'company';
export type AccountRole = 'owner' | 'admin' | 'member';

/** `none` < `read` < `write` (read and change files) < `manage` (rename, delete, grant). */
export type DriveAccess = 'none' | 'read' | 'write' | 'manage';

const RANK: Record<DriveAccess, number> = { none: 0, read: 1, write: 2, manage: 3 };

export function accessAtLeast(have: DriveAccess, need: DriveAccess): boolean {
  return RANK[have] >= RANK[need];
}

export interface DriveOwnership {
  kind: string;
  ownerUserId: string | null;
}

/**
 * `accountRole` is the caller's role in the DRIVE's account, or null when the
 * caller is not a member of it. A personal drive is its owner's alone unless
 * the owner shared it with the caller (`sharedAccess`, from a `user` grant):
 * an account admin gets no access to a colleague's personal drive.
 */
export function driveAccess(
  drive: DriveOwnership,
  caller: { userId: string; accountRole: AccountRole | null; sharedAccess?: 'read' | 'write' | null },
): DriveAccess {
  if (!caller.accountRole) return 'none';
  if (drive.kind === 'personal') {
    if (drive.ownerUserId === caller.userId) return 'manage';
    return caller.sharedAccess ?? 'none';
  }
  if (drive.kind === 'agent' || drive.kind === 'company') {
    return caller.accountRole === 'owner' || caller.accountRole === 'admin' ? 'manage' : 'write';
  }
  return 'none';
}

export const PERSONAL_MOUNT_PATH = '/drives/me';
/** The writable "From agents" folder of the personal drive, mounted beside it. */
export const FROM_AGENTS_MOUNT_PATH = '/drives/from-agents';
/** The folder of the personal drive that agents write by default. */
export const FROM_AGENTS_FOLDER = '/From agents';
export const AGENT_MOUNT_PATH = '/drives/agent';
/** A sandbox takes at most 8 volume mounts (Platinum's per-sandbox cap). */
export const MAX_SESSION_DRIVES = 8;

const RESERVED_SLUGS = new Set(['me', 'agent', 'from-agents']);

export function driveSlug(name: string, driveId: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || `drive-${driveId.replace(/-/g, '').slice(0, 8)}`;
}

/**
 * Where a drive appears in a session, ignoring collisions with other drives.
 * `me` is the session owner's own default drive, `agent` the session agent's
 * drive; every other drive mounts under its name.
 */
export function driveMountPath(drive: { name: string; driveId: string }, role: MountRole = 'drive'): string {
  if (role === 'me') return PERSONAL_MOUNT_PATH;
  if (role === 'agent') return AGENT_MOUNT_PATH;
  const slug = driveSlug(drive.name, drive.driveId);
  return `/drives/${RESERVED_SLUGS.has(slug) ? `${slug}-drive` : slug}`;
}

export type MountRole = 'me' | 'agent' | 'drive';

export interface MountCandidate<D> {
  drive: D;
  readOnly: boolean;
  role: MountRole;
}

export interface PlannedMount<D> extends MountCandidate<D> {
  mountPath: string;
  /** Mount only this folder of the drive (the "From agents" mount). */
  subdir?: string;
  /** This entry is the writable "From agents" folder of the `me` drive. */
  fromAgents?: boolean;
}

/**
 * Mount paths for one session: the owner's drive (and, when it is read-only,
 * its writable "From agents" folder beside it), the agent drive, then every
 * other drive in the given order, each drive once (the most permissive
 * candidate wins), each at a distinct path, capped at {@link MAX_SESSION_DRIVES}.
 */
export function planDriveMounts<D extends { name: string; driveId: string }>(
  candidates: MountCandidate<D>[],
): PlannedMount<D>[] {
  const rank = (r: MountRole) => (r === 'me' ? 0 : r === 'agent' ? 1 : 2);
  const byDrive = new Map<string, MountCandidate<D>>();
  for (const c of candidates) {
    const seen = byDrive.get(c.drive.driveId);
    if (!seen) {
      byDrive.set(c.drive.driveId, c);
      continue;
    }
    byDrive.set(c.drive.driveId, {
      drive: c.drive,
      readOnly: seen.readOnly && c.readOnly,
      role: rank(c.role) < rank(seen.role) ? c.role : seen.role,
    });
  }
  const ordered = [...byDrive.values()].sort((a, b) => rank(a.role) - rank(b.role));
  const used = new Set<string>();
  const out: PlannedMount<D>[] = [];
  const push = (m: PlannedMount<D>) => {
    if (out.length >= MAX_SESSION_DRIVES) return;
    used.add(m.mountPath);
    out.push(m);
  };
  for (const c of ordered) {
    const base = driveMountPath(c.drive, c.role);
    if (c.role !== 'drive' && used.has(base)) continue;
    let mountPath = base;
    for (let n = 2; used.has(mountPath); n++) mountPath = `${base}-${n}`;
    push({ ...c, mountPath });
    if (c.role === 'me' && c.readOnly) {
      push({
        drive: c.drive,
        readOnly: false,
        role: 'me',
        mountPath: FROM_AGENTS_MOUNT_PATH,
        subdir: FROM_AGENTS_FOLDER,
        fromAgents: true,
      });
    }
  }
  return out;
}

/** The Platinum volume name for a drive: stable, unique, and a valid volume name. */
export function driveVolumeName(driveId: string): string {
  return `kd-${driveId.replace(/-/g, '').slice(0, 20)}`;
}

/**
 * A drive-relative path from user input: absolute, no `.`/`..`/empty
 * segments. Returns null when the input cannot be one.
 */
export function normalizeDrivePath(raw: string | undefined | null): string | null {
  const value = (raw ?? '/').trim() || '/';
  if (value.includes('\0') || value.includes('\\')) return null;
  const segments = value.split('/').filter((s) => s !== '');
  if (segments.some((s) => s === '.' || s === '..')) return null;
  return `/${segments.join('/')}`;
}

/** " (conflict 2026-10-01 1405)" or " (conflict 2026-10-01 1405 a3f9)" or with a trailing number. */
const CONFLICT_MARK = / \(conflict \d{4}-\d{2}-\d{2} \d{4}[^)/]*\)/;

/** The path a conflict copy was made from, or null when the path is not a conflict copy. */
export function conflictOriginal(path: string): string | null {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash + 1);
  const base = path.slice(slash + 1);
  const match = CONFLICT_MARK.exec(base);
  if (!match) return null;
  return dir + base.slice(0, match.index) + base.slice(match.index + match[0].length);
}

