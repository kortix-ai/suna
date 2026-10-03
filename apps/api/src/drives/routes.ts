// /v1/drives: drives a user owns or shares with their account, their files
// and their history. Every route below the list resolves the drive first and
// answers 404 for a drive the caller may not see, so a drive id is never an
// oracle for another user's personal drive.

import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requireFeatureFlag } from '../feature-flags/gate';
import { combinedAuth } from '../middleware/auth';
import { rejectSandboxTokens } from '../middleware/reject-sandbox-tokens';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import { loadProjectForUser } from '../projects/lib/access';
import { getAccountMembership } from '../projects/lib/git';
import { db } from '../shared/db';
import { resolveScopedAccountId } from '../shared/resolve-account';
import { isUuid } from '../shared/validate';
import type { AppEnv } from '../types';
import { accountMembers, driveConflicts, driveGrants, drives, projects } from '@kortix/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { type AccountRole, type DriveAccess, accessAtLeast, driveAccess, normalizeDrivePath } from './access';
import {
  type DriveRow,
  type GrantSubject,
  accessFor,
  createDrive,
  detachDriveEverywhere,
  driveStats,
  enforceDriveMounts,
  ensureDefaultPersonalDrive,
  getDrive,
  listDriveGrants,
  listDrivesFor,
  openConflictCounts,
  readDriveVolume,
  userEmails,
  removeDriveGrant,
  setDriveGrant,
  toDriveJson,
  writeDriveVolume,
} from './service';
import { noteDriveWrite } from './conflicts';
import {
  DriveStorageError,
  deleteDriveVolume,
  getDriveVolume,
  listVolumeCommits,
  listVolumeFiles,
  moveVolumeFile,
  readVolumeFile,
  removeVolumeFile,
  restoreVolume,
  writeVolumeFile,
  type VolumeCommit,
} from './volumes';

export const MAX_DRIVE_UPLOAD_BYTES = 64 * 1024 * 1024;
/** The empty file that holds an otherwise empty folder in place. */
const FOLDER_MARKER = '.keep';

type DriveContext = Context<AppEnv>;

const DriveSchema = z
  .object({
    driveId: z.string(),
    accountId: z.string(),
    kind: z.enum(['personal', 'agent', 'company']),
    name: z.string(),
    ownerUserId: z.string().nullable(),
    projectId: z.string().nullable(),
    agentName: z.string().nullable(),
    isDefault: z.boolean(),
    sizeBytes: z.number().nullable(),
    sizeLimitBytes: z.number().nullable(),
    fileCount: z.number().nullable(),
    lastChangeAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    mountPath: z.string(),
    access: z.enum(['read', 'write', 'manage']),
    shared: z.boolean(),
    ownerEmail: z.string().nullable().optional(),
    openConflicts: z.number(),
    projectAccess: z.enum(['read', 'write']).nullable().optional(),
    agentGrants: z.array(z.object({ agentName: z.string(), access: z.enum(['read', 'write']) })).optional(),
  })
  .openapi('Drive');

const DriveGrantSchema = z
  .object({
    grantId: z.string(),
    type: z.enum(['project', 'user', 'agent']),
    projectId: z.string().nullable(),
    projectName: z.string().nullable(),
    userId: z.string().nullable(),
    userEmail: z.string().nullable(),
    agentName: z.string().nullable(),
    access: z.enum(['read', 'write']),
    createdAt: z.string(),
  })
  .openapi('DriveGrant');

const DriveConflictSchema = z
  .object({
    conflictId: z.string(),
    path: z.string(),
    originalPath: z.string(),
    detectedAt: z.string(),
  })
  .openapi('DriveConflict');

const DriveEntrySchema = z
  .object({
    path: z.string(),
    name: z.string(),
    type: z.enum(['file', 'dir', 'symlink']),
    size: z.number(),
    mtime: z.number(),
  })
  .openapi('DriveEntry');

const DriveVersionSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    kind: z.enum(['created', 'edit', 'sync', 'restore']),
    author: z.enum(['drive', 'session', 'system']),
    changes: z.object({ changed: z.number(), deleted: z.number() }),
  })
  .openapi('DriveVersion');

