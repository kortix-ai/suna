// A project's Files: one drive, a tree of folders, and who may do what in
// each folder. Pure, so the rules are tested without a database.
//
// Access is the project's ordinary object grants (`kortix.role_assignments`,
// object type `folder`, the folder path as the object id), at three levels:
// read < write < manage. A grant covers its folder and everything below it.
//
// Two folders are special:
// - `/Users/<name>` is one person's folder. Grants above it never reach into
//   it, and project admins have no implicit access to it: it is private until
//   its owner shares it.
// - `/` and `/Users` hold the tree together and cannot be granted.

export type FolderLevel = 'read' | 'write' | 'manage';
export type FolderAccess = 'none' | FolderLevel;

const RANK: Record<FolderAccess, number> = { none: 0, read: 1, write: 2, manage: 3 };

export function folderAccessAtLeast(have: FolderAccess, need: FolderLevel): boolean {
  return RANK[have] >= RANK[need];
}

export function maxFolderAccess(a: FolderAccess, b: FolderAccess): FolderAccess {
  return RANK[a] >= RANK[b] ? a : b;
}

export const USERS_DIR = '/Users';
export const COMPANY_DIR = '/Company';
/** The memory folder inside a person's folder and inside the shared Company folder. */
export const MEMORY_DIR_NAME = 'Memory';
export const COMPANY_MEMORY_DIR = `${COMPANY_DIR}/${MEMORY_DIR_NAME}`;

/** Where a person's own folder mounts in their sessions (with `~/Desktop` linked to it). */
export const DESKTOP_MOUNT_PATH = '/drives/me';
export const DRIVES_ROOT = '/drives';

/**
 * Who a grant names: a person, a team (account group), an agent (its service
 * account) or everyone who works in the project.
 */
export type FolderPrincipalType = 'user' | 'group' | 'agent' | 'project';

export interface FolderGrant {
  grantId?: string;
  path: string;
  level: FolderLevel;
  principalType: FolderPrincipalType;
  principalId: string;
  /** `system` grants are the ones Kortix made (a person's own folder, the Company default). */
  source?: string;
}

/** Who is asking. Everything optional: a session has an agent and maybe a person. */
export interface FolderSubject {
  userId?: string | null;
  groupIds?: ReadonlySet<string>;
  /** The agent's service account id. */
  agentId?: string | null;
  /** Reaches grants to the whole project (people who may work in it, and its sessions). */
  projectMember?: boolean;
  /** Project admin: manage everywhere except in people's own folders. */
  admin?: boolean;
}

/** `/a/b` within `/a`; everything is within `/`. */
export function pathWithinFolder(path: string, folder: string): boolean {
  if (folder === '/') return true;
  return path === folder || path.startsWith(`${folder}/`);
}

/** `/Users/ana` for any path inside it, else null. */
export function personalFolderOf(path: string): string | null {
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2 || `/${parts[0]}` !== USERS_DIR) return null;
  return `${USERS_DIR}/${parts[1]}`;
}

/** A folder a grant may name: not the root, not `/Users` itself. */
export function grantableFolder(path: string): boolean {
  return path !== '/' && path !== USERS_DIR;
}

export function grantReaches(grant: FolderGrant, subject: FolderSubject): boolean {
  switch (grant.principalType) {
    case 'user':
      return !!subject.userId && grant.principalId === subject.userId;
    case 'group':
      return !!subject.groupIds?.has(grant.principalId);
    case 'agent':
      return !!subject.agentId && grant.principalId === subject.agentId;
    case 'project':
      return !!subject.projectMember;
  }
}

/** A grant on `grant.path` covers `path`: it is at or above it, and no person's folder lies between. */
function grantCovers(grantPath: string, path: string): boolean {
  if (!pathWithinFolder(path, grantPath)) return false;
  const personal = personalFolderOf(path);
  return !personal || pathWithinFolder(grantPath, personal);
}

/** What `subject` may do at `path`. */
export function folderAccess(path: string, grants: readonly FolderGrant[], subject: FolderSubject): FolderAccess {
  let best: FolderAccess = subject.admin && !personalFolderOf(path) ? 'manage' : 'none';
  for (const g of grants) {
    if (best === 'manage') break;
    if (grantCovers(g.path, path) && grantReaches(g, subject)) best = maxFolderAccess(best, g.level);
  }
  return best;
}

/**
 * May `subject` see `path` in a listing? Yes when it may read it, or when it
 * may read something below it (the folders on the way there are shown so the
 * tree can be walked).
 */
