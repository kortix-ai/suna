// A project's Files: one drive (kortix.drives, kind `project`) backed by one
// volume, and per-folder access held as ordinary object grants in
// kortix.role_assignments (object type `folder`, the folder path as object id).
//
// The row is written first; its volume is created by name the first time
// something writes to it or a session mounts it, so listing or browsing never
// creates storage. Every storage call addresses the volume by its
// deterministic name, never by the stored id.
//
// Sessions mount folders, not the drive: each folder the session may use is a
// subdirectory mount of the one volume, so the box sees nothing outside the
// folders it was given (a mount cannot hide part of itself from a box whose
// agent can become root).

import { logger } from '../lib/logger';
import { accountMembers, driveConflicts, driveMountRevocations, drives, iamRoles, projectSessions, roleAssignments, serviceAccounts, sessionSandboxes } from '@kortix/db';
import { and, asc, count, eq, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { projectFeatureFlagEnabled } from '../feature-flags/for-project';
import { SYSTEM_ACTOR, assignRole, revokeAssignment } from '../iam/assignments';
import { resolvePrincipal } from '../iam/authorize';
import { config } from '../config';
import { db, withDbTransaction } from '../shared/db';
import { driveVolumeName, skippedDrivesMessage } from './access';
import {
  COMPANY_DIR,
  COMPANY_MEMORY_DIR,
  DESKTOP_MOUNT_PATH,
  DRIVES_ROOT,
  type FolderAccess,
  type FolderGrant,
  type FolderLevel,
  type FolderMountCandidate,
  type FolderPrincipalType,
  type FolderSubject,
  type PlannedFolderMount,
  MEMORY_DIR_NAME,
  USERS_DIR,
  folderAccess,
  grantReaches,
  pathWithinFolder,
  personalFolderName,
  planFolderMounts,
} from './folders';
import {
  DriveStorageError,
  attachSandboxVolume,
  detachSandboxVolume,
  driveStorageAvailable,
  execInSandbox,
  getDriveVolume,
  isMissingVolume,
  openDriveVolume,
  sandboxMountLimit,
  sandboxMountPaths,
  sandboxVolumeMounts,
  unmountInGuest,
  writeVolumeFile,
  type VolumeInfo,
} from './volumes';
import { isDriveSyncBox } from './sync';

export type DriveRow = typeof drives.$inferSelect;

export const PROJECT_DRIVE_NAME = 'Files';

export interface DriveJson {
  driveId: string;
  accountId: string;
  projectId: string;
  kind: 'project';
  name: string;
  sizeBytes: number | null;
  sizeLimitBytes: number | null;
  fileCount: number | null;
  lastChangeAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** The caller's access at the top of the drive: `manage` for project admins. */
  access: FolderAccess;
  /** The caller's own folder, `/Users/<name>`. */
  personalFolder: string | null;
  /** "(conflict ...)" copies in folders the caller can see that nobody resolved or dismissed yet. */
  openConflicts: number;
}

export function toDriveJson(
  drive: DriveRow,
  extra: { access: FolderAccess; personalFolder: string | null; openConflicts?: number; stats?: VolumeInfo | null },
): DriveJson {
  const stats = extra.stats;
  return {
    driveId: drive.driveId,
    accountId: drive.accountId,
    projectId: drive.projectId ?? '',
    kind: 'project',
    name: drive.name,
    sizeBytes: stats ? Number(stats.logical_bytes ?? 0) : null,
    sizeLimitBytes: stats?.size_limit_bytes != null ? Number(stats.size_limit_bytes) : null,
    fileCount: stats ? Number(stats.file_count ?? 0) : null,
    lastChangeAt: stats?.last_commit_at ?? null,
    createdAt: drive.createdAt.toISOString(),
    updatedAt: drive.updatedAt.toISOString(),
    access: extra.access,
    personalFolder: extra.personalFolder,
    openConflicts: extra.openConflicts ?? 0,
  };
}

/** Account emails by user id. */
export async function userEmails(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return out;
  const rows = (await db.execute(
    sql`SELECT id::text AS id, email FROM auth.users WHERE id = ANY(${`{${unique.join(',')}}`}::uuid[])`,
  )) as unknown as Array<{ id: string; email: string | null }>;
  for (const r of rows) if (r.email) out.set(r.id, r.email);
  return out;
}

/** Open conflict copies of a drive, as (path) rows. */
export async function openConflictRows(driveId: string) {
  return db
    .select()
    .from(driveConflicts)
    .where(and(eq(driveConflicts.driveId, driveId), isNull(driveConflicts.resolvedAt), isNull(driveConflicts.dismissedAt)))
    .orderBy(driveConflicts.detectedAt);
}

/** Open conflict copies per drive. */
export async function openConflictCounts(driveIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!driveIds.length) return out;
  const rows = await db
    .select({ driveId: driveConflicts.driveId, n: count() })
    .from(driveConflicts)
    .where(
      and(inArray(driveConflicts.driveId, driveIds), isNull(driveConflicts.resolvedAt), isNull(driveConflicts.dismissedAt)),
    )
    .groupBy(driveConflicts.driveId);
  for (const r of rows) out.set(r.driveId, Number(r.n));
  return out;
}

/** Volume stats, best effort: a slow or failed lookup reads as null. */
export async function driveStats(drive: DriveRow): Promise<VolumeInfo | null> {
  if (!driveStorageAvailable() || !drive.platinumVolumeId) return null;
  return getDriveVolume(drive.platinumVolumeName, AbortSignal.timeout(3_000)).catch(() => null);
}

export async function getDrive(driveId: string): Promise<DriveRow | null> {
  const [row] = await db.select().from(drives).where(eq(drives.driveId, driveId)).limit(1);
  return row ?? null;
}

async function findProjectDrive(projectId: string): Promise<DriveRow | null> {
  const [row] = await db
    .select()
    .from(drives)
    .where(and(eq(drives.projectId, projectId), eq(drives.kind, 'project')))
    .limit(1);
  return row ?? null;
}

/**
 * The project's drive, created on first use with its one default grant:
 * everyone who works in the project may write `/Company`.
 */
export async function ensureProjectDrive(accountId: string, projectId: string): Promise<DriveRow> {
  const existing = await findProjectDrive(projectId);
  if (existing) return existing;
  const driveId = crypto.randomUUID();
  const [created] = await db
    .insert(drives)
    .values({
      driveId,
      accountId,
      projectId,
      kind: 'project',
      name: PROJECT_DRIVE_NAME,
      platinumVolumeName: driveVolumeName(driveId),
    })
    .onConflictDoNothing()
    .returning();
  if (!created) {
    // Lost the insert race to a concurrent request: that row is ours too.
    const raced = await findProjectDrive(projectId);
    if (!raced) throw new Error('project drive vanished after a conflicting insert');
    return raced;
  }
  await setFolderGrant({
    drive: created,
    path: COMPANY_DIR,
    principal: { type: 'project', id: projectId },
    level: 'write',
    grantedBy: null,
    source: 'system',
  });
  return created;
}

/**
 * Open (create when missing) the drive's volume and return the name every
 * storage call uses. The first open lays out the folders everyone expects.
 */