const DriveName = z.string().trim().min(1).max(80);
const DriveParams = z.object({ driveId: z.string() });
const PathQuery = z.object({ path: z.string().optional() });

function fail(status: 400 | 403 | 404 | 409 | 413 | 503, message: string, code?: string): never {
  throw new HTTPException(status, {
    message,
    res: new Response(JSON.stringify({ error: true, message, status, ...(code ? { code } : {}) }), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  });
}

function callerId(c: DriveContext): string {
  const userId = c.get('userId');
  if (!userId) fail(403, 'Drives require a signed-in user');
  return userId;
}

async function roleIn(userId: string, accountId: string): Promise<AccountRole | null> {
  const m = await getAccountMembership(userId, accountId);
  return (m?.accountRole as AccountRole | undefined) ?? null;
}

/** Project access as a yes or no: the loader answers a refusal with its own 403. */
async function mayUseProject(c: DriveContext, projectId: string, action: 'read' | 'session' | 'write') {
  try {
    return !!(await loadProjectForUser(c, projectId, action));
  } catch (err) {
    if (err instanceof HTTPException && (err.status === 403 || err.status === 404)) return false;
    throw err;
  }
}

/**
 * The drive and the caller's access to it; a drive the caller cannot see is a
 * 404. An agent drive belongs to its project as well as the account: reading
 * it needs read access to that project, changing its files needs the right to
 * run the project's sessions (which can already change them through the agent).
 * A company drive reaches a member only through a grant: to them, or to a
 * project they may run sessions in; read or write as granted. A drive granted
 * or shared read-only answers 403 to a write.
 */
async function loadDrive(c: DriveContext, need: Exclude<DriveAccess, 'none'> = 'write') {
  const userId = callerId(c);
  const driveId = c.req.param('driveId') ?? '';
  const drive = isUuid(driveId) ? await getDrive(driveId) : null;
  if (!drive) fail(404, 'Drive not found');
  const access = await accessFor(drive, userId, await roleIn(userId, drive.accountId), {
    mayUseProject: (projectId) => mayUseProject(c, projectId, 'session'),
  });
  if (access === 'none') fail(404, 'Drive not found');
  if (drive.kind === 'agent') {
    if (!drive.projectId || !(await mayUseProject(c, drive.projectId, 'read'))) fail(404, 'Drive not found');
    if (need !== 'read' && !(await mayUseProject(c, drive.projectId, need === 'manage' ? 'write' : 'session'))) {
      fail(403, 'You cannot change this project’s agent drive');
    }
  }
  if (need === 'manage' && access !== 'manage') {
    fail(403, drive.kind === 'personal' ? 'Only the drive’s owner can change this drive' : 'Only an account admin can change this drive');
  }
  if (need === 'write' && !accessAtLeast(access, 'write')) {
    fail(403, drive.kind === 'company' ? 'This drive is granted to you read-only' : 'This drive is shared with you read-only');
  }
  return { drive, userId, access };
}

function drivePath(raw: string | undefined, opts: { allowRoot: boolean }): string {
  const path = normalizeDrivePath(raw);
  if (!path || (!opts.allowRoot && path === '/')) fail(400, 'Invalid path');
  return path;
}

async function withStorage<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DriveStorageError) fail(err.status, err.message, err.code);
    throw err;
  }
}

async function driveJson(drive: DriveRow, access: Exclude<DriveAccess, 'none'>, viewerId: string) {
  const stats = drive.platinumVolumeId
    ? await getDriveVolume(drive.platinumVolumeName, AbortSignal.timeout(3_000)).catch(() => null)
    : null;
  const conflicts = await openConflictCounts([drive.driveId]);
  return toDriveJson(drive, access, stats, { viewerId, openConflicts: conflicts.get(drive.driveId) ?? 0 });
}

const notFound = (): never => fail(404, 'File or folder not found');

const baseName = (p: string) => p.split('/').filter(Boolean).pop() ?? '';

function versionKind(kind: string): z.infer<typeof DriveVersionSchema>['kind'] {
  if (kind === 'init' || kind === 'fork') return 'created';
  if (kind === 'restore') return 'restore';
  if (kind === 'api' || kind === 'import') return 'edit';
  return 'sync';
}

