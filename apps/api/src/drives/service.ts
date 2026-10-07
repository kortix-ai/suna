// Drive records (kortix.drives, kortix.drive_grants) and the volume each one
// owns. A row is written first; its volume is created by name the first time
// something writes to it, so listing or browsing a drive never creates storage.
//
// Every storage call addresses the volume by its deterministic name, never by
// the stored id: the name means the same volume on whichever storage account
// the API points at, and a name that does not exist there reads as an empty
// drive instead of a broken one.

import { accountMembers, driveConflicts, driveGrants, drives, projectSessions, sessionSandboxes } from '@kortix/db';
import { and, asc, count, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { projectFeatureFlagEnabled } from '../feature-flags/for-project';
import { db } from '../shared/db';
import {
  type AccountRole,
  type DriveAccess,
  type MountCandidate,
  type MountRole,
  type DriveMountPlan,
  type PlannedMount,
  FROM_AGENTS_FOLDER,
  FROM_AGENTS_MOUNT_PATH,
  accessAtLeast,
  bestGrant,
  driveAccess,
  driveMountPath,
  driveVolumeName,
  planDriveMounts,
  skippedDrivesMessage,
} from './access';
import {
  DriveStorageError,
  attachSandboxVolume,
  detachSandboxVolume,
  execInSandbox,
  driveStorageAvailable,
  getDriveVolume,
  isMissingVolume,
  openDriveVolume,
  sandboxMountLimit,
  sandboxMountPaths,
  type VolumeInfo,
} from './volumes';
import { isDriveSyncBox } from './sync';

export type DriveRow = typeof drives.$inferSelect;

export const DEFAULT_PERSONAL_DRIVE_NAME = 'My Drive';

export interface DriveJson {
  driveId: string;
  accountId: string;
  kind: string;
  name: string;
  ownerUserId: string | null;
  projectId: string | null;
  agentName: string | null;
  isDefault: boolean;
  sizeBytes: number | null;
  sizeLimitBytes: number | null;
  fileCount: number | null;
  lastChangeAt: string | null;
  createdAt: string;
  updatedAt: string;
  mountPath: string;
  /** What the caller may do: `read`, `write` (files) or `manage` (also rename, delete, grant). */
  access: Exclude<DriveAccess, 'none'>;
  /** A personal drive someone else owns and shared with the caller. */
  shared: boolean;
  /** Who shared it, for a shared drive. */
  ownerEmail?: string | null;
  /** "(conflict ...)" copies on the drive nobody resolved or dismissed yet. */
  openConflicts: number;
  /** Company drives listed for a project: that project's grant, or null when it has none. */
  projectAccess?: 'read' | 'write' | null;
  /** Company drives listed for a project: the grants to that project's agents. */
  agentGrants?: Array<{ agentName: string; access: 'read' | 'write' }>;
}

export function toDriveJson(
  drive: DriveRow,
  access: Exclude<DriveAccess, 'none'>,
  stats?: VolumeInfo | null,
  extra: {
    viewerId?: string;
    projectAccess?: 'read' | 'write' | null;
    agentGrants?: Array<{ agentName: string; access: 'read' | 'write' }>;
    openConflicts?: number;
    ownerEmail?: string | null;
  } = {},
): DriveJson {
  const role: MountRole =
    drive.kind === 'agent'
      ? 'agent'
      : drive.kind === 'personal' && drive.isDefault && drive.ownerUserId === extra.viewerId
        ? 'me'
        : 'drive';
  return {
    driveId: drive.driveId,
    accountId: drive.accountId,
    kind: drive.kind,
    name: drive.name,
    ownerUserId: drive.ownerUserId,
    projectId: drive.projectId,
    agentName: drive.agentName,
    isDefault: drive.isDefault,
    sizeBytes: stats ? Number(stats.logical_bytes ?? 0) : null,
    sizeLimitBytes: stats?.size_limit_bytes != null ? Number(stats.size_limit_bytes) : null,
    fileCount: stats ? Number(stats.file_count ?? 0) : null,
    lastChangeAt: stats?.last_commit_at ?? null,
    createdAt: drive.createdAt.toISOString(),
    updatedAt: drive.updatedAt.toISOString(),
    mountPath: driveMountPath(drive, role),
    access,
    shared: drive.kind === 'personal' && !!extra.viewerId && drive.ownerUserId !== extra.viewerId,
    openConflicts: extra.openConflicts ?? 0,
    ...(extra.ownerEmail !== undefined ? { ownerEmail: extra.ownerEmail } : {}),
    ...(extra.projectAccess !== undefined ? { projectAccess: extra.projectAccess } : {}),
    ...(extra.agentGrants !== undefined ? { agentGrants: extra.agentGrants } : {}),
  };
}

/** Account emails by user id, for naming drives people shared. */
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

/** Volume stats per drive, best effort: a slow or failed lookup reads as null. */
export async function driveStats(rows: DriveRow[]): Promise<Map<string, VolumeInfo | null>> {
  const out = new Map<string, VolumeInfo | null>();
  if (!driveStorageAvailable()) return out;
  await Promise.all(
    rows.map(async (d) => {
      if (!d.platinumVolumeId) return;
      out.set(d.driveId, await getDriveVolume(d.platinumVolumeName, AbortSignal.timeout(3_000)).catch(() => null));
    }),
  );
  return out;
}

export async function getDrive(driveId: string): Promise<DriveRow | null> {
  const [row] = await db.select().from(drives).where(eq(drives.driveId, driveId)).limit(1);
  return row ?? null;
}

async function insertDrive(values: Omit<typeof drives.$inferInsert, 'driveId' | 'platinumVolumeName'>): Promise<DriveRow | null> {
  const driveId = crypto.randomUUID();
  const [row] = await db
    .insert(drives)
    .values({ ...values, driveId, platinumVolumeName: driveVolumeName(driveId) })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

export async function ensureDefaultPersonalDrive(accountId: string, userId: string): Promise<DriveRow> {
  const find = () =>
    db
      .select()
      .from(drives)
      .where(
        and(
          eq(drives.accountId, accountId),
          eq(drives.ownerUserId, userId),
          eq(drives.kind, 'personal'),
          eq(drives.isDefault, true),
        ),
      )
      .limit(1);
  const [existing] = await find();
  if (existing) return existing;
  const created = await insertDrive({
    accountId,
    kind: 'personal',
    name: DEFAULT_PERSONAL_DRIVE_NAME,
    ownerUserId: userId,
    isDefault: true,
  });
  if (created) return created;
  // Lost the insert race to a concurrent request: that row is ours too.
  const [raced] = await find();
  if (!raced) throw new Error('default personal drive vanished after a conflicting insert');
  return raced;
}

export async function ensureAgentDrive(accountId: string, projectId: string, agentName: string): Promise<DriveRow> {
  const find = () =>
    db
      .select()
      .from(drives)
      .where(and(eq(drives.projectId, projectId), eq(drives.agentName, agentName), eq(drives.kind, 'agent')))
      .limit(1);
  const [existing] = await find();
  if (existing) return existing;
  const created = await insertDrive({ accountId, kind: 'agent', name: agentName, projectId, agentName });
  if (created) return created;
  const [raced] = await find();
  if (!raced) throw new Error('agent drive vanished after a conflicting insert');
  return raced;
}

export async function createDrive(input: {
  accountId: string;
  userId: string;
  kind: 'personal' | 'company';
  name: string;
}): Promise<DriveRow> {
  const row = await insertDrive({
    accountId: input.accountId,
    kind: input.kind,
    name: input.name,
    ownerUserId: input.kind === 'personal' ? input.userId : null,
    isDefault: false,
  });
  if (!row) throw new Error('drive insert returned no row');
  return row;
}

/**
 * Open (create when missing) the drive's volume and return the name every
 * storage call uses. The id is kept only as a marker that the volume exists.
 */
export async function openVolumeFor(drive: DriveRow, signal?: AbortSignal): Promise<string> {
  const vol = await openDriveVolume(drive.platinumVolumeName, signal);
  if (drive.platinumVolumeId !== vol.id) {
    await db
      .update(drives)
      .set({ platinumVolumeId: vol.id, updatedAt: new Date() })
      .where(eq(drives.driveId, drive.driveId));
    drive.platinumVolumeId = vol.id;
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

export interface ListedDrive {
  drive: DriveRow;
  /** The caller's share of someone else's personal drive. */
  sharedAccess?: 'read' | 'write';
  /** A company drive: the best grant that reaches the caller (see {@link accessFor}). */
  granted?: 'read' | 'write' | null;
  projectAccess?: 'read' | 'write' | null;
  agentGrants?: Array<{ agentName: string; access: 'read' | 'write' }>;
}

const asAccess = (a: string): 'read' | 'write' => (a === 'read' ? 'read' : 'write');

/**
 * What one user may see in one account: their own personal drives, personal
 * drives shared with them, and the company drives (each with the grant that
 * reaches the caller; the route drops the ones nothing reaches for a member);
 * with a project, also its agent drives, and each company drive's grants to
 * that project and its agents.
 */
export async function listDrivesFor(input: {
  accountId: string;
  userId: string;
  projectId?: string;
  grantContext?: GrantContext;
}): Promise<ListedDrive[]> {
  const { accountId, userId, projectId } = input;
  const sharedRows = await db
    .select({ driveId: driveGrants.driveId, access: driveGrants.access })
    .from(driveGrants)
    .innerJoin(drives, eq(drives.driveId, driveGrants.driveId))
    .where(
      and(
        eq(driveGrants.subjectType, 'user'),
        eq(driveGrants.userId, userId),
        eq(drives.accountId, accountId),
        eq(drives.kind, 'personal'),
        ne(drives.ownerUserId, userId),
      ),
    );
  const shared = new Map(sharedRows.map((r) => [r.driveId, asAccess(r.access)]));
  const visible = or(
    and(eq(drives.kind, 'personal'), eq(drives.ownerUserId, userId)),
    shared.size ? inArray(drives.driveId, [...shared.keys()]) : undefined,
    eq(drives.kind, 'company'),
    projectId ? and(eq(drives.kind, 'agent'), eq(drives.projectId, projectId)) : undefined,
  );
  const rows = await db
    .select()
    .from(drives)
    .where(and(eq(drives.accountId, accountId), visible))
    .orderBy(drives.createdAt);
  const companyIds = rows.filter((r) => r.kind === 'company').map((r) => r.driveId);
  const companyGrants = companyIds.length
    ? await db.select().from(driveGrants).where(inArray(driveGrants.driveId, companyIds))
    : [];
  const projectReach = projectReachCache(input.grantContext);
  const out: ListedDrive[] = [];
  for (const drive of rows) {
    const item: ListedDrive = { drive };
    const share = shared.get(drive.driveId);
    if (share) item.sharedAccess = share;
    if (drive.kind === 'company') {
      const rowsFor = companyGrants.filter((g) => g.driveId === drive.driveId);
      item.granted = await bestGrantFrom(rowsFor, userId, input.grantContext ?? {}, projectReach);
    }
    if (projectId && drive.kind === 'company') {
      const mine = companyGrants.filter((g) => g.driveId === drive.driveId && g.projectId === projectId);
      const project = mine.find((g) => g.subjectType === 'project');
      item.projectAccess = project ? asAccess(project.access) : null;
      item.agentGrants = mine
        .filter((g) => g.subjectType === 'agent' && g.agentName)
        .map((g) => ({ agentName: g.agentName!, access: asAccess(g.access) }));
    }
    out.push(item);
  }
  return out;
}

// ─── Grants ────────────────────────────────────────────────────────────────

export type GrantSubject =
  | { type: 'project'; projectId: string }
  | { type: 'user'; userId: string }
  | { type: 'agent'; projectId: string; agentName: string };

export type DriveGrantRow = typeof driveGrants.$inferSelect;

function subjectWhere(driveId: string, subject: GrantSubject) {
  const base = and(eq(driveGrants.driveId, driveId), eq(driveGrants.subjectType, subject.type));
  if (subject.type === 'project') return and(base, eq(driveGrants.projectId, subject.projectId));
  if (subject.type === 'user') return and(base, eq(driveGrants.userId, subject.userId));
  return and(base, eq(driveGrants.projectId, subject.projectId), eq(driveGrants.agentName, subject.agentName));
}

/** Upsert by subject: one grant per (drive, subject); a second call changes its access. */
export async function setDriveGrant(
  driveId: string,
  subject: GrantSubject,
  access: 'read' | 'write',
  createdBy: string | null,
): Promise<DriveGrantRow> {
  const update = () => db.update(driveGrants).set({ access }).where(subjectWhere(driveId, subject)).returning();
  const [updated] = await update();
  if (updated) return updated;
  const [inserted] = await db
    .insert(driveGrants)
    .values({
      driveId,
      subjectType: subject.type,
      projectId: subject.type === 'user' ? null : subject.projectId,
      userId: subject.type === 'user' ? subject.userId : null,
      agentName: subject.type === 'agent' ? subject.agentName : null,
      access,
      createdBy,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  // A concurrent insert of the same subject won: change that row instead.
  const [raced] = await update();
  if (!raced) throw new Error('drive grant vanished after a conflicting insert');
  return raced;
}

export async function removeDriveGrant(driveId: string, subject: GrantSubject): Promise<boolean> {
  const rows = await db.delete(driveGrants).where(subjectWhere(driveId, subject)).returning({ id: driveGrants.grantId });
  return rows.length > 0;
}

export async function listDriveGrants(driveId: string): Promise<DriveGrantRow[]> {
  return db.select().from(driveGrants).where(eq(driveGrants.driveId, driveId)).orderBy(driveGrants.createdAt);
}

/** The caller's `user` grant on a drive (a share of someone's personal drive), or null. */
export async function userGrantAccess(driveId: string, userId: string): Promise<'read' | 'write' | null> {
  const [row] = await db
    .select({ access: driveGrants.access })
    .from(driveGrants)
    .where(subjectWhere(driveId, { type: 'user', userId }))
    .limit(1);
  return row ? asAccess(row.access) : null;
}

/**
 * Where a company drive grant may reach the caller from, besides a grant to
 * them by name:
 *
 * - `session`: the session the access is for; grants to its project and to
 *   its agent count (a session's mounts and changes to them);
 * - `mayUseProject`: grants to any project the caller may run sessions in
 *   count (the drives API: such a caller reaches the drive through any of
 *   those sessions anyway). Agent grants reach people only through a session.
 */
export interface GrantContext {
  session?: { projectId: string; agentName: string };
  mayUseProject?: (projectId: string) => Promise<boolean>;
}

function projectReachCache(ctx: GrantContext | undefined): (projectId: string) => Promise<boolean> {
  const seen = new Map<string, Promise<boolean>>();
  return (projectId) => {
    if (ctx?.session?.projectId === projectId) return Promise.resolve(true);
    if (!ctx?.mayUseProject) return Promise.resolve(false);
    let hit = seen.get(projectId);
    if (!hit) {
      hit = ctx.mayUseProject(projectId).catch(() => false);
      seen.set(projectId, hit);
    }
    return hit;
  };
}

/** The best of a company drive's grants that reaches this user in this context. */
async function bestGrantFrom(
  rows: DriveGrantRow[],
  userId: string,
  ctx: GrantContext,
  reach: (projectId: string) => Promise<boolean> = projectReachCache(ctx),
): Promise<'read' | 'write' | null> {
  let best: 'read' | 'write' | null = null;
  // Write grants first: once one reaches the caller nothing else can add to it.
  const ordered = [...rows].sort((a, b) => (a.access === 'write' ? 0 : 1) - (b.access === 'write' ? 0 : 1));
  for (const g of ordered) {
    if (best === 'write' || (best === 'read' && g.access === 'read')) break;
    const access = asAccess(g.access);
    let reaches = false;
    if (g.subjectType === 'user') reaches = g.userId === userId;
    else if (g.subjectType === 'agent') {
      reaches = !!ctx.session && g.projectId === ctx.session.projectId && g.agentName === ctx.session.agentName;
    } else if (g.subjectType === 'project' && g.projectId) reaches = await reach(g.projectId);
    if (reaches) best = bestGrant(best, access);
  }
  return best;
}

/**
 * The caller's access to a drive, from their role in its account and the
 * grants that reach them: a share of a personal drive, or for a company drive
 * a grant to them, or (see {@link GrantContext}) to a project or agent they
 * work through. A member with no grant has no access to a company drive.
 */
export async function accessFor(
  drive: DriveRow,
  userId: string,
  accountRole: AccountRole | null,
  ctx: GrantContext = {},
): Promise<DriveAccess> {
  let granted: 'read' | 'write' | null = null;
  if (drive.kind === 'personal' && drive.ownerUserId !== userId) {
    granted = await userGrantAccess(drive.driveId, userId);
  } else if (drive.kind === 'company' && accountRole && accountRole !== 'owner' && accountRole !== 'admin') {
    granted = await bestGrantFrom(await listDriveGrants(drive.driveId), userId, ctx);
  }
  return driveAccess(drive, { userId, accountRole, granted });
}

// ─── Session mounts ────────────────────────────────────────────────────────

/** One drive mount as a session's sandbox has it, recorded at boot and on every attach/detach. */
export interface RecordedDriveMount {
  driveId: string;
  kind: 'personal' | 'agent' | 'company';
  mountPath: string;
  readOnly: boolean;
  /** Only this folder of the drive is mounted (the "From agents" mount). */
  subdir?: string;
  /** The writable "From agents" folder of the session owner's drive. */
  fromAgents?: boolean;
  role?: MountRole;
}

export interface SkippedDrive {
  driveId: string;
  name: string;
}

export interface SessionDriveMounts {
  /** The Platinum create body's `volumes`, keyed by mount path. */
  volumes: Record<string, { volume: string; read_only?: boolean; subdir?: string }>;
  mounts: RecordedDriveMount[];
  /** How many volume mounts the sandbox had for drives. */
  slots: number;
  /** Drives the session should have that did not fit in the sandbox's mount slots. */
  skipped: SkippedDrive[];
}

/** The sandbox metadata key the boot writes the actual mounts to. */
export const DRIVE_MOUNTS_METADATA_KEY = 'driveMounts';
/** The sandbox metadata key for the drives that did not fit at boot. */
export const DRIVE_SKIPPED_METADATA_KEY = 'driveMountsSkipped';
/** The sandbox metadata key for how many mounts the boot had for drives. */
export const DRIVE_SLOTS_METADATA_KEY = 'driveMountSlots';

/**
 * A drive change that would take the session past the volume mounts a sandbox
 * may have. Nothing changed; `message` is user-facing.
 */
export class DriveMountLimitError extends DriveStorageError {
  constructor(readonly limit: number) {
    super(
      409,
      `This session already mounts as many drives as it can (${limit}). Take a drive out of the session first.`,
      'drive_mount_limit',
    );
    this.name = 'DriveMountLimitError';
  }
}
/** The project_sessions metadata key for what people changed about a session's drives. */
export const SESSION_DRIVE_PREFS_KEY = 'drives';

/**
 * A drive the session must mount could not be mounted. The session never
 * starts without its drives: provisioning fails with this message instead.
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

/**
 * What people changed about one session's drives, kept on the session so
 * every new sandbox of it (a restart, an ephemeral wake) mounts the same set:
 *
 * - `attached`: drives someone attached by hand, and who did;
 * - `detached`: drives the rules mount that someone took out;
 * - `modes`: a read or write override, and who set it (full write on the
 *   session owner's drive is a `write` override).
 */
export interface SessionDrivePrefs {
  attached: Array<{ driveId: string; by: string }>;
  detached: string[];
  modes: Record<string, { access: 'read' | 'write'; by: string }>;
}

export function sessionDrivePrefs(metadata: unknown): SessionDrivePrefs {
  const raw = (metadata as Record<string, unknown> | null | undefined)?.[SESSION_DRIVE_PREFS_KEY] as
    | Partial<SessionDrivePrefs>
    | undefined;
  return {
    attached: Array.isArray(raw?.attached)
      ? raw!.attached.filter((a) => a && typeof a.driveId === 'string' && typeof a.by === 'string')
      : [],
    detached: Array.isArray(raw?.detached) ? raw!.detached.filter((d) => typeof d === 'string') : [],
    modes: raw?.modes && typeof raw.modes === 'object' ? (raw.modes as SessionDrivePrefs['modes']) : {},
  };
}

/** Change a session's drive prefs; returns what they were before, or null without a session. */
async function updateSessionDrivePrefs(
  sessionId: string,
  change: (prefs: SessionDrivePrefs) => void,
): Promise<SessionDrivePrefs | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ metadata: projectSessions.metadata })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId))
      .for('update')
      .limit(1);
    if (!row) return null;
    const before = sessionDrivePrefs(row.metadata);
    const prefs = sessionDrivePrefs(row.metadata);
    change(prefs);
    await tx
      .update(projectSessions)
      .set({
        metadata: sql`coalesce(${projectSessions.metadata}, '{}'::jsonb) || ${JSON.stringify({ [SESSION_DRIVE_PREFS_KEY]: prefs })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(projectSessions.sessionId, sessionId));
    return before;
  });
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
 * that same person. Only such a session mounts that person's drives.
 */
export function isPersonalSession(session: SessionFacts | null, bootingUserId: string | null): boolean {
  if (!session || !session.createdBy) return false;
  if (session.origin !== 'user' || session.visibility !== 'private') return false;
  const source = (session.metadata as Record<string, unknown> | null)?.source;
  if (typeof source === 'string' && CHAT_SOURCES.has(source)) return false;
  return session.createdBy === bootingUserId;
}

async function roleOf(userId: string, accountId: string): Promise<AccountRole | null> {
  const [m] = await db
    .select({ role: accountMembers.accountRole })
    .from(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)))
    .limit(1);
  return (m?.role as AccountRole | undefined) ?? null;
}

/**
 * The drives a new sandbox of this session mounts, by rule:
 *
 * - in a personal session (see {@link isPersonalSession}): the owner's
 *   default drive, read-only with its "From agents" folder writable beside it
 *   (full write when the owner opted in for this session or this agent), and
 *   every drive shared with or granted to the owner;
 * - always: the session agent's drive, and the company drives granted to the
 *   project or to the session agent;
 * - then the session's own changes: drives attached by hand (while whoever
 *   attached them can still use them, with this session's grants), minus
 *   drives taken out.
 *
 * `slots` is how many volume mounts the sandbox has for drives. When they do
 * not all fit, they mount in this order and the rest come back in `skipped`:
 * the owner's drive (and its "From agents" folder), the agent drive, drives
 * granted to the agent, to the project, shared with the owner, then drives
 * attached by hand in the order they were attached.
 */
export async function planSessionDrives(input: {
  accountId: string;
  projectId: string;
  sessionId: string;
  bootingUserId: string | null;
  agentName: string;
  slots?: number;
}): Promise<DriveMountPlan<DriveRow>> {
  const { accountId, projectId, sessionId, agentName } = input;
  const session = await sessionFacts(sessionId);
  const personal = isPersonalSession(session, input.bootingUserId);
  // Someone who left the account takes no drive of it into a session.
  const owner = personal && (await roleOf(session!.createdBy!, accountId)) ? session!.createdBy! : null;
  const grantContext: GrantContext = { session: { projectId, agentName } };
  const prefs = sessionDrivePrefs(session?.metadata);
  const candidates: MountCandidate<DriveRow>[] = [];

  if (owner) {
    const mine = await ensureDefaultPersonalDrive(accountId, owner);
    const agentOptIn = await db
      .select({ access: driveGrants.access })
      .from(driveGrants)
      .where(subjectWhere(mine.driveId, { type: 'agent', projectId, agentName }))
      .limit(1);
    candidates.push({ drive: mine, readOnly: agentOptIn[0]?.access !== 'write', role: 'me' });
  }
  candidates.push({ drive: await ensureAgentDrive(accountId, projectId, agentName), readOnly: false, role: 'agent' });

  const subjects = [
    and(eq(driveGrants.subjectType, 'project'), eq(driveGrants.projectId, projectId)),
    and(eq(driveGrants.subjectType, 'agent'), eq(driveGrants.projectId, projectId), eq(driveGrants.agentName, agentName)),
    owner ? and(eq(driveGrants.subjectType, 'user'), eq(driveGrants.userId, owner)) : undefined,
  ];
  const granted = await db
    .select({ drive: drives, access: driveGrants.access, subjectType: driveGrants.subjectType })
    .from(driveGrants)
    .innerJoin(drives, eq(drives.driveId, driveGrants.driveId))
    .where(and(eq(drives.accountId, accountId), or(...subjects)))
    .orderBy(driveGrants.createdAt);
  const sharers = await userEmails(
    granted.filter((g) => g.drive.kind === 'personal').map((g) => g.drive.ownerUserId ?? ''),
  );
  for (const g of granted) {
    // A personal drive reaches a session only through its owner's share
    // with the session owner; a project or agent grant never carries one.
    if (g.drive.kind === 'personal' && (g.subjectType !== 'user' || g.drive.ownerUserId === owner)) continue;
    if (g.drive.kind === 'agent') continue;
    const priority = g.subjectType === 'agent' ? 0 : g.subjectType === 'project' ? 1 : 2;
    candidates.push({ drive: sharedNamed(g.drive, sharers), readOnly: g.access === 'read', role: 'drive', priority });
  }

  if (prefs.attached.length) {
    const rows = await db
      .select()
      .from(drives)
      .where(and(eq(drives.accountId, accountId), inArray(drives.driveId, prefs.attached.map((a) => a.driveId))));
    for (const [i, a] of prefs.attached.entries()) {
      const drive = rows.find((r) => r.driveId === a.driveId);
      if (!drive) continue;
      // A personal drive (own or shared) only ever mounts in its holder's personal session.
      if (drive.kind === 'personal' && a.by !== owner) continue;
      const access = await accessFor(drive, a.by, await roleOf(a.by, accountId), grantContext);
      if (!accessAtLeast(access, 'read')) continue;
      const role: MountRole = drive.kind === 'personal' && drive.isDefault && drive.ownerUserId === owner ? 'me' : 'drive';
      const named =
        drive.kind === 'personal' && drive.ownerUserId !== owner
          ? sharedNamed(drive, await userEmails([drive.ownerUserId ?? '']))
          : drive;
      candidates.push({ drive: named, readOnly: !accessAtLeast(access, 'write') || role === 'me', role, priority: 100 + i });
    }
  }

  const detached = new Set(prefs.detached);
  const kept: MountCandidate<DriveRow>[] = [];
  for (const c of candidates) {
    if (detached.has(c.drive.driveId)) continue;
    const mode = prefs.modes[c.drive.driveId];
    if (mode?.access === 'read') {
      kept.push({ ...c, readOnly: true });
    } else if (mode?.access === 'write') {
      const access = await accessFor(c.drive, mode.by, await roleOf(mode.by, accountId), grantContext);
      const ownDrive = c.role !== 'me' || mode.by === owner;
      kept.push({ ...c, readOnly: c.readOnly && !(ownDrive && accessAtLeast(access, 'write')) });
    } else {
      kept.push(c);
    }
  }
  return planDriveMounts(kept, input.slots);
}

/** A personal drive shared by someone else mounts under its owner's handle: /drives/ana-my-drive. */
function sharedNamed(drive: DriveRow, emails: Map<string, string>): DriveRow {
  if (drive.kind !== 'personal') return drive;
  const handle = (emails.get(drive.ownerUserId ?? '') ?? '').split('@')[0];
  return handle ? { ...drive, name: `${handle} ${drive.name}` } : drive;
}

const OPEN_TIMEOUT_MS = 8_000;

function toRecorded(p: PlannedMount<DriveRow>): RecordedDriveMount {
  return {
    driveId: p.drive.driveId,
    kind: p.drive.kind as RecordedDriveMount['kind'],
    mountPath: p.mountPath,
    readOnly: p.readOnly,
    role: p.role,
    ...(p.subdir ? { subdir: p.subdir } : {}),
    ...(p.fromAgents ? { fromAgents: true } : {}),
  };
}

/**
 * The drives a new sandbox of this session mounts (see
 * {@link planSessionDrives}), with their volumes opened, or undefined when
 * the project has no drives. Strict: a drive whose volume does not open
 * fails the boot with a {@link DriveMountError}; a session never starts
 * without its drives. Admission: every volume counts against Platinum's
 * per-sandbox mount limit; `reservedSlots` are the sandbox's other volumes
 * (the session's state volume). Drives past the limit are left out by
 * priority and returned in `skipped`, which the session shows people.
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
  const planned = plan.mounts;
  const skipped = plan.skipped.map((d) => ({ driveId: d.driveId, name: d.name }));
  if (skipped.length) {
    console.warn(
      `[drives] session ${input.sessionId}: ${skipped.length} drive(s) past the ${slots} mount slots left out: ${skipped.map((d) => d.driveId).join(', ')}`,
    );
  }
  const failed: Array<{ name: string; code?: string }> = [];
  // Three tries over ~10 s ride out a storage blip; then the boot fails, loudly.
  const openWithRetry = async (drive: DriveRow): Promise<string> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await openVolumeFor(drive, AbortSignal.timeout(OPEN_TIMEOUT_MS));
      } catch (err) {
        if (attempt >= 3 || (err instanceof DriveStorageError && err.code === 'quota_exceeded')) throw err;
        await new Promise((r) => setTimeout(r, attempt * 2_000));
      }
    }
  };
  const opened = await Promise.all(
    planned.map((p) =>
      openWithRetry(p.drive).catch((err) => {
        console.warn(
          `[drives] volume for drive ${p.drive.driveId} did not open:`,
          err instanceof Error ? err.message : err,
        );
        failed.push({ name: p.drive.name, code: err instanceof DriveStorageError ? err.code : undefined });
        return null;
      }),
    ),
  );
  if (failed.length) {
    const names = [...new Set(failed.map((f) => f.name))];
    const quota = failed.find((f) => f.code === 'quota_exceeded');
    throw new DriveMountError(
      quota
        ? `This session’s drives could not be mounted (${names.join(', ')}): the workspace reached its drive storage limit. ` +
            'The session did not start without them. Delete a drive you no longer need, or ask Kortix for more.'
        : `This session’s drives could not be mounted (${names.join(', ')}): drive storage is not reachable right now. ` +
            'The session did not start without them. Try again in a minute.',
      names,
    );
  }
  const out: SessionDriveMounts = { volumes: {}, mounts: [], skipped, slots };
  planned.forEach((p, i) => {
    out.volumes[p.mountPath] = {
      volume: opened[i]!,
      ...(p.readOnly ? { read_only: true } : {}),
      ...(p.subdir ? { subdir: p.subdir } : {}),
    };
    out.mounts.push(toRecorded(p));
  });
  return out.mounts.length || out.skipped.length ? out : undefined;
}

/** Drives mount in this project's sessions: storage configured, the operator switch on, the project flag on. */
export async function sessionDrivesEnabled(projectId: string): Promise<boolean> {
  if (!sessionDriveMountEnabled()) return false;
  return projectFeatureFlagEnabled(projectId, 'drives');
}

/** Operator kill switch: KORTIX_DRIVES_SESSION_MOUNT=off boots every session without drives. */
export function sessionDriveMountEnabled(): boolean {
  if (!driveStorageAvailable()) return false;
  const raw = (process.env.KORTIX_DRIVES_SESSION_MOUNT ?? '').trim().toLowerCase();
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
  name: string;
  openConflicts: number;
  /** Set for a personal drive someone shared into the session. */
  ownerEmail?: string;
}

/** The drives the session's current sandbox mounts, with their current names and open conflicts. */
export async function readSessionDriveMounts(sessionId: string): Promise<SessionDriveView[]> {
  const row = await sessionSandboxRow(sessionId);
  const mounts = recordedDriveMounts(row?.metadata);
  if (!mounts.length) return [];
  const ids = [...new Set(mounts.map((m) => m.driveId))];
  const rows = await db
    .select({ driveId: drives.driveId, name: drives.name, ownerUserId: drives.ownerUserId })
    .from(drives)
    .where(inArray(drives.driveId, ids));
  const byId = new Map(rows.map((d) => [d.driveId, d]));
  const shared = mounts.filter((m) => m.kind === 'personal' && m.role === 'drive');
  const emails = await userEmails(shared.map((m) => byId.get(m.driveId)?.ownerUserId ?? ''));
  const conflicts = await openConflictCounts(ids);
  return mounts.flatMap((m) => {
    const row = byId.get(m.driveId);
    if (!row) return [];
    const ownerEmail = m.kind === 'personal' && m.role === 'drive' ? emails.get(row.ownerUserId ?? '') : undefined;
    return [{ ...m, name: row.name, openConflicts: conflicts.get(m.driveId) ?? 0, ...(ownerEmail ? { ownerEmail } : {}) }];
  });
}

/** Drives the session's current sandbox should have but did not fit at its boot, and the message for them. */
export async function readSkippedSessionDrives(
  sessionId: string,
): Promise<{ skipped: SkippedDrive[]; message: string | null }> {
  const row = await sessionSandboxRow(sessionId);
  const md = row?.metadata as Record<string, unknown> | null | undefined;
  const raw = md?.[DRIVE_SKIPPED_METADATA_KEY];
  const recorded = Array.isArray(raw)
    ? raw.filter((d): d is SkippedDrive => !!d && typeof d.driveId === 'string' && typeof d.name === 'string')
    : [];
  // A drive mounted since (a slot freed and someone attached it) is no longer missing.
  const mounted = new Set(recordedDriveMounts(md).map((m) => m.driveId));
  const skipped = recorded.filter((d) => !mounted.has(d.driveId));
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

/** The live box of a session whose drives are synced in (a provider other than Platinum). */
async function liveSyncSandbox(sessionId: string) {
  const row = await sessionSandboxRow(sessionId);
  if (!row || row.status !== 'active' || !isDriveSyncBox(row)) return null;
  return row;
}

/**
 * A synced box has nothing to attach: its record is what the box's daemon
 * syncs and what the sync routes authorize, so rewriting it is the change.
 * The daemon picks it up on its next poll (a few seconds).
 */
async function applyDriveToSyncedSandbox(
  box: { sandboxId: string; externalId: string | null; provider: string; metadata: unknown },
  input: Omit<Parameters<typeof planSessionDrives>[0], 'slots'> & { driveId: string },
): Promise<{ live: boolean; flushed?: boolean }> {
  const current = recordedDriveMounts(box.metadata);
  // Synced boxes keep the same per-session drive count as mounted ones.
  const slots = await driveSlotsFor({ externalId: null, metadata: box.metadata }, false);
  const plan = await planSessionDrives({ ...input, slots });
  const want = plan.mounts.filter((p) => p.drive.driveId === input.driveId);
  const had = current.some((m) => m.driveId === input.driveId);
  if (!had && plan.skipped.some((d) => d.driveId === input.driveId)) throw new DriveMountLimitError(slots);
  let kept = current.filter((m) => m.driveId !== input.driveId);
  if (want.length) {
    if (kept.length + want.length > slots) throw new DriveMountLimitError(slots);
    await openVolumeFor(want[0]!.drive, AbortSignal.timeout(OPEN_TIMEOUT_MS));
    const used = new Set(kept.map((m) => m.mountPath));
    for (const w of want) {
      const mountPath = w.fromAgents ? FROM_AGENTS_MOUNT_PATH : freeMountPath(driveMountPath(w.drive, w.role), used);
      used.add(mountPath);
      kept = [...kept, toRecorded({ ...w, mountPath })];
    }
  }
  // A writable copy of this drive is leaving the box or turning read-only:
  // push what the box has not sent yet while the record still allows it. If
  // the push does not complete, the daemon keeps the copy aside rather than
  // delete it (drive-sync/index.ts), so nothing is lost either way.
  const losesWrite = current.some(
    (m) =>
      m.driveId === input.driveId &&
      !m.readOnly &&
      !want.some((w) => !w.readOnly && (w.subdir ?? '') === (m.subdir ?? '')),
  );
  let flushed: boolean | undefined;
  if (losesWrite && box.externalId) {
    const { flushDriveSyncBeforeStop } = await import('../projects/reaping/stop-box');
    flushed = await flushDriveSyncBeforeStop({
      sandboxId: box.sandboxId,
      externalId: box.externalId,
      provider: box.provider,
      metadata: box.metadata,
      driveId: input.driveId,
    });
  }
  await writeRecordedMounts(box.sandboxId, kept);
  return { live: true, ...(flushed === undefined ? {} : { flushed }) };
}

function freeMountPath(base: string, used: Set<string>): string {
  let path = base;
  for (let n = 2; used.has(path); n++) path = `${base}-${n}`;
  return path;
}

/**
 * How many volume mounts a session's sandbox has for drives: Platinum's
 * per-sandbox limit minus its volumes that are not drives (the session's
 * state volume). A running sandbox is asked; otherwise what its boot recorded.
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

/**
 * Bring the running sandbox's mounts of one drive in line with what the
 * session's plan says now: detach what the plan no longer has (a revoked
 * drive), remount what changed access (read-only after a downgrade), attach
 * what it gained. Other drives' mounts are left alone. A session that is not
 * running only records the change; its next sandbox mounts the plan.
 *
 * Admission: a drive that would take the sandbox past its mount limit is
 * refused with a {@link DriveMountLimitError} before anything changes.
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
  const want = plan.mounts.filter((p) => p.drive.driveId === input.driveId);
  const have = current.filter((m) => m.driveId === input.driveId);
  const same =
    want.length === have.length &&
    want.every((w) => have.some((h) => h.readOnly === w.readOnly && (h.subdir ?? '') === (w.subdir ?? '') && !!h.fromAgents === !!w.fromAgents));
  // The plan wants the drive but has no slot for it: refuse, never a silent no-op.
  if (!have.length && plan.skipped.some((d) => d.driveId === input.driveId)) throw new DriveMountLimitError(slots);
  if (same) return { live: true };

  let kept = current.filter((m) => m.driveId !== input.driveId);
  if (want.length && kept.length + want.length > slots) throw new DriveMountLimitError(slots);
  for (const m of have) {
    await detachSandboxVolume(box.externalId, m.mountPath);
  }
  await writeRecordedMounts(box.sandboxId, kept);
  if (want.length) {
    const volume = await openVolumeFor(want[0]!.drive, AbortSignal.timeout(OPEN_TIMEOUT_MS));
    const used = new Set(kept.map((m) => m.mountPath));
    for (const w of want) {
      const mountPath = w.fromAgents ? FROM_AGENTS_MOUNT_PATH : freeMountPath(driveMountPath(w.drive, w.role), used);
      used.add(mountPath);
      await attachSandboxVolume(box.externalId, mountPath, { volume, readOnly: w.readOnly, subdir: w.subdir });
      kept = [...kept, toRecorded({ ...w, mountPath })];
      await writeRecordedMounts(box.sandboxId, kept);
    }
  }
  // Awaited: the ownership pass inside makes a newly writable mount writable
  // for the agent by the time the caller hears back.
  await refreshDriveNotes(input.sessionId);
  return { live: true };
}

export type SessionDriveChange =
  | { type: 'attach'; driveId: string; by: string; access: 'read' | 'write' }
  | { type: 'detach'; driveId: string }
  | { type: 'mode'; driveId: string; access: 'read' | 'write'; by: string };

/**
 * Attach a drive to a session, take one out, or change one's access, now and
 * for every later sandbox of the session. The caller checked who may.
 */
export async function changeSessionDrive(input: {
  accountId: string;
  projectId: string;
  sessionId: string;
  agentName: string;
  sessionOwner: string | null;
  change: SessionDriveChange;
}): Promise<{ live: boolean }> {
  const { change } = input;
  const before = await updateSessionDrivePrefs(input.sessionId, (prefs) => {
    if (change.type === 'attach') {
      prefs.detached = prefs.detached.filter((d) => d !== change.driveId);
      if (!prefs.attached.some((a) => a.driveId === change.driveId)) {
        prefs.attached.push({ driveId: change.driveId, by: change.by });
      }
      prefs.modes[change.driveId] = { access: change.access, by: change.by };
    } else if (change.type === 'detach') {
      prefs.attached = prefs.attached.filter((a) => a.driveId !== change.driveId);
      if (!prefs.detached.includes(change.driveId)) prefs.detached.push(change.driveId);
      delete prefs.modes[change.driveId];
    } else {
      prefs.modes[change.driveId] = { access: change.access, by: change.by };
    }
  });
  const target = {
    accountId: input.accountId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    driveId: change.driveId,
    // Hot changes keep the boot's notion of whose session it is.
    bootingUserId: input.sessionOwner,
    agentName: input.agentName,
  };
  try {
    if (change.type === 'attach' && !(await liveSandbox(input.sessionId))) {
      // Not running: the attach must still fit the next sandbox, or it is refused now.
      const slots = await driveSlotsFor(await sessionSandboxRow(input.sessionId), false);
      const plan = await planSessionDrives({ ...target, slots });
      if (plan.skipped.some((d) => d.driveId === change.driveId)) throw new DriveMountLimitError(slots);
    }
    return await applyDriveToRunningSandbox(target);
  } catch (err) {
    // A refused attach leaves the session as it was.
    if (err instanceof DriveMountLimitError && before) {
      await updateSessionDrivePrefs(input.sessionId, (prefs) => Object.assign(prefs, before));
    }
    throw err;
  }
}

/**
 * After a sandbox came back (a resume of the same VM keeps the mounts it had
 * at its stop): bring its mounts in line with the session's plan, which may
 * have changed while it slept (a drive attached, detached or granted). Best effort.
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
    const box = (await liveSandbox(sessionId)) ?? (await liveSyncSandbox(sessionId));
    if (!box) return;
    const base = {
      accountId: row.accountId,
      projectId: row.projectId,
      sessionId,
      bootingUserId: row.createdBy,
      agentName: row.agentName,
    };
    const plan = await planSessionDrives({ ...base, slots: await driveSlotsFor(box, true) });
    const ids = new Set([...plan.mounts.map((p) => p.drive.driveId), ...recordedDriveMounts(box.metadata).map((m) => m.driveId)]);
    for (const driveId of ids) {
      await applyDriveToRunningSandbox({ ...base, driveId }).catch((err) =>
        console.warn(`[drives] reconciling drive ${driveId} in session ${sessionId} failed:`, err instanceof Error ? err.message : err),
      );
    }
    await refreshDriveNotes(sessionId);
  } catch (err) {
    console.warn(`[drives] reconciling the drives of session ${sessionId} failed:`, err instanceof Error ? err.message : err);
  }
}

// ─── The notes file agents read ────────────────────────────────────────────

/** Where a session's agent reads which drives it has and what needs attention. */
export const DRIVE_NOTES_PATH = '/drives/README.md';

export function renderDriveNotes(
  mounts: SessionDriveView[],
  conflicts: Array<{ mountPath: string; path: string }>,
  skippedMessage?: string | null,
): string {
  const lines = [
    '# Drives in this session',
    '',
    'Kortix Drive folders, synced both ways within seconds with the Kortix web app and every other session that mounts them.',
    'Files here outlive this sandbox. Generated by Kortix; do not edit.',
    '',
    '| Path | Drive | Access |',
    '| --- | --- | --- |',
    ...mounts.map(
      (m) =>
        `| ${m.mountPath} | ${m.fromAgents ? `${m.name}, "From agents" folder` : m.ownerEmail ? `${m.name}, shared by ${m.ownerEmail}` : m.name} | ${m.readOnly ? 'read-only' : 'read-write'} |`,
    ),
    '',
  ];
  const me = mounts.find((m) => m.role === 'me' && !m.fromAgents);
  if (me?.readOnly && mounts.some((m) => m.fromAgents)) {
    lines.push(
      `${me.mountPath} is the user's own drive and is read-only. Save files for the user in ${FROM_AGENTS_MOUNT_PATH}: it is the "From agents" folder of that drive.`,
      '',
    );
  }
  lines.push(
    'When two writers change the same file at the same time, both versions are kept: the other one is saved beside it as',
    '"<name> (conflict <date> <time>)<ext>". Nothing is lost. Tell the user about a conflict copy you see; do not delete it on your own.',
    '',
  );
  if (skippedMessage) {
    lines.push('## Drives that did not fit', '', `${skippedMessage} Tell the user if they ask for one of them.`, '');
  }
  if (conflicts.length) {
    lines.push('## Open conflicts', '', ...conflicts.map((c) => `- ${c.mountPath}${c.path}`), '');
  }
  return lines.join('\n');
}

/** The session's drives and the notes file that describes them. */
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
    const m = mounts.find((x) => x.driveId === c.driveId && !x.subdir);
    return m ? [{ mountPath: m.mountPath, path: c.path }] : [];
  });
  const { message: skippedMessage } = await readSkippedSessionDrives(sessionId);
  return { mounts, text: renderDriveNotes(mounts, conflicts, skippedMessage) };
}