export function folderVisible(path: string, grants: readonly FolderGrant[], subject: FolderSubject): boolean {
  if (folderAccess(path, grants, subject) !== 'none') return true;
  if (subject.admin && !personalFolderOf(path)) return true;
  return grants.some((g) => g.path !== path && pathWithinFolder(g.path, path) && grantReaches(g, subject));
}

/** The grants that reach `subject` and cover `path`, nearest folder first. */
export function grantsCovering(path: string, grants: readonly FolderGrant[]): FolderGrant[] {
  return grants
    .filter((g) => grantCovers(g.path, path))
    .sort((a, b) => b.path.length - a.path.length || byText(a.path, b.path));
}

// ─── Session mounts ───────────────────────────────────────────────────────

export interface FolderMountCandidate {
  path: string;
  level: FolderLevel;
  /** Lower mounts first when not all fit: the person's own folder, agent, project, people. */
  priority: number;
  /** The session owner's own folder. */
  desktop?: boolean;
  /** The mount reaches the session through its person (their folder or a share with them), not its agent or project. */
  viaPerson?: boolean;
}

export interface PlannedFolderMount {
  path: string;
  readOnly: boolean;
  mountPath: string;
  desktop: boolean;
  viaPerson: boolean;
}

export interface FolderMountPlan {
  mounts: PlannedFolderMount[];
  /** Folders the session should have that did not fit, in priority order. */
  skipped: string[];
}

const RESERVED_MOUNT_NAMES = new Set(['me', 'readme-md']);

export function folderMountName(path: string): string {
  const last = path.split('/').filter(Boolean).pop() ?? 'files';
  const slug = last
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  const name = slug || 'folder';
  return RESERVED_MOUNT_NAMES.has(name) ? `${name}-folder` : name;
}

/**
 * The folders a session mounts, one volume mount each (a subdirectory mount of
 * the project drive, so the box sees nothing outside it):
 *
 * - each folder once, at the best level any grant gives it;
 * - a folder already covered by a mounted folder above it at the same or a
 *   higher level is not mounted again;
 * - the session owner's folder at `/drives/me`, every other at
 *   `/drives/<folder name>`;
 * - `slots` mounts at most; the rest come back in `skipped`, never dropped silently.
 */
export function planFolderMounts(candidates: FolderMountCandidate[], slots: number): FolderMountPlan {
  const byPath = new Map<string, FolderMountCandidate>();
  for (const c of candidates) {
    const seen = byPath.get(c.path);
    if (!seen) {
      byPath.set(c.path, { ...c });
      continue;
    }
    byPath.set(c.path, {
      path: c.path,
      level: maxFolderAccess(seen.level, c.level) as FolderLevel,
      priority: Math.min(seen.priority, c.priority),
      desktop: seen.desktop || c.desktop,
      viaPerson: !!seen.viaPerson && !!c.viaPerson,
    });
  }
  const all = [...byPath.values()];
  const covered = (c: FolderMountCandidate) =>
    all.some(
      (a) =>
        a !== c &&
        a.path !== c.path &&
        grantCovers(a.path, c.path) &&
        RANK[a.level] >= RANK[c.level] &&
        // Writes never reach a folder through a read-only mount above it.
        !(RANK[a.level] < RANK.write && RANK[c.level] >= RANK.write),
    );
  const ordered = all
    .filter((c) => !covered(c))
    .sort(
      (a, b) =>
        Number(!!b.desktop) - Number(!!a.desktop) ||
        a.priority - b.priority ||
        a.path.split('/').length - b.path.split('/').length ||
        byText(a.path, b.path),
    );
  const used = new Set<string>();
  const mounts: PlannedFolderMount[] = [];
  const skipped: string[] = [];
  for (const c of ordered) {
    if (mounts.length >= slots) {
      skipped.push(c.path);
      continue;
    }
    let mountPath = c.desktop ? DESKTOP_MOUNT_PATH : `${DRIVES_ROOT}/${folderMountName(c.path)}`;
    if (!c.desktop) {
      const base = mountPath;
      for (let n = 2; used.has(mountPath); n++) mountPath = `${base}-${n}`;
    }
    used.add(mountPath);
    mounts.push({
      path: c.path,
      readOnly: !folderAccessAtLeast(c.level, 'write'),
      mountPath,
      desktop: !!c.desktop,
      viaPerson: !!c.viaPerson,
    });
  }
  return { mounts, skipped };
}

/** A person's folder name from their email: `ana.lima@x.io` → `ana.lima`. */
export function personalFolderName(email: string | null | undefined, userId: string): string {
  const handle = (email ?? '').split('@')[0] ?? '';
  const clean = handle
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48);
  return clean || `user-${userId.replace(/-/g, '').slice(0, 8)}`;
}

/** Code-point order: the same on every server, whatever its locale. */
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