function versionAuthor(commit: VolumeCommit): z.infer<typeof DriveVersionSchema>['author'] {
  if (commit.author?.kind === 'sandbox' || commit.kind === 'merge' || commit.kind === 'fast') return 'session';
  if (commit.author?.kind === 'api_key' || commit.author?.kind === 'user') return 'drive';
  return 'system';
}

export const drivesApp = makeOpenApiApp<AppEnv>();

drivesApp.use('*', combinedAuth);
// An agent's own drive reaches it as a mount; its sandbox token has no reason
// to browse the account's drives over the API.
drivesApp.use('*', rejectSandboxTokens);
drivesApp.use('*', async (c, next) => {
  if (c.get('authType') === 'pat' && c.get('sessionId')) fail(403, 'Session tokens cannot access drives');
  await next();
});

// GET /v1/drives
drivesApp.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['drives'],
    summary: 'List the caller’s drives',
    description:
      'Creates the caller’s default personal drive on first use. With `projectId`, also lists that project’s agent drives and marks each company drive with its grant to the project.',
    ...auth,
    request: { query: z.object({ projectId: z.string().optional(), account_id: z.string().optional() }) },
    responses: { 200: json(z.object({ drives: z.array(DriveSchema) }), 'Drives'), ...errors(401, 403, 404) },
  }),
  async (c: any) => {
    const userId = callerId(c);
    const projectId = c.req.query('projectId');
    let accountId: string;
    if (projectId) {
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) fail(404, 'Project not found');
      const gate = requireFeatureFlag(c, loaded.row.metadata, 'drives');
      if (gate) return gate;
      accountId = loaded.row.accountId;
    } else {
      accountId = c.get('accountId') ?? (await resolveScopedAccountId(c, 'query'));
    }
    const role = await roleIn(userId, accountId);
    if (!role) fail(403, 'You do not have access to this account');
    await ensureDefaultPersonalDrive(accountId, userId);
    const listed = await listDrivesFor({
      accountId,
      userId,
      projectId: projectId || undefined,
      grantContext: { mayUseProject: (id) => mayUseProject(c, id, 'session') },
    });
    const [stats, conflicts, owners] = await Promise.all([
      driveStats(listed.map((l) => l.drive)),
      openConflictCounts(listed.map((l) => l.drive.driveId)),
      userEmails(listed.filter((l) => l.sharedAccess).map((l) => l.drive.ownerUserId ?? '')),
    ]);
    return c.json({
      drives: listed.flatMap((l) => {
        const access = driveAccess(l.drive, { userId, accountRole: role, granted: l.sharedAccess ?? l.granted ?? null });
        return access === 'none'
          ? []
          : [
              toDriveJson(l.drive, access, stats.get(l.drive.driveId) ?? null, {
                viewerId: userId,
                openConflicts: conflicts.get(l.drive.driveId) ?? 0,
                ...(l.sharedAccess ? { ownerEmail: owners.get(l.drive.ownerUserId ?? '') ?? null } : {}),
                ...(l.projectAccess !== undefined ? { projectAccess: l.projectAccess } : {}),
                ...(l.agentGrants !== undefined ? { agentGrants: l.agentGrants } : {}),
              }),
            ];
      }),
    });
  },
);

// POST /v1/drives
drivesApp.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['drives'],
    summary: 'Create a drive',
    description: 'A `company` drive needs an account owner or admin. `account_id` picks the account (default: the caller’s primary).',
    ...auth,
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              name: DriveName,
              kind: z.enum(['personal', 'company']),
              account_id: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: { 201: json(DriveSchema, 'Created drive'), ...errors(400, 401, 403) },
  }),
  async (c: any) => {
    const userId = callerId(c);
    const body = c.req.valid('json') as { name: string; kind: 'personal' | 'company' };
    const accountId = c.get('accountId') ?? (await resolveScopedAccountId(c, 'body'));
    const role = await roleIn(userId, accountId);
    if (!role) fail(403, 'You do not have access to this account');
    if (body.kind === 'company' && role !== 'owner' && role !== 'admin') {
      fail(403, 'Only an account owner or admin can create a company drive');
    }
    const drive = await createDrive({ accountId, userId, kind: body.kind, name: body.name });
    const access = driveAccess(drive, { userId, accountRole: role });
    return c.json(toDriveJson(drive, access === 'none' ? 'write' : access, null, { viewerId: userId }), 201);
  },
);