export async function openVolumeFor(drive: DriveRow, signal?: AbortSignal): Promise<string> {
  const vol = await openDriveVolume(drive.platinumVolumeName, signal);
  if (drive.platinumVolumeId !== vol.id) {
    const first = !drive.platinumVolumeId;
    await db
      .update(drives)
      .set({ platinumVolumeId: vol.id, updatedAt: new Date() })
      .where(eq(drives.driveId, drive.driveId));
    drive.platinumVolumeId = vol.id;
    if (first && drive.kind === 'project') {
      await writeVolumeFile(drive.platinumVolumeName, `${COMPANY_MEMORY_DIR}/.keep`, new Uint8Array(), {
        overwrite: false,
      }).catch(() => undefined);
    }
  }
  return drive.platinumVolumeName;
}

/** A read: a drive with no volume yet (or none on this storage account) answers `empty`. */
export async function readDriveVolume<T>(drive: DriveRow, op: (volume: string) => Promise<T>, empty: () => T): Promise<T> {
  if (!drive.platinumVolumeId) return empty();
  try {
    return await op(drive.platinumVolumeName);
  } catch (err) {
    if (isMissingVolume(err)) return empty();
    throw err;
  }
}

/** A write: creates the volume on first use, and again if storage lost it. */
export async function writeDriveVolume<T>(drive: DriveRow, op: (volume: string) => Promise<T>): Promise<T> {
  if (!drive.platinumVolumeId) return op(await openVolumeFor(drive));
  try {
    return await op(drive.platinumVolumeName);
  } catch (err) {
    if (!isMissingVolume(err)) throw err;
    return op(await openVolumeFor(drive));
  }
}

// ─── Folder grants ─────────────────────────────────────────────────────────

const LEVEL_BY_ROLE: Record<string, FolderLevel> = {
  'folder-reader': 'read',
  'folder-writer': 'write',
  'folder-manager': 'manage',
};
const ROLE_BY_LEVEL: Record<FolderLevel, string> = {
  read: 'folder-reader',
  write: 'folder-writer',
  manage: 'folder-manager',
};

/** How the grant store names a principal kind. */
function storePrincipalType(type: FolderPrincipalType): 'user' | 'group' | 'service_account' | 'project' {
  return type === 'agent' ? 'service_account' : type;
}

/** Every live folder grant of a project's drive. */
export async function listFolderGrants(drive: DriveRow): Promise<FolderGrant[]> {
  if (!drive.projectId) return [];
  const rows = await db
    .select({
      assignmentId: roleAssignments.assignmentId,
      principalType: roleAssignments.principalType,
      principalId: roleAssignments.principalId,
      objectId: roleAssignments.objectId,
      source: roleAssignments.source,
      roleKey: iamRoles.key,
    })
    .from(roleAssignments)
    .innerJoin(iamRoles, eq(iamRoles.roleId, roleAssignments.roleId))
    .where(
      and(
        eq(roleAssignments.accountId, drive.accountId),
        eq(roleAssignments.scopeType, 'project'),
        eq(roleAssignments.scopeId, drive.projectId),
        eq(roleAssignments.objectType, 'folder'),
        isNull(iamRoles.accountId),
        or(isNull(roleAssignments.expiresAt), sql`${roleAssignments.expiresAt} > now()`),
      ),
    )
    .orderBy(asc(roleAssignments.createdAt));
  return rows.flatMap((r) => {
    const level = LEVEL_BY_ROLE[r.roleKey];
    if (!level || !r.objectId) return [];
    const principalType: FolderPrincipalType | null =
      r.principalType === 'service_account'
        ? 'agent'
        : r.principalType === 'user' || r.principalType === 'group' || r.principalType === 'project'
          ? r.principalType
          : null;
    if (!principalType) return [];
    return [{ grantId: r.assignmentId, path: r.objectId, level, principalType, principalId: r.principalId, source: r.source }];
  });
}

/**
 * Give one principal one level on one folder, replacing what it had there.
 * The caller checked who may.
 */
export async function setFolderGrant(input: {
  drive: DriveRow;
  path: string;
  principal: { type: FolderPrincipalType; id: string };
  level: FolderLevel;
  grantedBy: string | null;
  source?: 'manual' | 'system';
}): Promise<string> {
  const { drive } = input;
  if (!drive.projectId) throw new Error('only a project drive has folder grants');
  const principalType = storePrincipalType(input.principal.type);
  const assignment = await assignRole(SYSTEM_ACTOR, drive.accountId, {
    principal: { type: principalType, id: input.principal.id },
    roleKey: ROLE_BY_LEVEL[input.level],
    scope: { type: 'project', id: drive.projectId },
    object: { type: 'folder', id: input.path },
    source: input.source ?? 'manual',
    grantedBy: input.grantedBy,
  });
  // One level per (principal, folder): the other two roles go.
  const others = await db
    .select({ id: roleAssignments.assignmentId })
    .from(roleAssignments)
    .innerJoin(iamRoles, eq(iamRoles.roleId, roleAssignments.roleId))
    .where(
      and(
        eq(roleAssignments.accountId, drive.accountId),
        eq(roleAssignments.scopeType, 'project'),
        eq(roleAssignments.scopeId, drive.projectId),
        eq(roleAssignments.objectType, 'folder'),
        eq(roleAssignments.objectId, input.path),
        eq(roleAssignments.principalType, principalType),
        eq(roleAssignments.principalId, input.principal.id),
        ne(roleAssignments.assignmentId, assignment.assignmentId),
      ),
    );
  for (const o of others) await revokeAssignment(SYSTEM_ACTOR, drive.accountId, o.id, { skipWriterAuthz: true });
  return assignment.assignmentId;
}

export async function removeFolderGrant(drive: DriveRow, grantId: string): Promise<void> {
  await revokeAssignment(SYSTEM_ACTOR, drive.accountId, grantId, { skipWriterAuthz: true });
}

/** A person's own folder: the folder under /Users that Kortix gave them `manage` on. */
export function personalFolderFor(grants: readonly FolderGrant[], userId: string): string | null {
  const own = grants.find(
    (g) =>
      g.source === 'system' &&
      g.principalType === 'user' &&
      g.principalId === userId &&
      g.level === 'manage' &&
      g.path.startsWith(`${USERS_DIR}/`) &&
      g.path.split('/').length === 3,
  );
  return own?.path ?? null;
}

/**
 * The person's folder, `/Users/<name>`, made the first time they need it.
 *
 * Picking a free name and granting it is one step per drive: a transaction
 * holding the drive's advisory lock re-reads the grants before choosing, so two
 * first visits whose handles match (alex@a, alex@b) cannot both pick /Users/alex.
 */
export async function ensurePersonalFolder(drive: DriveRow, userId: string, grants?: FolderGrant[]): Promise<string> {
  const existing = personalFolderFor(grants ?? (await listFolderGrants(drive)), userId);
  if (existing) return existing;
  const email = (await userEmails([userId])).get(userId) ?? null;
  const base = personalFolderName(email, userId);
  return withDbTransaction(async () => {
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`drive-personal-folder:${drive.driveId}`}, 0))`);
    const known = await listFolderGrants(drive);
    const raced = personalFolderFor(known, userId);
    if (raced) return raced;
    const taken = new Set(known.filter((g) => g.path.startsWith(`${USERS_DIR}/`)).map((g) => g.path.split('/')[2]?.toLowerCase()));
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}-${n}`;
    const path = `${USERS_DIR}/${name}`;
    await setFolderGrant({ drive, path, principal: { type: 'user', id: userId }, level: 'manage', grantedBy: null, source: 'system' });
    return path;
  });
}