/** Rewrite the session's notes file; best effort. */
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
    await execInSandbox(
      box.externalId,
      `${ownership}mkdir -p /drives && echo ${body} | base64 -d > ${DRIVE_NOTES_PATH}.tmp && chmod 0644 ${DRIVE_NOTES_PATH}.tmp && mv ${DRIVE_NOTES_PATH}.tmp ${DRIVE_NOTES_PATH}`,
      60_000,
    );
  } catch (err) {
    console.warn(`[drives] notes for session ${sessionId} not written:`, err instanceof Error ? err.message : err);
  }
}

/**
 * A drive is going away: take it out of every session sandbox that mounts it,
 * running or stopped (Platinum ends a stopped sandbox's mount at once), so
 * nothing holds its volume and no sandbox comes back with it.
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
          console.warn(`[drives] detaching drive ${driveId} from ${row.externalId} failed:`, err instanceof Error ? err.message : err),
        );
      }
    }
    await writeRecordedMounts(row.sandboxId, mounts.filter((m) => m.driveId !== driveId));
    void refreshDriveNotes(row.sessionId);
  }
}

const ENFORCE_CONCURRENCY = 4;

/**
 * Access to drives narrowed: a grant removed or lowered, a share removed, a
 * member removed or demoted. Bring every session sandbox that mounts one of
 * them back in line with what its session may have now, at once:
 *
 * - a running sandbox loses the drive, or has it remounted read-only, through
 *   Platinum hot detach/attach;
 * - a stopped sandbox has the mount ended (or, for a downgrade, taken out so
 *   its resume mounts it read-only), so it never comes back with more access;
 * - every later sandbox mounts the session's plan, which reads the grants.
 *
 * `driveIds` scopes it to those drives; `accountId` to every drive mounted in
 * the account's sessions. Never throws; failures are logged loudly and
 * counted, and the next resume reconciles again.
 */