// PATCH /v1/drives/:driveId
drivesApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{driveId}',
    tags: ['drives'],
    summary: 'Rename a drive',
    ...auth,
    request: {
      params: DriveParams,
      body: { required: true, content: { 'application/json': { schema: z.object({ name: DriveName }) } } },
    },
    responses: { 200: json(DriveSchema, 'Drive'), ...errors(400, 401, 403, 404) },
  }),
  async (c: any) => {
    const { drive, access, userId } = await loadDrive(c, 'manage');
    const { name } = c.req.valid('json') as { name: string };
    const [row] = await db
      .update(drives)
      .set({ name, updatedAt: new Date() })
      .where(eq(drives.driveId, drive.driveId))
      .returning();
    return c.json(await driveJson(row!, access, userId));
  },
);

// DELETE /v1/drives/:driveId
drivesApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{driveId}',
    tags: ['drives'],
    summary: 'Delete a drive and its files',
    description:
      'A default personal drive cannot be deleted. The drive is taken out of every session that mounts it first; its storage is removed in the background.',
    ...auth,
    request: { params: DriveParams },
    responses: { 204: { description: 'Deleted' }, ...errors(401, 403, 404, 409) },
  }),
  async (c: any) => {
    const { drive } = await loadDrive(c, 'manage');
    if (drive.kind === 'personal' && drive.isDefault) fail(409, 'Your default drive cannot be deleted');
    await detachDriveEverywhere(drive.driveId);
    if (drive.platinumVolumeId) {
      // Storage that is still held (a mount mid-detach) goes later: the row's
      // delete trigger queued the volume, and the drive worker retries it.
      await deleteDriveVolume(drive.platinumVolumeName).catch((err) =>
        console.warn(`[drives] volume of deleted drive ${drive.driveId} left for the cleanup worker:`, err?.message ?? err),
      );
    }
    await db.delete(drives).where(eq(drives.driveId, drive.driveId));
    return c.body(null, 204);
  },
);

// GET /v1/drives/:driveId/grants
drivesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{driveId}/grants',
    tags: ['drives'],
    summary: 'List where a drive is granted',
    description: 'Projects, people and agents the drive mounts for. Needs manage access to the drive.',
    ...auth,
    request: { params: DriveParams },
    responses: { 200: json(z.object({ grants: z.array(DriveGrantSchema) }), 'Grants'), ...errors(401, 403, 404) },
  }),
  async (c: any) => {
    const { drive } = await loadDrive(c, 'manage');
    return c.json({ grants: await grantsJson(drive.driveId) });
  },
);

const GrantBody = z.object({
  type: z.enum(['project', 'user', 'agent']).optional(),
  projectId: z.string().optional(),
  userId: z.string().optional(),
  agentName: z.string().trim().min(1).max(128).optional(),
  access: z.enum(['read', 'write']).optional(),
});