/** The agent's service account, when it has one (a grant to an agent made it). */
export async function agentServiceAccountId(accountId: string, projectId: string, agentName: string): Promise<string | null> {
  const [row] = await db
    .select({ id: serviceAccounts.serviceAccountId })
    .from(serviceAccounts)
    .where(
      and(eq(serviceAccounts.accountId, accountId), eq(serviceAccounts.projectId, projectId), eq(serviceAccounts.agentName, agentName)),
    )
    .limit(1);
  return row?.id ?? null;
}

/** A person's teams, for grants to a team. */
export async function groupIdsOf(userId: string, accountId: string): Promise<Set<string>> {
  const record = await resolvePrincipal({ type: 'user', id: userId }, accountId).catch(() => null);
  return new Set(record?.groupIds ?? []);
}

/** What `subject` may do at `path`, for the routes. */
export function accessAt(path: string, grants: readonly FolderGrant[], subject: FolderSubject): FolderAccess {
  return folderAccess(path, grants, subject);
}

// ─── Session mounts ────────────────────────────────────────────────────────

/** One folder mount as a session's sandbox has it, recorded at boot and on every change. */
export interface RecordedDriveMount {
  driveId: string;
  kind: 'project';
  mountPath: string;
  readOnly: boolean;
  /** The folder of the drive this mount is. */
  subdir: string;
  /** `me`: the session owner's own folder, mounted as their desktop. */
  role?: 'me' | 'drive';
  /** Reached through the session's person (their folder or a share with them), not its agent or project. */
  viaPerson?: boolean;
}

export interface SkippedDrive {
  driveId: string;
  /** The folder that did not fit. */
  name: string;
}

export interface SessionDriveMounts {
  /** The Platinum create body's `volumes`, keyed by mount path. */
  volumes: Record<string, { volume: string; read_only?: boolean; subdir?: string }>;
  mounts: RecordedDriveMount[];
  slots: number;
  skipped: SkippedDrive[];
}

export const DRIVE_MOUNTS_METADATA_KEY = 'driveMounts';
export const DRIVE_SKIPPED_METADATA_KEY = 'driveMountsSkipped';
export const DRIVE_SLOTS_METADATA_KEY = 'driveMountSlots';

/** A folder change that would take the session past the volume mounts a sandbox may have. */
export class DriveMountLimitError extends DriveStorageError {
  constructor(readonly limit: number) {
    super(409, `This session already mounts as many folders as it can (${limit}).`, 'drive_mount_limit');
    this.name = 'DriveMountLimitError';
  }
}

/**
 * A folder the session must mount could not be mounted. The session never
 * starts without its files: provisioning fails with this message instead.
 */
export class DriveMountError extends Error {
  constructor(
    readonly userMessage: string,
    readonly driveNames: string[],
  ) {
    super(`[drives] ${userMessage}`);
    this.name = 'DriveMountError';
  }
}

interface SessionFacts {
  createdBy: string | null;
  visibility: string;
  origin: string;
  agentName: string;
  metadata: unknown;
}

async function sessionFacts(sessionId: string): Promise<SessionFacts | null> {
  const [row] = await db
    .select({
      createdBy: projectSessions.createdBy,
      visibility: projectSessions.visibility,
      origin: projectSessions.origin,
      agentName: projectSessions.agentName,
      metadata: projectSessions.metadata,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  return row ?? null;
}

const CHAT_SOURCES = new Set(['slack', 'teams']);

/**
 * A session a person started for themselves: started by a user (not a
 * trigger, schedule, backend or chat channel), still private, and booted by
 * that same person. Only such a session mounts that person's folder and what
 * was shared with them.
 */
export function isPersonalSession(session: SessionFacts | null, bootingUserId: string | null): boolean {
  if (!session || !session.createdBy) return false;
  if (session.origin !== 'user' || session.visibility !== 'private') return false;
  const source = (session.metadata as Record<string, unknown> | null)?.source;
  if (typeof source === 'string' && CHAT_SOURCES.has(source)) return false;
  return session.createdBy === bootingUserId;
}

/** Whether the session is the caller's own (its person's folder mounts in it). */
export async function isCallersPersonalSession(sessionId: string, callerId: string | null): Promise<boolean> {
  return isPersonalSession(await sessionFacts(sessionId), callerId);
}

async function inAccount(userId: string, accountId: string): Promise<boolean> {
  const [m] = await db
    .select({ role: accountMembers.accountRole })
    .from(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)))
    .limit(1);
  return !!m;
}

export interface SessionFolderPlan {
  drive: DriveRow;
  mounts: PlannedFolderMount[];
  skipped: string[];
}

/**
 * The folders a new sandbox of this session mounts. The session acts as its
 * agent, as the project (grants to everyone in it), and, in a personal
 * session (see {@link isPersonalSession}), as its person: their own folder
 * mounts read-write at /drives/me, plus what was shared with them or their
 * teams. Project admins get no folder by role here: a session sees only what
 * a grant gives it, so nobody's private folder lands in an admin's session.
 */
export async function planSessionDrives(input: {
  accountId: string;
  projectId: string;
  sessionId: string;
  bootingUserId: string | null;
  agentName: string;
  slots?: number;
}): Promise<SessionFolderPlan> {
  const { accountId, projectId, sessionId, agentName } = input;
  const drive = await ensureProjectDrive(accountId, projectId);
  const session = await sessionFacts(sessionId);
  const personal = isPersonalSession(session, input.bootingUserId);
  // Someone who left the account takes nothing of it into a session.
  const owner = personal && (await inAccount(session!.createdBy!, accountId)) ? session!.createdBy! : null;
  let grants = await listFolderGrants(drive);
  if (owner && !personalFolderFor(grants, owner)) {
    await ensurePersonalFolder(drive, owner, grants);
    grants = await listFolderGrants(drive);
  }
  const agentId = await agentServiceAccountId(accountId, projectId, agentName);
  const groupIds = owner ? await groupIdsOf(owner, accountId) : new Set<string>();
  const own = owner ? personalFolderFor(grants, owner) : null;

  const candidates: FolderMountCandidate[] = [];
  for (const g of grants) {
    const viaAgent = grantReaches(g, { agentId });
    const viaProject = grantReaches(g, { projectMember: true });
    const viaPerson = !!owner && grantReaches(g, { userId: owner, groupIds });
    if (!viaAgent && !viaProject && !viaPerson) continue;
    candidates.push({
      path: g.path,
      level: g.level,
      priority: viaAgent ? 0 : viaProject ? 1 : 2,
      desktop: g.path === own,
      viaPerson: !viaAgent && !viaProject,
    });
  }
  const plan = planFolderMounts(candidates, input.slots ?? (await sandboxMountLimit()));
  return { drive, mounts: plan.mounts, skipped: plan.skipped };
}

const OPEN_TIMEOUT_MS = 8_000;

function toRecorded(drive: DriveRow, p: PlannedFolderMount, mountPath = p.mountPath): RecordedDriveMount {
  return {
    driveId: drive.driveId,
    kind: 'project',
    mountPath,
    readOnly: p.readOnly,
    subdir: p.path,
    role: p.desktop ? 'me' : 'drive',
    ...(p.viaPerson ? { viaPerson: true } : {}),
  };
}