export async function enforceDriveMounts(
  scope: { driveIds: string[] } | { accountId: string },
): Promise<{ sessions: number; failed: number }> {
  const scoped = 'driveIds' in scope ? new Set(scope.driveIds) : null;
  if (scoped && !scoped.size) return { sessions: 0, failed: 0 };
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
      .where(
        scoped
          ? or(
              ...[...scoped].map(
                (driveId) =>
                  sql`${sessionSandboxes.metadata} -> ${DRIVE_MOUNTS_METADATA_KEY} @> ${JSON.stringify([{ driveId }])}::jsonb`,
              ),
            )
          : and(
              eq(projectSessions.accountId, (scope as { accountId: string }).accountId),
              sql`jsonb_array_length(coalesce(${sessionSandboxes.metadata} -> ${DRIVE_MOUNTS_METADATA_KEY}, '[]'::jsonb)) > 0`,
            ),
      );
  } catch (err) {
    console.error('[drives] finding the sessions that mount a revoked drive failed:', err);
    return { sessions: 0, failed: 1 };
  }
  let failed = 0;
  const one = async (row: (typeof rows)[number]) => {
    const base = {
      accountId: row.accountId,
      projectId: row.projectId,
      sessionId: row.sessionId,
      bootingUserId: row.createdBy,
      agentName: row.agentName,
    };
    const mounts = recordedDriveMounts(row.metadata);
    const ids = [...new Set(mounts.map((m) => m.driveId))].filter((id) => !scoped || scoped.has(id));
    // A running synced box goes the live way too: it keeps a downgraded drive
    // read-only and pushes what it has not sent before losing write access.
    const live =
      row.status === 'active' && ((row.provider === 'platinum' && !!row.externalId) || isDriveSyncBox(row));
    if (live) {
      for (const driveId of ids) {
        try {
          await applyDriveToRunningSandbox({ ...base, driveId });
        } catch (err) {
          failed++;
          console.error(
            `[drives] REVOCATION: drive ${driveId} could not be brought in line in running session ${row.sessionId}; it reconciles on the next resume:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      return;
    }
    const plan = await planSessionDrives({ ...base, slots: await driveSlotsFor(row, false) });
    let kept = mounts;
    for (const m of mounts) {
      if (!ids.includes(m.driveId)) continue;
      const still = plan.mounts.some(
        (w) => w.drive.driveId === m.driveId && (w.subdir ?? '') === (m.subdir ?? '') && (m.readOnly || !w.readOnly),
      );
      if (still) continue;
      if (row.provider === 'platinum' && row.externalId) {
        try {
          await detachSandboxVolume(row.externalId, m.mountPath);
        } catch (err) {
          failed++;
          console.error(
            `[drives] REVOCATION: ending mount ${m.mountPath} of stopped session ${row.sessionId} failed:`,
            err instanceof Error ? err.message : err,
          );
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
      for (let row = queue.shift(); row; row = queue.shift()) {
        await one(row).catch((err) => {
          failed++;
          console.error(`[drives] REVOCATION: session ${row!.sessionId} failed:`, err);
        });
      }
    }),
  );
  return { sessions: rows.length, failed };
}

/**
 * Before a private session is shared: take every person-scoped drive (the
 * owner's own and anything shared with or attached by them) out of the running
 * sandbox. False when one is still attached, so the caller keeps the session
 * private rather than share it with the drive in it. Once shared, the session
 * is no longer personal and its next sandbox mounts none of them.
 */
export async function detachPersonalDrives(sessionId: string): Promise<boolean> {
  const row = await sessionSandboxRow(sessionId);
  const mounts = recordedDriveMounts(row?.metadata);
  const ids = [...new Set(mounts.map((m) => m.driveId))];
  const kinds = ids.length
    ? new Map(
        (await db.select({ driveId: drives.driveId, kind: drives.kind }).from(drives).where(inArray(drives.driveId, ids))).map(
          (d) => [d.driveId, d.kind],
        ),
      )
    : new Map<string, string>();
  const personal = mounts.filter((m) => m.kind === 'personal' || kinds.get(m.driveId) === 'personal');
  if (!row || personal.length === 0) return true;
  if (row.provider === 'platinum' && row.externalId) {
    try {
      for (const m of personal) await detachSandboxVolume(row.externalId, m.mountPath);
    } catch (err) {
      console.warn(
        `[drives] detaching the personal drive from session ${sessionId} failed:`,
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }
  await writeRecordedMounts(row.sandboxId, mounts.filter((m) => !personal.includes(m)));
  void refreshDriveNotes(sessionId);
  return true;
}

/**
 * A member left or was removed: their personal drives in that account move to
 * an account owner, so the files stay reachable (and deletable) instead of
 * belonging to nobody. Best effort; never blocks the removal.
 */
export async function releaseMemberDrives(accountId: string, userId: string): Promise<void> {
  try {
    // What was shared with them in this account goes with their membership.
    const accountDrives = db.select({ id: drives.driveId }).from(drives).where(eq(drives.accountId, accountId));
    await db
      .delete(driveGrants)
      .where(
        and(eq(driveGrants.subjectType, 'user'), eq(driveGrants.userId, userId), inArray(driveGrants.driveId, accountDrives)),
      );
    const owned = await db
      .select()
      .from(drives)
      .where(and(eq(drives.accountId, accountId), eq(drives.ownerUserId, userId), eq(drives.kind, 'personal')));
    if (!owned.length) return;
    const [owner] = await db
      .select({ userId: accountMembers.userId })
      .from(accountMembers)
      .where(
        and(eq(accountMembers.accountId, accountId), eq(accountMembers.accountRole, 'owner'), ne(accountMembers.userId, userId)),
      )
      .orderBy(asc(accountMembers.joinedAt))
      .limit(1);
    if (!owner) {
      console.warn(`[drives] no owner in account ${accountId} to take over ${owned.length} drive(s) of a removed member`);
      return;
    }
    const rows = (await db.execute(sql`SELECT email FROM auth.users WHERE id = ${userId}::uuid LIMIT 1`)) as unknown as Array<{
      email: string | null;
    }>;
    const from = rows?.[0]?.email?.trim() || 'former member';
    // Their shares and agent opt-ins were theirs to give; the new holder starts clean.
    await db.delete(driveGrants).where(inArray(driveGrants.driveId, owned.map((d) => d.driveId)));
    for (const drive of owned) {
      await db
        .update(drives)
        .set({
          ownerUserId: owner.userId,
          isDefault: false,
          name: `${drive.name} (${from})`.slice(0, 80),
          updatedAt: new Date(),
        })
        .where(eq(drives.driveId, drive.driveId));
    }
  } catch (err) {
    console.error(`[drives] handing over the drives of a removed member of ${accountId} failed:`, err);
  } finally {
    // What they shared, attached or reached by role leaves running sessions now.
    await enforceDriveMounts({ accountId });
  }
}