// POST /v1/drives/:driveId/grants
drivesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{driveId}/grants',
    tags: ['drives'],
    summary: 'Grant a drive to a project, a person or an agent',
    description:
      'A company drive (account owner or admin): `project` mounts it in every session of the project, `user` in every session that person starts, `agent` in every session of that agent. ' +
      'A personal drive (its owner): `user` shares it with a colleague (read or write), `agent` with `write` lets that agent write the whole drive in the owner’s sessions. ' +
      'Granting the same subject again changes its access. `type` defaults to `project`, `access` to `write`.',
    ...auth,
    request: {
      params: DriveParams,
      body: { required: true, content: { 'application/json': { schema: GrantBody } } },
    },
    responses: { 200: json(DriveGrantSchema, 'Grant'), ...errors(400, 401, 403, 404) },
  }),
  async (c: any) => {
    const { drive, userId } = await loadDrive(c, 'manage');
    const body = c.req.valid('json') as z.infer<typeof GrantBody>;
    const type = body.type ?? 'project';
    const access = body.access ?? 'write';
    if (drive.kind === 'agent') fail(400, 'An agent drive is not granted; attach it to a session instead');
    if (drive.kind === 'personal' && type === 'project') fail(400, 'A personal drive mounts only in its owner’s sessions; share it with a person instead');
    if (drive.kind === 'personal' && type === 'agent' && access !== 'write') {
      fail(400, 'Agents already read your drive in your sessions; an agent grant on it is for full write');
    }
    let subject: GrantSubject;
    if (type === 'user') {
      if (!body.userId || !isUuid(body.userId)) fail(400, 'userId is required');
      if (body.userId === drive.ownerUserId) fail(400, 'The owner already has this drive');
      const [member] = await db
        .select({ userId: accountMembers.userId })
        .from(accountMembers)
        .where(and(eq(accountMembers.accountId, drive.accountId), eq(accountMembers.userId, body.userId)))
        .limit(1);
      if (!member) fail(404, 'That person is not a member of this account');
      subject = { type: 'user', userId: body.userId };
    } else {
      if (!body.projectId || !isUuid(body.projectId)) fail(400, 'projectId is required');
      const [project] = await db
        .select({ accountId: projects.accountId })
        .from(projects)
        .where(eq(projects.projectId, body.projectId))
        .limit(1);
      if (!project || project.accountId !== drive.accountId) fail(404, 'Project not found');
      if (type === 'agent') {
        if (!body.agentName) fail(400, 'agentName is required');
        subject = { type: 'agent', projectId: body.projectId, agentName: body.agentName };
      } else {
        subject = { type: 'project', projectId: body.projectId };
      }
    }
    const row = await setDriveGrant(drive.driveId, subject, access, userId);
    // A downgrade to read takes write away from running sessions now.
    if (access === 'read') await enforceDriveMounts({ driveIds: [drive.driveId] });
    const [json] = (await grantsJson(drive.driveId)).filter((g) => g.grantId === row.grantId);
    return c.json(json!);
  },
);

// DELETE /v1/drives/:driveId/grants/:grantId
drivesApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{driveId}/grants/{grantId}',
    tags: ['drives'],
    summary: 'Remove a grant',
    description:
      'Sessions that no longer reach the drive lose it at once: running sandboxes unmount it (or remount it read-only when another grant still gives read), and later ones never mount it.',
    ...auth,
    request: { params: z.object({ driveId: z.string(), grantId: z.string() }) },
    responses: { 204: { description: 'Removed' }, ...errors(401, 403, 404) },
  }),
  async (c: any) => {
    const { drive } = await loadDrive(c, 'manage');
    const grantId = c.req.param('grantId');
    if (!isUuid(grantId)) fail(404, 'Grant not found');
    const rows = await db
      .delete(driveGrants)
      .where(and(eq(driveGrants.driveId, drive.driveId), eq(driveGrants.grantId, grantId)))
      .returning({ id: driveGrants.grantId });
    if (!rows.length) fail(404, 'Grant not found');
    await enforceDriveMounts({ driveIds: [drive.driveId] });
    return c.body(null, 204);
  },
);

// DELETE /v1/drives/:driveId/grants?projectId=... (and userId / agentName)
drivesApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{driveId}/grants',
    tags: ['drives'],
    summary: 'Remove the grant to one subject',
    description: 'Like removing a grant by id: sessions that no longer reach the drive lose it at once.',
    ...auth,
    request: {
      params: DriveParams,
      query: z.object({ projectId: z.string().optional(), userId: z.string().optional(), agentName: z.string().optional() }),
    },
    responses: { 204: { description: 'Removed' }, ...errors(400, 401, 403, 404) },
  }),
  async (c: any) => {
    const { drive } = await loadDrive(c, 'manage');
    const projectId = c.req.query('projectId');
    const userId = c.req.query('userId');
    const agentName = c.req.query('agentName');
    let subject: GrantSubject;
    if (userId && isUuid(userId)) subject = { type: 'user', userId };
    else if (projectId && isUuid(projectId) && agentName) subject = { type: 'agent', projectId, agentName };
    else if (projectId && isUuid(projectId)) subject = { type: 'project', projectId };
    else fail(400, 'Name the subject: projectId, userId, or projectId with agentName');
    if (!(await removeDriveGrant(drive.driveId, subject))) fail(404, 'Grant not found');
    await enforceDriveMounts({ driveIds: [drive.driveId] });
    return c.body(null, 204);
  },
);