/**
 * The folders a new sandbox of this session mounts (see
 * {@link planSessionDrives}), with the volume opened, or undefined when the
 * project has no Files. Strict: a volume that does not open fails the boot
 * with a {@link DriveMountError}. `reservedSlots` are the sandbox's other
 * volumes; folders past the limit are left out by priority and returned in
 * `skipped`, which the session shows people.
 */
export async function sessionVolumeMounts(input: {
  accountId: string;
  projectId: string;
  sessionId: string;
  bootingUserId: string | null;
  agentName: string;
  reservedSlots?: number;
}): Promise<SessionDriveMounts | undefined> {
  if (!(await sessionDrivesEnabled(input.projectId))) return undefined;
  const limit = await sandboxMountLimit();
  const slots = Math.max(0, limit - (input.reservedSlots ?? 0));
  const plan = await planSessionDrives({ ...input, slots });
  const skipped = plan.skipped.map((path) => ({ driveId: plan.drive.driveId, name: path }));
  if (skipped.length) {
    logger.warn(`[drives] session ${input.sessionId}: ${skipped.length} folder(s) past the ${slots} mount slots left out`);
  }
  if (!plan.mounts.length) return skipped.length ? { volumes: {}, mounts: [], skipped, slots } : undefined;
  let volume: string | null = null;
  let lastErr: unknown;
  // Three tries over ~10 s ride out a storage blip; then the boot fails, loudly.
  for (let attempt = 1; attempt <= 3 && !volume; attempt++) {
    try {
      volume = await openVolumeFor(plan.drive, AbortSignal.timeout(OPEN_TIMEOUT_MS));
    } catch (err) {
      lastErr = err;
      if (err instanceof DriveStorageError && err.code === 'quota_exceeded') break;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2_000));
    }
  }
  if (!volume) {
    logger.warn(`[drives] files of project ${input.projectId} did not open:`, { error: lastErr instanceof Error ? lastErr.message : String(lastErr) });
    const quota = lastErr instanceof DriveStorageError && lastErr.code === 'quota_exceeded';
    throw new DriveMountError(
      quota
        ? 'This session’s files could not be mounted: the workspace reached its storage limit. The session did not start without them.'
        : 'This session’s files could not be mounted: file storage is not reachable right now. The session did not start without them. Try again in a minute.',
      [PROJECT_DRIVE_NAME],
    );
  }
  const out: SessionDriveMounts = { volumes: {}, mounts: [], skipped, slots };
  for (const p of plan.mounts) {
    out.volumes[p.mountPath] = { volume, ...(p.readOnly ? { read_only: true } : {}), subdir: p.path };
    out.mounts.push(toRecorded(plan.drive, p));
  }
  return out;
}

/** Files mount in this project's sessions: storage configured, the operator override not set, Volumes on for the organization. */
export async function sessionDrivesEnabled(projectId: string): Promise<boolean> {
  if (!sessionDriveMountEnabled()) return false;
  return projectFeatureFlagEnabled(projectId, 'drives');
}

/**
 * Operator emergency override: KORTIX_DRIVES_SESSION_MOUNT=off boots every
 * session without files. The product switch is Volumes (Admin → Volumes).
 */
export function sessionDriveMountEnabled(): boolean {
  if (!driveStorageAvailable()) return false;
  const raw = (config.KORTIX_DRIVES_SESSION_MOUNT ?? '').trim().toLowerCase();
  return !(raw === '0' || raw === 'off' || raw === 'false' || raw === 'no');
}

export function recordedDriveMounts(metadata: unknown): RecordedDriveMount[] {
  const raw = (metadata as Record<string, unknown> | null | undefined)?.[DRIVE_MOUNTS_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (m): m is RecordedDriveMount =>
      !!m && typeof m === 'object' && typeof m.driveId === 'string' && typeof m.mountPath === 'string',
  );
}

async function sessionSandboxRow(sessionId: string) {
  const [row] = await db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      provider: sessionSandboxes.provider,
      externalId: sessionSandboxes.externalId,
      status: sessionSandboxes.status,
      metadata: sessionSandboxes.metadata,
    })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId))
    .limit(1);
  return row ?? null;
}

