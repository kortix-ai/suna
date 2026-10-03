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
 * caller is not a member of it. `granted` is the best grant that reaches the
 * caller: a share of a personal drive (a `user` grant), or for a company drive
 * a grant to them, or to a project or agent they work through.
 *
 * - A personal drive is its owner's alone unless shared: an account admin gets
 *   no access to a colleague's personal drive.
 * - A company drive is managed by account owners and admins; anyone else gets
 *   exactly what a grant gives them, and nothing without one.
 * - An agent drive belongs to its project: members write it, admins manage it
 *   (the routes also check the project).
 */
export function driveAccess(
  drive: DriveOwnership,
  caller: { userId: string; accountRole: AccountRole | null; granted?: 'read' | 'write' | null },
): DriveAccess {
  if (!caller.accountRole) return 'none';
  const admin = caller.accountRole === 'owner' || caller.accountRole === 'admin';
  if (drive.kind === 'personal') {
    if (drive.ownerUserId === caller.userId) return 'manage';
    return caller.granted ?? 'none';
  }
  if (drive.kind === 'company') return admin ? 'manage' : (caller.granted ?? 'none');
  if (drive.kind === 'agent') return admin ? 'manage' : 'write';
  return 'none';
}

/** The more permissive of two grants. */
export function bestGrant(
  a: 'read' | 'write' | null | undefined,
  b: 'read' | 'write' | null | undefined,
): 'read' | 'write' | null {
  if (a === 'write' || b === 'write') return 'write';
  return a ?? b ?? null;
}

export const PERSONAL_MOUNT_PATH = '/drives/me';
/** The writable "From agents" folder of the personal drive, mounted beside it. */
export const FROM_AGENTS_MOUNT_PATH = '/drives/from-agents';
/** The folder of the personal drive that agents write by default. */
export const FROM_AGENTS_FOLDER = '/From agents';
export const AGENT_MOUNT_PATH = '/drives/agent';
/**
 * Platinum's per-sandbox volume mount cap when its limits cannot be read. The
 * live value comes from Platinum (see volumes.ts `sandboxMountLimit`); every
 * volume counts against it, drives and the session's own state volume alike.
 */
export const DEFAULT_SANDBOX_MOUNT_LIMIT = 8;

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
  /**
   * Among other drives, lower mounts first when not all of them fit; ties go
   * by name. The session plan uses it for: agent grants, project grants,
   * shares with the owner, then drives attached by hand in attach order.
   */
  priority?: number;
}

export interface PlannedMount<D> extends MountCandidate<D> {
  mountPath: string;
  /** Mount only this folder of the drive (the "From agents" mount). */
  subdir?: string;
  /** This entry is the writable "From agents" folder of the `me` drive. */
  fromAgents?: boolean;
}

export interface DriveMountPlan<D> {
  mounts: PlannedMount<D>[];
  /** Drives that did not fit in the slots the sandbox had, in priority order. */
  skipped: D[];
}

/**
 * Mount paths for one session: the owner's drive (and, when it is read-only,
 * its writable "From agents" folder beside it), the agent drive, then every
 * other drive by priority, each drive once (the most permissive candidate and
 * the best priority win), each at a distinct path. `slots` is how many volume
 * mounts the sandbox has left for drives: a drive that does not fit is
 * returned in `skipped`, never dropped silently.
 */
export function planDriveMounts<D extends { name: string; driveId: string }>(
  candidates: MountCandidate<D>[],
  slots: number = DEFAULT_SANDBOX_MOUNT_LIMIT,
): DriveMountPlan<D> {
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
      priority: Math.min(seen.priority ?? 0, c.priority ?? 0),
    });
  }
  const ordered = [...byDrive.values()].sort(
    (a, b) =>
      rank(a.role) - rank(b.role) ||
      (a.priority ?? 0) - (b.priority ?? 0) ||
      byText(a.drive.name.toLowerCase(), b.drive.name.toLowerCase()) ||
      byText(a.drive.driveId, b.drive.driveId),
  );
  const used = new Set<string>();
  const mounts: PlannedMount<D>[] = [];
  const skipped: D[] = [];
  for (const c of ordered) {
    const base = driveMountPath(c.drive, c.role);
    if (c.role !== 'drive' && used.has(base)) continue;
    const withFromAgents = c.role === 'me' && c.readOnly;
    if (mounts.length + (withFromAgents ? 2 : 1) > slots) {
      skipped.push(c.drive);
      continue;
    }
    let mountPath = base;
    for (let n = 2; used.has(mountPath); n++) mountPath = `${base}-${n}`;
    used.add(mountPath);
    mounts.push({ ...c, mountPath });
    if (withFromAgents) {
      used.add(FROM_AGENTS_MOUNT_PATH);
      mounts.push({
        drive: c.drive,
        readOnly: false,
        role: 'me',
        mountPath: FROM_AGENTS_MOUNT_PATH,
        subdir: FROM_AGENTS_FOLDER,
        fromAgents: true,
      });
    }
  }
  return { mounts, skipped };
}

/** Code-point order: the same on every server, whatever its locale. */
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** What a session tells people about drives that did not fit. */
export function skippedDrivesMessage(names: string[], slots: number): string {
  return (
    `${names.length === 1 ? 'A drive did' : `${names.length} drives did`} not fit in this session: ${names.join(', ')}. ` +
    `A session has room for ${slots} drive mounts. Take a drive out of the session to make room, then restart it.`
  );
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