async function grantsJson(driveId: string): Promise<Array<z.infer<typeof DriveGrantSchema>>> {
  const rows = await listDriveGrants(driveId);
  const projectIds = [...new Set(rows.map((r) => r.projectId).filter((p): p is string => !!p))];
  const userIds = [...new Set(rows.map((r) => r.userId).filter((u): u is string => !!u))];
  const names = new Map(
    projectIds.length
      ? (
          await db.select({ id: projects.projectId, name: projects.name }).from(projects).where(inArray(projects.projectId, projectIds))
        ).map((p) => [p.id, p.name])
      : [],
  );
  const emails = new Map<string, string | null>();
  if (userIds.length) {
    const found = (await db.execute(
      sql`SELECT id::text AS id, email FROM auth.users WHERE id = ANY(${`{${userIds.join(',')}}`}::uuid[])`,
    )) as unknown as Array<{ id: string; email: string | null }>;
    for (const u of found) emails.set(u.id, u.email);
  }
  return rows.map((r) => ({
    grantId: r.grantId,
    type: r.subjectType as 'project' | 'user' | 'agent',
    projectId: r.projectId,
    projectName: r.projectId ? (names.get(r.projectId) ?? null) : null,
    userId: r.userId,
    userEmail: r.userId ? (emails.get(r.userId) ?? null) : null,
    agentName: r.agentName,
    access: r.access === 'read' ? 'read' : 'write',
    createdAt: r.createdAt.toISOString(),
  }));
}

// GET /v1/drives/:driveId/conflicts
drivesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{driveId}/conflicts',
    tags: ['drives'],
    summary: 'List open conflict copies',
    description:
      'Files Kortix kept beside the original when two writers changed it at once, named `<name> (conflict <date> <time>)<ext>`. A copy leaves this list when it is deleted or renamed, or when someone dismisses it.',
    ...auth,
    request: { params: DriveParams },
    responses: { 200: json(z.object({ conflicts: z.array(DriveConflictSchema) }), 'Open conflicts'), ...errors(401, 404) },
  }),
  async (c: any) => {
    const { drive } = await loadDrive(c, 'read');
    const rows = await db
      .select()
      .from(driveConflicts)
      .where(and(eq(driveConflicts.driveId, drive.driveId), isNull(driveConflicts.resolvedAt), isNull(driveConflicts.dismissedAt)))
      .orderBy(driveConflicts.detectedAt);
    return c.json({
      conflicts: rows.map((r) => ({
        conflictId: r.conflictId,
        path: r.path,
        originalPath: r.originalPath,
        detectedAt: r.detectedAt.toISOString(),
      })),
    });
  },
);

// POST /v1/drives/:driveId/conflicts/:conflictId/dismiss
drivesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{driveId}/conflicts/{conflictId}/dismiss',
    tags: ['drives'],
    summary: 'Dismiss a conflict notice',
    description: 'Hides the notice and keeps the copy on the drive.',
    ...auth,
    request: { params: z.object({ driveId: z.string(), conflictId: z.string() }) },
    responses: { 204: { description: 'Dismissed' }, ...errors(401, 403, 404) },
  }),
  async (c: any) => {
    const { drive, userId } = await loadDrive(c);
    const conflictId = c.req.param('conflictId');
    if (!isUuid(conflictId)) fail(404, 'Conflict not found');
    const rows = await db
      .update(driveConflicts)
      .set({ dismissedAt: new Date(), dismissedBy: userId })
      .where(and(eq(driveConflicts.driveId, drive.driveId), eq(driveConflicts.conflictId, conflictId)))
      .returning({ id: driveConflicts.conflictId });
    if (!rows.length) fail(404, 'Conflict not found');
    return c.body(null, 204);
  },
);