async function writeRecordedMounts(sandboxId: string, mounts: RecordedDriveMount[]): Promise<void> {
  await db
    .update(sessionSandboxes)
    .set({
      metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${JSON.stringify({ [DRIVE_MOUNTS_METADATA_KEY]: mounts })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(sessionSandboxes.sandboxId, sandboxId));
}

export interface SessionDriveView extends RecordedDriveMount {
  /** The folder's name, for people. */
  name: string;
  openConflicts: number;
}

/** The folders the session's current sandbox mounts, with their open conflicts. */
export async function readSessionDriveMounts(sessionId: string): Promise<SessionDriveView[]> {
  const row = await sessionSandboxRow(sessionId);
  const mounts = recordedDriveMounts(row?.metadata);
  if (!mounts.length) return [];
  const driveIds = [...new Set(mounts.map((m) => m.driveId))];
  const open = await db
    .select({ driveId: driveConflicts.driveId, path: driveConflicts.path })
    .from(driveConflicts)
    .where(and(inArray(driveConflicts.driveId, driveIds), isNull(driveConflicts.resolvedAt), isNull(driveConflicts.dismissedAt)));
  return mounts.map((m) => ({
    ...m,
    name: m.subdir && m.subdir !== '/' ? m.subdir.split('/').filter(Boolean).join(' / ') : PROJECT_DRIVE_NAME,
    openConflicts: open.filter((c) => c.driveId === m.driveId && pathWithinFolder(c.path, m.subdir || '/')).length,
  }));
}

/** Folders the session's current sandbox should have but did not fit at its boot, and the message for them. */
export async function readSkippedSessionDrives(
  sessionId: string,
): Promise<{ skipped: SkippedDrive[]; message: string | null }> {
  const row = await sessionSandboxRow(sessionId);
  const md = row?.metadata as Record<string, unknown> | null | undefined;
  const raw = md?.[DRIVE_SKIPPED_METADATA_KEY];
  const recorded = Array.isArray(raw)
    ? raw.filter((d): d is SkippedDrive => !!d && typeof d.driveId === 'string' && typeof d.name === 'string')
    : [];
  const mounted = new Set(recordedDriveMounts(md).map((m) => m.subdir));
  const skipped = recorded.filter((d) => !mounted.has(d.name));
  if (!skipped.length) return { skipped, message: null };
  const slots = Number(md?.[DRIVE_SLOTS_METADATA_KEY]);
  return {
    skipped,
    message: skippedDrivesMessage(
      skipped.map((d) => d.name),
      Number.isFinite(slots) ? slots : await sandboxMountLimit(),
    ),
  };
}

/** The live Platinum sandbox of a session, when it has one that runs. */
async function liveSandbox(sessionId: string) {
  const row = await sessionSandboxRow(sessionId);
  if (!row || row.provider !== 'platinum' || !row.externalId || row.status !== 'active') return null;
  return { ...row, externalId: row.externalId };
}

/** The live box of a session whose files are synced in (a provider other than Platinum). */
async function liveSyncSandbox(sessionId: string) {
  const row = await sessionSandboxRow(sessionId);
  if (!row || row.status !== 'active' || !isDriveSyncBox(row)) return null;
  return row;
}

const sameMount = (a: { subdir?: string; readOnly: boolean }, b: { subdir?: string; readOnly: boolean }) =>
  (a.subdir ?? '/') === (b.subdir ?? '/') && a.readOnly === b.readOnly;

/** Mount paths for the wanted mounts that are new, avoiding the ones kept. */
function placeNew(drive: DriveRow, want: PlannedFolderMount[], kept: RecordedDriveMount[]): RecordedDriveMount[] {
  const used = new Set(kept.map((m) => m.mountPath));
  const out: RecordedDriveMount[] = [];
  for (const w of want) {
    let mountPath = w.mountPath;
    if (!w.desktop) for (let n = 2; used.has(mountPath); n++) mountPath = `${w.mountPath.replace(/-\d+$/, '')}-${n}`;
    used.add(mountPath);
    out.push(toRecorded(drive, w, mountPath));
  }
  return out;
}

/**
 * A synced box has nothing to attach: its record is what the box's daemon
 * syncs and what the sync routes authorize, so rewriting it is the change.
 */
async function applyDriveToSyncedSandbox(
  box: { sandboxId: string; externalId: string | null; provider: string; metadata: unknown },
  input: Omit<Parameters<typeof planSessionDrives>[0], 'slots'> & { driveId: string },
): Promise<{ live: boolean; flushed?: boolean }> {
  const current = recordedDriveMounts(box.metadata);
  const slots = await driveSlotsFor({ externalId: null, metadata: box.metadata }, false);
  const plan = await planSessionDrives({ ...input, slots });
  const others = current.filter((m) => m.driveId !== plan.drive.driveId);
  const have = current.filter((m) => m.driveId === plan.drive.driveId);
  const kept = have.filter((h) => plan.mounts.some((w) => sameMount(h, w)));
  const added = placeNew(plan.drive, plan.mounts.filter((w) => !have.some((h) => sameMount(h, w))), [...others, ...kept]);
  // A writable folder leaving the box or turning read-only: push what the box
  // has not sent yet while the record still allows it. If the push does not
  // complete, the daemon keeps the copy aside rather than delete it.
  const losesWrite = have.some((h) => !h.readOnly && !kept.includes(h));
  let flushed: boolean | undefined;
  if (losesWrite && box.externalId) {
    const { flushDriveSyncBeforeStop } = await import('../projects/surface');
    flushed = await flushDriveSyncBeforeStop({
      sandboxId: box.sandboxId,
      externalId: box.externalId,
      provider: box.provider,
      metadata: box.metadata,
      driveId: plan.drive.driveId,
    });
  }
  await writeRecordedMounts(box.sandboxId, [...others, ...kept, ...added]);
  return { live: true, ...(flushed === undefined ? {} : { flushed }) };
}

/**
 * How many volume mounts a session's sandbox has for files: Platinum's
 * per-sandbox limit minus its volumes that are not files. A running sandbox
 * is asked; otherwise what its boot recorded.
 */
async function driveSlotsFor(box: { externalId: string | null; metadata: unknown } | null, live: boolean): Promise<number> {
  const limit = await sandboxMountLimit();
  const recorded = Number((box?.metadata as Record<string, unknown> | null | undefined)?.[DRIVE_SLOTS_METADATA_KEY]);
  if (live && box?.externalId) {
    const paths = await sandboxMountPaths(box.externalId);
    if (paths) {
      const drivePaths = new Set(recordedDriveMounts(box.metadata).map((m) => m.mountPath));
      return Math.max(0, limit - paths.filter((p) => !drivePaths.has(p)).length);
    }
  }
  return Number.isFinite(recorded) && recorded >= 0 ? Math.min(recorded, limit) : limit;
}

const subdirOf = (subdir: string | undefined) => (subdir ?? '/').replace(/\/+$/, '') || '/';

/**
 * Attach one folder at its path, resolving whatever already sits there rather
 * than leaving it: the same folder Platinum already mounts there is adopted; a
 * different Platinum mount is detached; a mount only the guest still has (a VM
 * resumed from memory keeps the mounts its kernel had after Platinum ended
 * them at the stop) is unmounted in the guest. Then the attach runs again.
 */
async function attachDriveMount(externalId: string, m: RecordedDriveMount, volume: string): Promise<void> {
  const input = { volume, readOnly: m.readOnly, subdir: m.subdir };
  try {
    await attachSandboxVolume(externalId, m.mountPath, input);
    return;
  } catch (err) {
    if (!(err instanceof DriveStorageError) || err.code !== 'path_exists') throw err;
  }
  const mounts = await sandboxVolumeMounts(externalId);
  if (!mounts) throw new DriveStorageError(503, 'Drive storage is unavailable, try again shortly', 'drive_storage_unavailable');
  const held = mounts.find((x) => x.mountPath === m.mountPath);
  if (held && held.volume === volume && held.readOnly === m.readOnly && subdirOf(held.subdir) === subdirOf(m.subdir)) return;
  if (held) {
    logger.warn(`[drives] ${externalId}: replacing the mount at ${m.mountPath} (${held.volume}:${held.subdir})`);
    await detachSandboxVolume(externalId, m.mountPath);
  } else {
    if (!m.mountPath.startsWith(`${DRIVES_ROOT}/`)) throw new Error(`${m.mountPath} is in use in the sandbox`);
    logger.warn(`[drives] ${externalId}: unmounting a stale guest mount at ${m.mountPath}`);
    await unmountInGuest(externalId, m.mountPath);
  }
  await attachSandboxVolume(externalId, m.mountPath, input);
}

/**
 * Bring the running sandbox's folder mounts in line with what the session may
 * use now: detach what it lost (or what changed access), attach what it gained.
 * A session that is not running needs nothing: its next sandbox mounts the plan.
 */
async function applyDriveToRunningSandbox(input: {
  accountId: string;
  projectId: string;
  sessionId: string;
  driveId: string;
  bootingUserId: string | null;
  agentName: string;
}): Promise<{ live: boolean }> {
  const synced = await liveSyncSandbox(input.sessionId);
  if (synced) return applyDriveToSyncedSandbox(synced, input);
  const box = await liveSandbox(input.sessionId);
  if (!box) return { live: false };
  const current = recordedDriveMounts(box.metadata);
  const slots = await driveSlotsFor(box, true);
  const plan = await planSessionDrives({ ...input, slots });
  const others = current.filter((m) => m.driveId !== plan.drive.driveId);
  const have = current.filter((m) => m.driveId === plan.drive.driveId);
  const gone = have.filter((h) => !plan.mounts.some((w) => sameMount(h, w)));
  const fresh = plan.mounts.filter((w) => !have.some((h) => sameMount(h, w)));
  if (!gone.length && !fresh.length) return { live: true };
  let kept = have.filter((h) => !gone.includes(h));
  for (const m of gone) {
    await detachSandboxVolume(box.externalId, m.mountPath);
    kept = kept.filter((k) => k !== m);
    await writeRecordedMounts(box.sandboxId, [...others, ...kept]);
  }
  if (fresh.length) {
    const volume = await openVolumeFor(plan.drive, AbortSignal.timeout(OPEN_TIMEOUT_MS));
    for (const m of placeNew(plan.drive, fresh, [...others, ...kept])) {
      await attachDriveMount(box.externalId, m, volume);
      kept = [...kept, m];
      await writeRecordedMounts(box.sandboxId, [...others, ...kept]);
    }
  }
  // Awaited: the ownership pass inside makes a newly writable mount writable
  // for the agent by the time the caller hears back.
  await refreshDriveNotes(input.sessionId);
  return { live: true };
}

/**
 * After a sandbox came back (a resume of the same VM keeps the mounts it had
 * at its stop): bring its mounts in line with what the session may use now. Best effort.
 */
export async function reconcileSessionDrives(sessionId: string): Promise<void> {
  try {
    const [row] = await db
      .select({
        accountId: projectSessions.accountId,
        projectId: projectSessions.projectId,
        createdBy: projectSessions.createdBy,
        agentName: projectSessions.agentName,
      })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1);
    if (!row || !(await sessionDrivesEnabled(row.projectId))) return;
    const drive = await ensureProjectDrive(row.accountId, row.projectId);
    await applyDriveToRunningSandbox({
      accountId: row.accountId,
      projectId: row.projectId,
      sessionId,
      bootingUserId: row.createdBy,
      agentName: row.agentName,
      driveId: drive.driveId,
    });
    const box = await sessionSandboxRow(sessionId);
    if (box) await clearMountRevocation(box.sandboxId);
    await refreshDriveNotes(sessionId);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error(`[drives] reconciling the files of session ${sessionId} failed; retried by the drive worker:`, { error });
    // Recorded like a revocation that has not landed: the drive worker brings
    // the mounts in line again (with backoff) until it does.
    const box = await sessionSandboxRow(sessionId).catch(() => null);
    if (box) {
      await recordMountRevocation(box.sandboxId, `reconcile: ${error}`).catch((e) =>
        logger.error(`[drives] recording the failed reconcile of ${box.sandboxId} failed:`, { error: e instanceof Error ? e.message : String(e) }),
      );
    }
  }
}

// ─── The notes file agents read ────────────────────────────────────────────

/** Where a session's agent reads which folders it has and what needs attention. */
export const DRIVE_NOTES_PATH = '/drives/README.md';

export function renderDriveNotes(
  mounts: SessionDriveView[],
  conflicts: Array<{ mountPath: string; path: string }>,
  skippedMessage?: string | null,
): string {
  const lines = [
    '# Files in this session',
    '',
    'Folders of this project’s Files, synced both ways within seconds with the Kortix web app and every other session that mounts them.',
    'Files here outlive this sandbox. Generated by Kortix; do not edit.',
    '',
    '| Path | Folder | Access |',
    '| --- | --- | --- |',
    ...mounts.map(
      (m) => `| ${m.mountPath} | ${m.subdir}${m.role === 'me' ? ' (the user’s own folder, their desktop)' : ''} | ${m.readOnly ? 'read-only' : 'read-write'} |`,
    ),
    '',
  ];
  const me = mounts.find((m) => m.role === 'me');
  if (me) {
    lines.push(
      `${me.mountPath} is the user’s own folder (also at ~/Desktop). Save files you make for the user there.`,
      `Keep what you learn about the user in ${me.mountPath}/${MEMORY_DIR_NAME}/; what the whole team should know goes in Company/${MEMORY_DIR_NAME}/ when that folder is mounted.`,
      '',
    );
  }
  lines.push(
    'A folder that is not listed here is not available to this session. Ask the user to share it with you in Files.',
    '',
    'When two writers change the same file at the same time, both versions are kept: the other one is saved beside it as',
    '"<name> (conflict <date> <time>)<ext>". Nothing is lost. Tell the user about a conflict copy you see; do not delete it on your own.',
    '',
  );
  if (skippedMessage) {
    lines.push('## Folders that did not fit', '', `${skippedMessage} Tell the user if they ask for one of them.`, '');
  }
  if (conflicts.length) {
    lines.push('## Open conflicts', '', ...conflicts.map((c) => `- ${c.mountPath}${c.path}`), '');
  }
  return lines.join('\n');
}

/** The session's folders and the notes file that describes them. */
export async function sessionDriveNotes(sessionId: string): Promise<{ mounts: SessionDriveView[]; text: string }> {
  const mounts = await readSessionDriveMounts(sessionId);
  const ids = [...new Set(mounts.map((m) => m.driveId))];
  const open = ids.length
    ? await db
        .select({ driveId: driveConflicts.driveId, path: driveConflicts.path })
        .from(driveConflicts)
        .where(
          and(inArray(driveConflicts.driveId, ids), isNull(driveConflicts.resolvedAt), isNull(driveConflicts.dismissedAt)),
        )
        .limit(50)
    : [];
  const conflicts = open.flatMap((c) => {
    // The deepest mount that holds the copy names it.
    const m = mounts
      .filter((x) => x.driveId === c.driveId && pathWithinFolder(c.path, x.subdir || '/'))
      .sort((a, b) => (b.subdir ?? '').length - (a.subdir ?? '').length)[0];
    if (!m) return [];
    const rel = m.subdir && m.subdir !== '/' ? c.path.slice(m.subdir.length) : c.path;
    return [{ mountPath: m.mountPath, path: rel }];
  });
  const { message: skippedMessage } = await readSkippedSessionDrives(sessionId);
  return { mounts, text: renderDriveNotes(mounts, conflicts, skippedMessage) };
}

/**
 * Rewrite the session's notes file; best effort. Also links the runtime
 * user's ~/Desktop to their folder and makes its Memory folder.
 */
export async function refreshDriveNotes(sessionId: string): Promise<void> {
  try {
    const box = await liveSandbox(sessionId);
    if (!box) return;
    const { mounts, text } = await sessionDriveNotes(sessionId);
    const body = Buffer.from(text).toString('base64');
    // Writable mounts belong to the runtime user. The image's drive-owner
    // helper keeps them so; this one-shot pass covers images built before it.
    const writable = mounts.filter((m) => !m.readOnly).map((m) => `'${m.mountPath.replace(/'/g, '')}'`);
    const ownership = writable.length
      ? `id kortix >/dev/null 2>&1 && for m in ${writable.join(' ')}; do find "$m" -xdev \\( ! -user kortix -o ! -group kortix \\) ! -path "$m/lost+found*" -print0 2>/dev/null | xargs -0 -r chown -h kortix:kortix; done; `
      : '';
    const me = mounts.find((m) => m.role === 'me' && !m.readOnly);
    const desktop = me
      ? `mkdir -p '${me.mountPath}/${MEMORY_DIR_NAME}' && (id kortix >/dev/null 2>&1 && chown kortix:kortix '${me.mountPath}/${MEMORY_DIR_NAME}' || true); ` +
        `h=$(getent passwd kortix | cut -d: -f6); if [ -n "$h" ] && { [ ! -e "$h/Desktop" ] || [ -L "$h/Desktop" ]; }; then ln -sfn '${DESKTOP_MOUNT_PATH}' "$h/Desktop"; chown -h kortix:kortix "$h/Desktop" 2>/dev/null || true; fi; `
      : '';
    await execInSandbox(
      box.externalId,
      `${ownership}${desktop}mkdir -p /drives && echo ${body} | base64 -d > ${DRIVE_NOTES_PATH}.tmp && chmod 0644 ${DRIVE_NOTES_PATH}.tmp && mv ${DRIVE_NOTES_PATH}.tmp ${DRIVE_NOTES_PATH}`,
      60_000,
    );
  } catch (err) {
    logger.warn(`[drives] notes for session ${sessionId} not written:`, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * The drive is going away: take it out of every session sandbox that mounts
 * it, running or stopped, so nothing holds its volume.
 */
export async function detachDriveEverywhere(driveId: string): Promise<void> {
  const rows = await db
    .select({ sandboxId: sessionSandboxes.sandboxId, sessionId: sessionSandboxes.sessionId, provider: sessionSandboxes.provider, externalId: sessionSandboxes.externalId, metadata: sessionSandboxes.metadata })
    .from(sessionSandboxes)
    .where(sql`${sessionSandboxes.metadata} -> ${DRIVE_MOUNTS_METADATA_KEY} @> ${JSON.stringify([{ driveId }])}::jsonb`);
  for (const row of rows) {
    const mounts = recordedDriveMounts(row.metadata);
    if (row.provider === 'platinum' && row.externalId) {
      for (const m of mounts.filter((x) => x.driveId === driveId)) {
        await detachSandboxVolume(row.externalId, m.mountPath).catch((err) =>
          logger.warn(`[drives] detaching ${m.mountPath} from ${row.externalId} failed:`, { error: err instanceof Error ? err.message : String(err) }),
        );
      }
    }
    await writeRecordedMounts(row.sandboxId, mounts.filter((m) => m.driveId !== driveId));
    void refreshDriveNotes(row.sessionId);
  }
}

const ENFORCE_CONCURRENCY = 4;

/**
 * Folder access changed (a grant added, removed or changed, a member removed
 * or demoted): bring every session sandbox that mounts the drive, or of the
 * account, in line with what its session may use now:
 *
 * - a running sandbox loses a folder, gets it remounted read-only, or gains it,
 *   through Platinum hot detach/attach;
 * - a stopped sandbox has any mount it may no longer have ended, so it never
 *   comes back with more access;
 * - every later sandbox mounts the plan, which reads the grants.
 *
 * Never throws; failures are logged loudly and counted, and the next resume reconciles again.
 */
export async function enforceDriveMounts(
  scope: { driveIds: string[] } | { accountId: string } | { projectId: string } | { sandboxIds: string[] },
  opts: { progress?: EnforceProgress } = {},
): Promise<{ sessions: number; failed: number }> {
  let rows: Array<{
    sandboxId: string;
    sessionId: string;
    provider: string;
    externalId: string | null;
    status: string;
    metadata: unknown;
    accountId: string;
    projectId: string;
    createdBy: string | null;
    agentName: string;
  }>;
  try {
    const where =
      'sandboxIds' in scope
        ? scope.sandboxIds.length
          ? inArray(sessionSandboxes.sandboxId, scope.sandboxIds)
          : sql`false`
        : 'driveIds' in scope
        ? scope.driveIds.length
          ? or(
              ...scope.driveIds.map(
                (driveId) =>
                  sql`${sessionSandboxes.metadata} -> ${DRIVE_MOUNTS_METADATA_KEY} @> ${JSON.stringify([{ driveId }])}::jsonb`,
              ),
            )
          : sql`false`
        : 'projectId' in scope
          ? and(
              eq(projectSessions.projectId, scope.projectId),
              or(
                eq(sessionSandboxes.status, 'active'),
                sql`jsonb_array_length(coalesce(${sessionSandboxes.metadata} -> ${DRIVE_MOUNTS_METADATA_KEY}, '[]'::jsonb)) > 0`,
              ),
            )
          : and(
              eq(projectSessions.accountId, scope.accountId),
              sql`jsonb_array_length(coalesce(${sessionSandboxes.metadata} -> ${DRIVE_MOUNTS_METADATA_KEY}, '[]'::jsonb)) > 0`,
            );
    rows = await db
      .select({
        sandboxId: sessionSandboxes.sandboxId,
        sessionId: sessionSandboxes.sessionId,
        provider: sessionSandboxes.provider,
        externalId: sessionSandboxes.externalId,
        status: sessionSandboxes.status,
        metadata: sessionSandboxes.metadata,
        accountId: projectSessions.accountId,
        projectId: projectSessions.projectId,
        createdBy: projectSessions.createdBy,
        agentName: projectSessions.agentName,
      })
      .from(sessionSandboxes)
      .innerJoin(projectSessions, eq(projectSessions.sessionId, sessionSandboxes.sessionId))
      .where(where);
  } catch (err) {
    logger.error('[drives] finding the sessions to bring in line with folder access failed:', { error: err instanceof Error ? err.message : String(err) });
    if (opts.progress) opts.progress.failed++;
    return { sessions: 0, failed: 1 };
  }
  if (opts.progress) opts.progress.total = rows.length;
  let failed = 0;
  // A row is either brought in line (its pending revocation, if any, cleared)
  // or recorded as pending: fenced at the API and retried by the drive worker.
  const one = async (row: (typeof rows)[number]): Promise<void> => {
    const before = failed;
    try {
      await bringInLine(row);
    } catch (err) {
      failed++;
      logger.error(`[drives] REVOCATION: session ${row.sessionId} failed:`, { error: err instanceof Error ? err.message : String(err) });
    }
    const rowFailed = failed > before;
    if (opts.progress) {
      opts.progress.done++;
      if (rowFailed) opts.progress.failed++;
    }
    await (rowFailed ? recordMountRevocation(row.sandboxId, 'mounts not brought in line') : clearMountRevocation(row.sandboxId)).catch(
      (err) => logger.error(`[drives] REVOCATION: recording the state of ${row.sandboxId} failed:`, { error: err instanceof Error ? err.message : String(err) }),
    );
  };
  const bringInLine = async (row: (typeof rows)[number]): Promise<void> => {
    if (!(await sessionDrivesEnabled(row.projectId))) return;
    const base = {
      accountId: row.accountId,
      projectId: row.projectId,
      sessionId: row.sessionId,
      bootingUserId: row.createdBy,
      agentName: row.agentName,
    };
    const live =
      row.status === 'active' && ((row.provider === 'platinum' && !!row.externalId) || isDriveSyncBox(row));
    if (live) {
      const drive = await ensureProjectDrive(row.accountId, row.projectId);
      try {
        await applyDriveToRunningSandbox({ ...base, driveId: drive.driveId });
      } catch (err) {
        failed++;
        logger.error(`[drives] REVOCATION: folders could not be brought in line in running session ${row.sessionId}; retried by the drive worker:`, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    const mounts = recordedDriveMounts(row.metadata);
    if (!mounts.length) return;
    const plan = await planSessionDrives({ ...base, slots: await driveSlotsFor(row, false) });
    let kept = mounts;
    for (const m of mounts) {
      const still = plan.mounts.some((w) => (w.path === m.subdir) && (m.readOnly || !w.readOnly));
      if (still) continue;
      if (row.provider === 'platinum' && row.externalId) {
        try {
          await detachSandboxVolume(row.externalId, m.mountPath);
        } catch (err) {
          failed++;
          logger.error(`[drives] REVOCATION: ending mount ${m.mountPath} of stopped session ${row.sessionId} failed:`, { error: err instanceof Error ? err.message : String(err) });
          continue;
        }
      }
      kept = kept.filter((k) => k !== m);
    }
    if (kept.length !== mounts.length) await writeRecordedMounts(row.sandboxId, kept);
  };
  const queue = [...rows];
  await Promise.all(
    Array.from({ length: Math.min(ENFORCE_CONCURRENCY, queue.length) }, async () => {
      for (let row = queue.shift(); row; row = queue.shift()) await one(row);
    }),
  );
  return { sessions: rows.length, failed };
}

/** Live progress of one {@link enforceDriveMounts} pass, for a caller that answers before it ends. */
export interface EnforceProgress {
  total: number;
  done: number;
  failed: number;
}

const REVOCATION_RETRY_MS = 15_000;
const REVOCATION_MAX_BACKOFF_MS = 10 * 60_000;

/** Record that this sandbox still mounts more than its session may use now. */
async function recordMountRevocation(sandboxId: string, error: string): Promise<void> {
  await db
    .insert(driveMountRevocations)
    .values({ sandboxId, lastError: error.slice(0, 500), notBefore: new Date(Date.now() + REVOCATION_RETRY_MS) })
    .onConflictDoUpdate({
      target: driveMountRevocations.sandboxId,
      set: {
        attempts: sql`${driveMountRevocations.attempts} + 1`,
        lastError: error.slice(0, 500),
        notBefore: sql`now() + least(${REVOCATION_MAX_BACKOFF_MS}::int, ${REVOCATION_RETRY_MS}::int * power(2, least(${driveMountRevocations.attempts}, 10))::int) * interval '1 millisecond'`,
      },
    });
}

async function clearMountRevocation(sandboxId: string): Promise<void> {
  await db.delete(driveMountRevocations).where(eq(driveMountRevocations.sandboxId, sandboxId));
}

/** True while this sandbox has a revocation that has not reached its mounts. */
export async function mountRevocationPending(sandboxId: string): Promise<boolean> {
  const [row] = await db
    .select({ sandboxId: driveMountRevocations.sandboxId })
    .from(driveMountRevocations)
    .where(eq(driveMountRevocations.sandboxId, sandboxId))
    .limit(1);
  return !!row;
}

/**
 * Run the due revocation retries: each sandbox is brought in line again, and
 * stays recorded (with backoff) until that lands. Scheduler leader only.
 */
export async function retryMountRevocations(limit = 20): Promise<{ retried: number; failed: number }> {
  const due = await db
    .select({ sandboxId: driveMountRevocations.sandboxId })
    .from(driveMountRevocations)
    .where(lte(driveMountRevocations.notBefore, new Date()))
    .orderBy(asc(driveMountRevocations.notBefore))
    .limit(limit);
  if (!due.length) return { retried: 0, failed: 0 };
  const sandboxIds = due.map((d) => d.sandboxId);
  const result = await enforceDriveMounts({ sandboxIds });
  // A sandbox with nothing left to enforce (no mounts, gone) is in line.
  if (result.sessions < sandboxIds.length) {
    const rows = await db
      .select({ sandboxId: sessionSandboxes.sandboxId })
      .from(sessionSandboxes)
      .where(inArray(sessionSandboxes.sandboxId, sandboxIds));
    const present = new Set(rows.map((r) => r.sandboxId));
    for (const id of sandboxIds) if (!present.has(id)) await clearMountRevocation(id);
  }
  return { retried: sandboxIds.length, failed: result.failed };
}

/**
 * The recorded mounts the sync routes may honor for this sandbox. Normally
 * what it mounted; while a revocation is pending, only what the session may
 * still use now (and read-only where it lost write), so a detach that has not
 * landed yet grants nothing through the API.
 */
export async function authorizedSyncMounts(row: {
  sandboxId: string;
  sessionId: string;
  accountId: string;
  projectId: string;
  metadata: unknown;
}): Promise<RecordedDriveMount[]> {
  const mounts = recordedDriveMounts(row.metadata);
  if (!mounts.length || !(await mountRevocationPending(row.sandboxId))) return mounts;
  const [session] = await db
    .select({ createdBy: projectSessions.createdBy, agentName: projectSessions.agentName })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, row.sessionId))
    .limit(1);
  if (!session) return [];
  const plan = await planSessionDrives({
    accountId: row.accountId,
    projectId: row.projectId,
    sessionId: row.sessionId,
    bootingUserId: session.createdBy,
    agentName: session.agentName,
    slots: Number.MAX_SAFE_INTEGER,
  });
  const out: RecordedDriveMount[] = [];
  for (const m of mounts) {
    const still = plan.mounts.filter((w) => w.path === (m.subdir ?? '/'));
    if (!still.length) continue;
    out.push(m.readOnly || still.some((w) => !w.readOnly) ? m : { ...m, readOnly: true });
  }
  return out;
}

/**
 * Before a private session is shared: take every folder that reached it
 * through its person (their own folder, shares with them) out of the running
 * sandbox. False when one is still attached, so the caller keeps the session
 * private. Once shared, the session is no longer personal and its next
 * sandbox mounts none of them.
 */
export async function detachPersonalDrives(sessionId: string): Promise<boolean> {
  const row = await sessionSandboxRow(sessionId);
  const mounts = recordedDriveMounts(row?.metadata);
  const personal = mounts.filter((m) => m.role === 'me' || m.viaPerson);
  if (!row || personal.length === 0) return true;
  if (row.provider === 'platinum' && row.externalId) {
    try {
      for (const m of personal) await detachSandboxVolume(row.externalId, m.mountPath);
    } catch (err) {
      logger.warn(`[drives] detaching personal folders from session ${sessionId} failed:`, { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }
  await writeRecordedMounts(row.sandboxId, mounts.filter((m) => !personal.includes(m)));
  void refreshDriveNotes(sessionId);
  return true;
}

/**
 * A member left or was removed: every folder grant to them in the account's
 * projects goes, and their own folders pass to the account's earliest-joined
 * other owner (manage), so the files stay reachable instead of belonging to
 * nobody. Best effort; never blocks the removal.
 */
export async function releaseMemberDrives(accountId: string, userId: string): Promise<void> {
  try {
    const projectDrives = await db
      .select()
      .from(drives)
      .where(and(eq(drives.accountId, accountId), eq(drives.kind, 'project')));
    const [owner] = await db
      .select({ userId: accountMembers.userId })
      .from(accountMembers)
      .where(
        and(eq(accountMembers.accountId, accountId), eq(accountMembers.accountRole, 'owner'), ne(accountMembers.userId, userId)),
      )
      .orderBy(asc(accountMembers.joinedAt))
      .limit(1);
    for (const drive of projectDrives) {
      const grants = await listFolderGrants(drive);
      const own = personalFolderFor(grants, userId);
      if (own && owner) {
        await setFolderGrant({ drive, path: own, principal: { type: 'user', id: owner.userId }, level: 'manage', grantedBy: null, source: 'manual' });
      } else if (own) {
        logger.warn(`[drives] no owner in account ${accountId} to take over ${own} of a removed member`);
      }
      for (const g of grants) {
        if (g.principalType === 'user' && g.principalId === userId && g.grantId) {
          // Their own folder's system grant stays as the record of whose folder it was;
          // it reaches nobody once they are out of the account.
          if (g.path === own && g.source === 'system') continue;
          await removeFolderGrant(drive, g.grantId);
        }
      }
    }
  } catch (err) {
    logger.error(`[drives] releasing the folders of a removed member of ${accountId} failed:`, { error: err instanceof Error ? err.message : String(err) });
  } finally {
    await enforceDriveMounts({ accountId });
  }
}

/** Helper for the fold job and tests: every user folder grant under /Users. */
export async function personalFolderGrants(drive: DriveRow): Promise<FolderGrant[]> {
  return (await listFolderGrants(drive)).filter((g) => g.source === 'system' && g.path.startsWith(`${USERS_DIR}/`));
}