// GET /v1/drives/:driveId/files
drivesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{driveId}/files',
    tags: ['drives'],
    summary: 'List a folder',
    ...auth,
    request: { params: DriveParams, query: PathQuery },
    responses: { 200: json(z.object({ entries: z.array(DriveEntrySchema) }), 'Folder entries'), ...errors(400, 401, 404, 503) },
  }),
  async (c: any) => {
    const { drive } = await loadDrive(c, 'read');
    const path = drivePath(c.req.query('path'), { allowRoot: true });
    const entries = await withStorage(() =>
      readDriveVolume(drive, (volume) => listVolumeFiles(volume, path, false), () => []),
    );
    return c.json({
      entries: entries
        .filter((e) => !(e.type === 'file' && baseName(e.path) === FOLDER_MARKER && Number(e.size) === 0))
        // The filesystem's own recovery folder is not a drive folder.
        .filter((e) => !(e.type === 'dir' && e.path === '/lost+found'))
        .map((e) => ({ path: e.path, name: baseName(e.path), type: e.type, size: Number(e.size ?? 0), mtime: Number(e.mtime ?? 0) })),
    });
  },
);

// GET /v1/drives/:driveId/files/content
drivesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{driveId}/files/content',
    tags: ['drives'],
    summary: 'Download a file',
    description: 'Raw bytes. `download=1` adds `Content-Disposition: attachment`. Honors `Range`.',
    ...auth,
    request: { params: DriveParams, query: z.object({ path: z.string(), download: z.string().optional() }) },
    responses: {
      200: { description: 'File bytes', content: { 'application/octet-stream': { schema: z.any() } } },
      206: { description: 'Partial file bytes', content: { 'application/octet-stream': { schema: z.any() } } },
      ...errors(400, 401, 404, 503),
    },
  }),
  async (c: any) => {
    const { drive } = await loadDrive(c, 'read');
    const path = drivePath(c.req.query('path'), { allowRoot: false });
    const upstream = await withStorage(() =>
      readDriveVolume(drive, (volume) => readVolumeFile(volume, path, c.req.header('range') ?? undefined), notFound),
    );
    const headers = new Headers({
      'content-type': 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    });
    for (const h of ['content-length', 'content-range', 'etag', 'accept-ranges']) {
      const value = upstream.headers.get(h);
      if (value) headers.set(h, value);
    }
    const download = c.req.query('download');
    if (download === '1' || download === 'true') {
      headers.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(baseName(path))}`);
    }
    return new Response(upstream.body, { status: upstream.status === 206 ? 206 : 200, headers });
  },
);

// PUT /v1/drives/:driveId/files/content
drivesApp.openapi(
  createRoute({
    method: 'put',
    path: '/{driveId}/files/content',
    tags: ['drives'],
    summary: 'Upload a file',
    description: `Raw request body, at most ${MAX_DRIVE_UPLOAD_BYTES} bytes. Replaces an existing file at the path.`,
    ...auth,
    request: { params: DriveParams, query: z.object({ path: z.string() }) },
    responses: {
      200: json(z.object({ path: z.string(), size: z.number() }), 'Uploaded'),
      ...errors(400, 401, 404, 409, 413, 503),
    },
  }),
  async (c: any) => {
    const { drive } = await loadDrive(c);
    const path = drivePath(c.req.query('path'), { allowRoot: false });
    const declared = Number(c.req.header('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > MAX_DRIVE_UPLOAD_BYTES) fail(413, 'File is too large');
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength > MAX_DRIVE_UPLOAD_BYTES) fail(413, 'File is too large');
    const written = await withStorage(() =>
      writeDriveVolume(drive, (volume) => writeVolumeFile(volume, path, body, { overwrite: true })),
    );
    noteDriveWrite(drive.driveId);
    return c.json({ path: written.path, size: written.size });
  },
);

// POST /v1/drives/:driveId/files/mkdir
drivesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{driveId}/files/mkdir',
    tags: ['drives'],
    summary: 'Create a folder',
    ...auth,
    request: {
      params: DriveParams,
      body: { required: true, content: { 'application/json': { schema: z.object({ path: z.string() }) } } },
    },
    responses: { 200: json(z.object({ path: z.string() }), 'Folder'), ...errors(400, 401, 404, 409, 503) },
  }),
  async (c: any) => {
    const { drive } = await loadDrive(c);
    const path = drivePath((c.req.valid('json') as { path: string }).path, { allowRoot: false });
    await withStorage(() =>
      writeDriveVolume(drive, (volume) =>
        writeVolumeFile(volume, `${path}/${FOLDER_MARKER}`, new Uint8Array(), { overwrite: false }),
      ),
    );
    return c.json({ path });
  },
);

// POST /v1/drives/:driveId/files/move
drivesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{driveId}/files/move',
    tags: ['drives'],
    summary: 'Move or rename a file or folder',
    description: 'Refuses to overwrite: an existing destination answers 409.',
    ...auth,
    request: {
      params: DriveParams,
      body: { required: true, content: { 'application/json': { schema: z.object({ from: z.string(), to: z.string() }) } } },
    },
    responses: { 200: json(z.object({ from: z.string(), to: z.string() }), 'Moved'), ...errors(400, 401, 404, 409, 503) },
  }),
  async (c: any) => {
    const { drive } = await loadDrive(c);
    const body = c.req.valid('json') as { from: string; to: string };
    const from = drivePath(body.from, { allowRoot: false });
    const to = drivePath(body.to, { allowRoot: false });
    if (to === from || to.startsWith(`${from}/`)) fail(400, 'A folder cannot be moved into itself');
    await withStorage(() => readDriveVolume(drive, (volume) => moveVolumeFile(volume, from, to), notFound));
    noteDriveWrite(drive.driveId);
    return c.json({ from, to });
  },
);

// DELETE /v1/drives/:driveId/files
drivesApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{driveId}/files',
    tags: ['drives'],
    summary: 'Delete a file or folder',
    description: 'A folder with contents needs `recursive=true`.',
    ...auth,
    request: { params: DriveParams, query: z.object({ path: z.string(), recursive: z.string().optional() }) },
    responses: { 204: { description: 'Deleted' }, ...errors(400, 401, 404, 409, 503) },
  }),
  async (c: any) => {
    const { drive } = await loadDrive(c);
    const path = drivePath(c.req.query('path'), { allowRoot: false });
    const recursive = c.req.query('recursive') === 'true' || c.req.query('recursive') === '1';
    await withStorage(() => readDriveVolume(drive, (volume) => removeVolumeFile(volume, path, recursive), notFound));
    noteDriveWrite(drive.driveId);
    return c.body(null, 204);
  },
);

// GET /v1/drives/:driveId/versions
drivesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{driveId}/versions',
    tags: ['drives'],
    summary: 'List a drive’s versions, newest first',
    ...auth,
    request: { params: DriveParams },
    responses: { 200: json(z.object({ versions: z.array(DriveVersionSchema) }), 'Versions'), ...errors(401, 404, 503) },
  }),
  async (c: any) => {
    const { drive } = await loadDrive(c, 'read');
    const commits = await withStorage(() => readDriveVolume(drive, (volume) => listVolumeCommits(volume), () => []));
    return c.json({
      versions: commits.map((commit) => ({
        id: commit.id,
        createdAt: commit.created_at,
        kind: versionKind(commit.kind),
        author: versionAuthor(commit),
        changes: {
          changed: Number(commit.stats?.changed_paths ?? 0),
          deleted: Number(commit.stats?.deleted_paths ?? 0),
        },
      })),
    });
  },
);

// POST /v1/drives/:driveId/restore
drivesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{driveId}/restore',
    tags: ['drives'],
    summary: 'Restore a drive to a version',
    description: 'Adds a new version whose files equal the chosen one. Later versions stay in the history.',
    ...auth,
    request: {
      params: DriveParams,
      body: { required: true, content: { 'application/json': { schema: z.object({ versionId: z.string().min(1) }) } } },
    },
    responses: { 200: json(DriveSchema, 'Drive'), ...errors(400, 401, 404, 503) },
  }),
  async (c: any) => {
    const { drive, access, userId } = await loadDrive(c);
    const { versionId } = c.req.valid('json') as { versionId: string };
    if (versionId === 'head' || !/^[A-Za-z0-9_-]{1,128}$/.test(versionId)) fail(400, 'Invalid version');
    const versionNotFound = (): never => fail(404, 'Version not found');
    try {
      await readDriveVolume(drive, (volume) => restoreVolume(volume, versionId), versionNotFound);
    } catch (err) {
      if (err instanceof DriveStorageError && err.status === 404) versionNotFound();
      if (err instanceof DriveStorageError) fail(err.status, err.message, err.code);
      throw err;
    }
    noteDriveWrite(drive.driveId);
    return c.json(await driveJson(drive, access, userId));
  },
);
