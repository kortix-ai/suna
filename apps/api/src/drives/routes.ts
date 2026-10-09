// /v1/drives: a project's Files. One drive per project; every route below the
// list resolves the drive and the caller's access at the path it touches.
// A folder the caller may not see answers 404, so a path is never an oracle
// for someone's private folder.

import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requireFeatureFlag } from '../feature-flags/gate';
import { volumesEnabledFor } from '../platform/services/boot-mode-setting';
import { combinedAuth } from '../middleware/auth';
import { rejectSandboxTokens } from '../middleware/reject-sandbox-tokens';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import { loadProjectForUser } from '../projects/lib/access';
import { ensureAgentServiceAccount } from '../repositories/service-accounts';
import { db } from '../shared/db';
import { isUuid } from '../shared/validate';
import type { AppEnv } from '../types';
import { accountGroups, accountMembers, driveConflicts, projectSessions, roleAssignments, serviceAccounts } from '@kortix/db';
import { and, eq, inArray, isNotNull, like, or, sql } from 'drizzle-orm';
import { normalizeDrivePath } from './access';
import { noteDriveWrite } from './conflicts';
import {
  COMPANY_DIR,
  type FolderAccess,
  type FolderGrant,
  type FolderLevel,
  type FolderSubject,
  USERS_DIR,
  folderAccess,
  folderAccessAtLeast,
  folderVisible,
  grantableFolder,
  grantReaches,
  grantsCovering,
  pathWithinFolder,
  folderKnownToTree,
  personalFolderOf,
} from './folders';
import {
  type DriveRow,
  driveStats,
  enforceDriveMounts,
  ensurePersonalFolder,
  ensureProjectDrive,
  getDrive,
  groupIdsOf,
  listFolderGrants,
  openConflictRows,
  readDriveVolume,
  removeFolderGrant,
  setFolderGrant,
  toDriveJson,
  userEmails,
  writeDriveVolume,
} from './service';
import {
  DriveStorageError,
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

const AccessSchema = z.enum(['none', 'read', 'write', 'manage']);
const LevelSchema = z.enum(['read', 'write', 'manage']);

const DriveSchema = z
  .object({
    driveId: z.string(),
    accountId: z.string(),
    projectId: z.string(),
    kind: z.literal('project'),
    name: z.string(),
    sizeBytes: z.number().nullable(),
    sizeLimitBytes: z.number().nullable(),
    fileCount: z.number().nullable(),
    lastChangeAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    access: AccessSchema,
    personalFolder: z.string().nullable(),
    openConflicts: z.number(),
    /** Folders other people shared with the caller (directly or through a team), outside their own folder. */
    sharedWithMe: z.array(z.object({ path: z.string(), access: AccessSchema })).optional(),
  })
  .openapi('Drive');

const FolderGrantSchema = z
  .object({
    grantId: z.string(),
    path: z.string(),
    /** Granted on a folder above this one. */
    inherited: z.boolean(),
    /** Made by Kortix: a person's own folder, the default for Company. */
    system: z.boolean(),
    principalType: z.enum(['user', 'group', 'agent', 'project']),
    principalId: z.string(),
    label: z.string(),
    level: LevelSchema,
  })
  .openapi('FolderGrant');

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
    /** What the caller may do with this entry. */
    access: AccessSchema,
    /** The folder has sharing of its own (grants made on it). */
    shared: z.boolean().optional(),
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
  if (!userId) fail(403, 'Files require a signed-in user');
  return userId;
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

interface Caller {
  drive: DriveRow;
  userId: string;
  subject: FolderSubject;
  grants: FolderGrant[];
  personalFolder: string;
}

/**
 * The person behind the request, as the folder rules see them: a project
 * admin (may change the project) manages every folder but people's own; who
 * may run sessions in the project reaches grants to the whole project; and
 * grants to them or their teams.
 */
async function callerOn(c: DriveContext, drive: DriveRow): Promise<Caller> {
  const userId = callerId(c);
  const projectId = drive.projectId!;
  if (!(await mayUseProject(c, projectId, 'read'))) fail(404, 'Files not found');
  // Volumes off for the organization: Files is not part of its product. The
  // files stay on the volume and come back when Volumes is turned on again.
  if (!volumesEnabledFor(drive.accountId)) fail(403, 'Files is not enabled for this organization.', 'feature_disabled');
  const [projectMember, admin, groupIds] = await Promise.all([
    mayUseProject(c, projectId, 'session'),
    mayUseProject(c, projectId, 'write'),
    groupIdsOf(userId, drive.accountId),
  ]);
  let grants = await listFolderGrants(drive);
  const personalFolder = await ensurePersonalFolder(drive, userId, grants);
  if (!grants.some((g) => g.path === personalFolder)) grants = await listFolderGrants(drive);
  return { drive, userId, grants, personalFolder, subject: { userId, groupIds, projectMember, admin } };
}

async function loadDrive(c: DriveContext): Promise<Caller> {
  const driveId = c.req.param('driveId') ?? '';
  const drive = isUuid(driveId) ? await getDrive(driveId) : null;
  if (!drive || drive.kind !== 'project' || !drive.projectId) fail(404, 'Files not found');
  return callerOn(c, drive);
}

/** The caller's access at `path`; 404 for a path they may not see, 403 when they see it but need more. */
function need(caller: Caller, path: string, level: FolderLevel): FolderAccess {
  const access = folderAccess(path, caller.grants, caller.subject);
  if (!folderVisible(path, caller.grants, caller.subject)) fail(404, 'File or folder not found');
  if (!folderAccessAtLeast(access, level)) {
    fail(403, level === 'manage' ? 'You cannot change who has access to this folder' : level === 'write' ? 'You can only view this folder' : 'You cannot open this folder');
  }
  return access;
}

/**
 * Folders shared with the caller by someone else: a grant naming them or one
 * of their teams, never Kortix's own grants and never inside their own folder.
 * Nearest the root first, each folder once.
 */
function sharedWithCaller(caller: Caller): Array<{ path: string; access: FolderAccess }> {
  const paths = new Set<string>();
  for (const g of caller.grants) {
    if (g.source === 'system' || (g.principalType !== 'user' && g.principalType !== 'group')) continue;
    if (!grantReaches(g, caller.subject) || pathWithinFolder(g.path, caller.personalFolder)) continue;
    paths.add(g.path);
  }
  return [...paths]
    .filter((p) => ![...paths].some((other) => other !== p && pathWithinFolder(p, other)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((path) => ({ path, access: folderAccess(path, caller.grants, caller.subject) }));
}

/** Folders that hold the tree together: never moved, deleted or renamed. */
function structural(path: string, caller: Caller): boolean {
  return path === '/' || path === USERS_DIR || path === COMPANY_DIR || personalFolderOf(path) === path || path === caller.personalFolder;
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

const notFound = (): never => fail(404, 'File or folder not found');

/** The file's current version, as the download's ETag names it; null when there is no file. */
async function currentFileVersion(drive: DriveRow, path: string): Promise<string | null> {
  return readDriveVolume(
    drive,
    async (volume) => {
      try {
        const res = await readVolumeFile(volume, path);
        await res.body?.cancel().catch(() => undefined);
        return res.headers.get('etag');
      } catch (err) {
        if (err instanceof DriveStorageError && err.status === 404) return null;
        throw err;
      }
    },
    () => null,
  );
}

const bareVersion = (tag: string) => tag.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
const sameVersion = (a: string, b: string) => bareVersion(a) === bareVersion(b);

const baseName = (p: string) => p.split('/').filter(Boolean).pop() ?? '';
const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';

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

/** Running sessions of the project pick up a sharing change at once, and stopped ones never come back with more. */
function enforceProject(drive: DriveRow): void {
  void enforceDriveMounts({ projectId: drive.projectId! }).catch((err) =>
    console.error('[drives] enforcing folder access failed:', err),
  );
}

/** The agents a project declares that start sessions (subagents never own one). Best effort. */
async function projectAgentNames(projectId: string): Promise<string[]> {
  try {
    const { listProjectAgents } = await import('../channels/slack/selection');
    return (await listProjectAgents(projectId)).filter((a) => a.mode !== 'subagent').map((a) => a.name);
  } catch (err) {
    console.warn('[drives] reading the project agents failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

export const drivesApp = makeOpenApiApp<AppEnv>();

drivesApp.use('*', combinedAuth);
// A session's folders reach it as mounts; its sandbox token has no reason to
// browse the project's Files over the API.
drivesApp.use('*', rejectSandboxTokens);
drivesApp.use('*', async (c, next) => {
  if (c.get('authType') === 'pat' && c.get('sessionId')) fail(403, 'Session tokens cannot access Files');
  await next();
});

// GET /v1/drives?projectId=
drivesApp.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['drives'],
    summary: 'The project’s Files',
    description: 'Creates the project’s drive and the caller’s own folder (`/Users/<name>`) on first use.',
    ...auth,
    request: { query: z.object({ projectId: z.string() }) },
    responses: { 200: json(z.object({ drives: z.array(DriveSchema) }), 'Files'), ...errors(401, 403, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.query('projectId');
    if (!projectId || !isUuid(projectId)) fail(400, 'projectId is required');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) fail(404, 'Project not found');
    const gate = requireFeatureFlag(c, loaded.row.metadata, 'drives', loaded.row.accountId);
    if (gate) return gate;
    const drive = await ensureProjectDrive(loaded.row.accountId, projectId);
    const caller = await callerOn(c, drive);
    const [stats, conflicts] = await Promise.all([driveStats(drive), openConflictRows(drive.driveId)]);
    const visible = conflicts.filter((r) => folderAccess(r.path, caller.grants, caller.subject) !== 'none');
    return c.json({
      drives: [
        {
          ...toDriveJson(drive, {
            access: folderAccess('/', caller.grants, caller.subject),
            personalFolder: caller.personalFolder,
            openConflicts: visible.length,
            stats,
          }),
          sharedWithMe: sharedWithCaller(caller),
        },
      ],
    });
  },
);

// GET /v1/drives/:driveId/files
drivesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{driveId}/files',
    tags: ['drives'],
    summary: 'List a folder',
    description: 'Only what the caller may see. Folders shared with the caller appear even before anything was written to them.',
    ...auth,
    request: { params: DriveParams, query: PathQuery },
    responses: { 200: json(z.object({ entries: z.array(DriveEntrySchema), access: AccessSchema }), 'Folder entries'), ...errors(400, 401, 404, 503) },
  }),
  async (c: any) => {
    const caller = await loadDrive(c);
    const { drive, grants, subject } = caller;
    const path = drivePath(c.req.query('path'), { allowRoot: true });
    // A folder on the way to one the caller may read opens for traversal even
    // without access of its own (`/Users` for someone with a share in another
    // person's folder). The visibility filter below lists only the entries on
    // that way, never the folder's other contents.
    if (path !== '/' && !folderVisible(path, grants, subject)) notFound();
    const raw = await withStorage(() =>
      readDriveVolume(
        drive,
        (volume) =>
          listVolumeFiles(volume, path, false).catch((err) => {
            // A person's own folder, or a shared one, before its first write.
            if (err instanceof DriveStorageError && err.status === 404 && err.code !== 'volume_not_found' && folderKnownToTree(path, grants)) {
              return [];
            }
            throw err;
          }),
        () => [],
      ),
    );
    const entries = raw
      .filter((e) => !(e.type === 'file' && baseName(e.path) === FOLDER_MARKER && Number(e.size) === 0))
      .filter((e) => !(e.type === 'dir' && e.path === '/lost+found'))
      // Kortix's own bookkeeping (the fold job's markers) is not a folder of anyone's.
      .filter((e) => !e.path.startsWith('/.kortix'))
      .map((e) => ({ path: e.path, name: baseName(e.path), type: e.type, size: Number(e.size ?? 0), mtime: Number(e.mtime ?? 0) }));
    // Folders that exist only as grants so far (a new person's folder, Company
    // before the first write): shown, so the tree can be walked to them.
    const seen = new Set(entries.map((e) => e.path));
    const virtual = new Set<string>();
    for (const g of grants) {
      if (!pathWithinFolder(g.path, path) || g.path === path) continue;
      const child = `${path === '/' ? '' : path}/${g.path.slice(path === '/' ? 1 : path.length + 1).split('/')[0]}`;
      if (!seen.has(child)) virtual.add(child);
    }
    if (path === '/' && !seen.has(USERS_DIR)) virtual.add(USERS_DIR);
    for (const v of virtual) entries.push({ path: v, name: baseName(v), type: 'dir', size: 0, mtime: 0 });
    const sharedPaths = new Set(grants.filter((g) => g.source !== 'system').map((g) => g.path));
    return c.json({
      access: folderAccess(path, grants, subject),
      entries: entries
        .filter((e) => folderVisible(e.path, grants, subject))
        .map((e) => ({
          ...e,
          access: folderAccess(e.path, grants, subject),
          ...(e.type === 'dir' && sharedPaths.has(e.path) ? { shared: true } : {}),
        })),
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
    const caller = await loadDrive(c);
    const path = drivePath(c.req.query('path'), { allowRoot: false });
    need(caller, path, 'read');
    const upstream = await withStorage(() =>
      readDriveVolume(caller.drive, (volume) => readVolumeFile(volume, path, c.req.header('range') ?? undefined), notFound),
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
    description: `Raw request body, at most ${MAX_DRIVE_UPLOAD_BYTES} bytes. Replaces an existing file at the path. With \`If-Match\` (the ETag the file was downloaded with), a file changed since then is refused with 409 \`file_changed\`.`,
    ...auth,
    request: { params: DriveParams, query: z.object({ path: z.string() }) },
    responses: {
      200: json(z.object({ path: z.string(), size: z.number(), version: z.string().optional() }), 'Uploaded'),
      ...errors(400, 401, 403, 404, 409, 413, 503),
    },
  }),
  async (c: any) => {
    const caller = await loadDrive(c);
    const path = drivePath(c.req.query('path'), { allowRoot: false });
    if (parentOf(path) === '/' || parentOf(path) === USERS_DIR) fail(400, 'Put files in a folder');
    need(caller, path, 'write');
    const declared = Number(c.req.header('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > MAX_DRIVE_UPLOAD_BYTES) fail(413, 'File is too large');
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength > MAX_DRIVE_UPLOAD_BYTES) fail(413, 'File is too large');
    // A save from an editor names the version it was opened at (the download's
    // ETag). Someone else's write since then refuses the save instead of
    // silently replacing their change.
    const ifMatch = c.req.header('if-match');
    if (ifMatch) {
      const current = await withStorage(() => currentFileVersion(caller.drive, path));
      if (!current || !sameVersion(current, ifMatch)) {
        fail(409, 'This file changed since you opened it. Reload it to see the latest version, then save again.', 'file_changed');
      }
    }
    const written = await withStorage(() =>
      writeDriveVolume(caller.drive, (volume) => writeVolumeFile(volume, path, body, { overwrite: true })),
    );
    noteDriveWrite(caller.drive.driveId);
    const version = ifMatch ? await withStorage(() => currentFileVersion(caller.drive, path)).catch(() => null) : null;
    if (version) c.header('etag', version);
    return c.json({ path: written.path, size: written.size, ...(version ? { version } : {}) });
  },
);

// POST /v1/drives/:driveId/files/mkdir
drivesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{driveId}/files/mkdir',
    tags: ['drives'],
    summary: 'Create a folder',
    description: 'A new top-level folder needs a project admin; inside a folder, write access to it.',
    ...auth,
    request: {
      params: DriveParams,
      body: { required: true, content: { 'application/json': { schema: z.object({ path: z.string() }) } } },
    },
    responses: { 200: json(z.object({ path: z.string() }), 'Folder'), ...errors(400, 401, 403, 404, 409, 503) },
  }),
  async (c: any) => {
    const caller = await loadDrive(c);
    const path = drivePath((c.req.valid('json') as { path: string }).path, { allowRoot: false });
    if (parentOf(path) === USERS_DIR) fail(400, 'People’s folders are made by Kortix');
    need(caller, path, 'write');
    await withStorage(() =>
      writeDriveVolume(caller.drive, (volume) =>
        writeVolumeFile(volume, `${path}/${FOLDER_MARKER}`, new Uint8Array(), { overwrite: false }),
      ),
    );
    return c.json({ path });
  },
);

/** Grants on `from` or below it follow a moved folder. */
async function moveGrants(drive: DriveRow, from: string, to: string): Promise<boolean> {
  const rows = await db
    .update(roleAssignments)
    .set({
      objectId: sql`${to} || substr(${roleAssignments.objectId}, ${from.length + 1})`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(roleAssignments.scopeType, 'project'),
        eq(roleAssignments.scopeId, drive.projectId!),
        eq(roleAssignments.objectType, 'folder'),
        or(eq(roleAssignments.objectId, from), like(roleAssignments.objectId, `${from.replace(/[\\%_]/g, '\\$&')}/%`)),
      ),
    )
    .returning({ id: roleAssignments.assignmentId });
  return rows.length > 0;
}

// POST /v1/drives/:driveId/files/move
drivesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{driveId}/files/move',
    tags: ['drives'],
    summary: 'Move or rename a file or folder',
    description: 'Refuses to overwrite: an existing destination answers 409. A folder’s sharing moves with it.',
    ...auth,
    request: {
      params: DriveParams,
      body: { required: true, content: { 'application/json': { schema: z.object({ from: z.string(), to: z.string() }) } } },
    },
    responses: { 200: json(z.object({ from: z.string(), to: z.string() }), 'Moved'), ...errors(400, 401, 403, 404, 409, 503) },
  }),
  async (c: any) => {
    const caller = await loadDrive(c);
    const body = c.req.valid('json') as { from: string; to: string };
    const from = drivePath(body.from, { allowRoot: false });
    const to = drivePath(body.to, { allowRoot: false });
    if (to === from || to.startsWith(`${from}/`)) fail(400, 'A folder cannot be moved into itself');
    if (structural(from, caller)) fail(400, 'This folder cannot be moved or renamed');
    if (parentOf(to) === '/' || parentOf(to) === USERS_DIR) fail(400, 'Put files in a folder');
    need(caller, from, 'write');
    need(caller, to, 'write');
    // Moving a shared folder changes who can reach it: only someone who may change its sharing.
    if (caller.grants.some((g) => g.source !== 'system' && pathWithinFolder(g.path, from))) need(caller, from, 'manage');
    await withStorage(() => readDriveVolume(caller.drive, (volume) => moveVolumeFile(volume, from, to), notFound));
    if (await moveGrants(caller.drive, from, to)) enforceProject(caller.drive);
    noteDriveWrite(caller.drive.driveId);
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
    description: 'A folder with contents needs `recursive=true`. Its sharing goes with it.',
    ...auth,
    request: { params: DriveParams, query: z.object({ path: z.string(), recursive: z.string().optional() }) },
    responses: { 204: { description: 'Deleted' }, ...errors(400, 401, 403, 404, 409, 503) },
  }),
  async (c: any) => {
    const caller = await loadDrive(c);
    const path = drivePath(c.req.query('path'), { allowRoot: false });
    if (structural(path, caller)) fail(400, 'This folder cannot be deleted');
    need(caller, path, 'write');
    const shared = caller.grants.filter((g) => g.grantId && pathWithinFolder(g.path, path));
    if (shared.some((g) => g.source !== 'system')) need(caller, path, 'manage');
    const recursive = c.req.query('recursive') === 'true' || c.req.query('recursive') === '1';
    await withStorage(() => readDriveVolume(caller.drive, (volume) => removeVolumeFile(volume, path, recursive), notFound));
    for (const g of shared) await removeFolderGrant(caller.drive, g.grantId!);
    if (shared.length) enforceProject(caller.drive);
    noteDriveWrite(caller.drive.driveId);
    return c.body(null, 204);
  },
);

// ─── Sharing ──────────────────────────────────────────────────────────────

async function grantLabels(drive: DriveRow, grants: FolderGrant[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const users = grants.filter((g) => g.principalType === 'user').map((g) => g.principalId);
  const groups = grants.filter((g) => g.principalType === 'group').map((g) => g.principalId);
  const agents = grants.filter((g) => g.principalType === 'agent').map((g) => g.principalId);
  const [emails, groupRows, agentRows] = await Promise.all([
    userEmails(users),
    groups.length
      ? db.select({ id: accountGroups.groupId, name: accountGroups.name }).from(accountGroups).where(inArray(accountGroups.groupId, groups))
      : Promise.resolve([] as Array<{ id: string; name: string }>),
    agents.length
      ? db
          .select({ id: serviceAccounts.serviceAccountId, name: serviceAccounts.agentName })
          .from(serviceAccounts)
          .where(inArray(serviceAccounts.serviceAccountId, agents))
      : Promise.resolve([] as Array<{ id: string; name: string | null }>),
  ]);
  for (const [id, email] of emails) out.set(`user:${id}`, email);
  for (const g of groupRows) out.set(`group:${g.id}`, g.name);
  for (const a of agentRows) out.set(`agent:${a.id}`, a.name ?? 'agent');
  out.set(`project:${drive.projectId}`, 'Everyone in this project');
  return out;
}

// GET /v1/drives/:driveId/access?path=
drivesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{driveId}/access',
    tags: ['drives'],
    summary: 'Who has access to a folder',
    description: 'The grants on the folder and the ones it inherits from folders above it.',
    ...auth,
    request: { params: DriveParams, query: z.object({ path: z.string() }) },
    responses: {
      200: json(
        z.object({ path: z.string(), access: AccessSchema, grantable: z.boolean(), grants: z.array(FolderGrantSchema) }),
        'Folder access',
      ),
      ...errors(400, 401, 404),
    },
  }),
  async (c: any) => {
    const caller = await loadDrive(c);
    const path = drivePath(c.req.query('path'), { allowRoot: true });
    const access = path === '/' ? folderAccess('/', caller.grants, caller.subject) : need(caller, path, 'read');
    const covering = grantsCovering(path, caller.grants);
    const labels = await grantLabels(caller.drive, covering);
    return c.json({
      path,
      access,
      grantable: grantableFolder(path),
      grants: covering.map((g) => ({
        grantId: g.grantId!,
        path: g.path,
        inherited: g.path !== path,
        system: g.source === 'system',
        principalType: g.principalType,
        principalId: g.principalId,
        label: labels.get(`${g.principalType}:${g.principalId}`) ?? g.principalId,
        level: g.level,
      })),
    });
  },
);

const ShareBody = z.object({
  path: z.string(),
  principalType: z.enum(['user', 'group', 'agent', 'project']),
  /** A user id, a team (group) id, or for `agent` the agent's name. Ignored for `project`. */
  principalId: z.string().min(1).max(128).optional(),
  level: LevelSchema,
});

// PUT /v1/drives/:driveId/access
drivesApp.openapi(
  createRoute({
    method: 'put',
    path: '/{driveId}/access',
    tags: ['drives'],
    summary: 'Share a folder',
    description:
      'Gives a person, a team, an agent or everyone in the project `read`, `write` or `manage` on a folder and everything below it. Sharing again changes the level. ' +
      'Running sessions pick the change up at once.',
    ...auth,
    request: { params: DriveParams, body: { required: true, content: { 'application/json': { schema: ShareBody } } } },
    responses: { 200: json(z.object({ grantId: z.string() }), 'Shared'), ...errors(400, 401, 403, 404) },
  }),
  async (c: any) => {
    const caller = await loadDrive(c);
    const body = c.req.valid('json') as z.infer<typeof ShareBody>;
    const path = drivePath(body.path, { allowRoot: false });
    if (!grantableFolder(path)) fail(400, 'Share a folder inside Files');
    need(caller, path, 'manage');
    const { drive } = caller;
    let principalId: string;
    if (body.principalType === 'project') {
      principalId = drive.projectId!;
    } else if (body.principalType === 'agent') {
      const name = body.principalId?.trim();
      if (!name) fail(400, 'Name the agent');
      // An agent's identity is its service account; the first share makes it.
      // The agent must be one the project declares (or one that already ran).
      const declared = await projectAgentNames(drive.projectId!);
      const existing = await db
        .select({ id: serviceAccounts.serviceAccountId })
        .from(serviceAccounts)
        .where(and(eq(serviceAccounts.projectId, drive.projectId!), eq(serviceAccounts.agentName, name)))
        .limit(1);
      if (!declared.includes(name) && !existing.length) fail(404, 'No agent by that name in this project');
      principalId = existing[0]?.id ?? (await ensureAgentServiceAccount({ accountId: drive.accountId, projectId: drive.projectId!, agentName: name }));
    } else {
      if (!body.principalId || !isUuid(body.principalId)) fail(400, 'principalId is required');
      principalId = body.principalId;
      if (body.principalType === 'user') {
        if (path === caller.personalFolder && principalId === caller.userId) fail(400, 'This is already your folder');
        const [member] = await db
          .select({ userId: accountMembers.userId })
          .from(accountMembers)
          .where(and(eq(accountMembers.accountId, drive.accountId), eq(accountMembers.userId, principalId)))
          .limit(1);
        if (!member) fail(404, 'That person is not a member of this account');
      }
    }
    const grantId = await setFolderGrant({
      drive,
      path,
      principal: { type: body.principalType, id: principalId },
      level: body.level,
      grantedBy: caller.userId,
    });
    enforceProject(drive);
    return c.json({ grantId });
  },
);

// DELETE /v1/drives/:driveId/access/:grantId
drivesApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{driveId}/access/{grantId}',
    tags: ['drives'],
    summary: 'Stop sharing a folder with someone',
    description: 'Running sessions that no longer reach the folder lose it at once; later ones never mount it.',
    ...auth,
    request: { params: z.object({ driveId: z.string(), grantId: z.string() }) },
    responses: { 204: { description: 'Removed' }, ...errors(400, 401, 403, 404) },
  }),
  async (c: any) => {
    const caller = await loadDrive(c);
    const grantId = c.req.param('grantId');
    const grant = isUuid(grantId) ? caller.grants.find((g) => g.grantId === grantId) : undefined;
    if (!grant) fail(404, 'Grant not found');
    if (grant.source === 'system' && grant.principalType === 'user' && personalFolderOf(grant.path) === grant.path) {
      fail(400, 'A person always has their own folder');
    }
    need(caller, grant.path, 'manage');
    await removeFolderGrant(caller.drive, grantId);
    enforceProject(caller.drive);
    return c.body(null, 204);
  },
);

// GET /v1/drives/:driveId/principals
drivesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{driveId}/principals',
    tags: ['drives'],
    summary: 'Who a folder can be shared with',
    description: 'The account’s people and teams and the project’s agents.',
    ...auth,
    request: { params: DriveParams },
    responses: {
      200: json(
        z.object({
          people: z.array(z.object({ id: z.string(), label: z.string() })),
          teams: z.array(z.object({ id: z.string(), label: z.string() })),
          agents: z.array(z.object({ id: z.string(), label: z.string() })),
        }),
        'Principals',
      ),
      ...errors(401, 404),
    },
  }),
  async (c: any) => {
    const { drive } = await loadDrive(c);
    const [members, teams, agentRows, saRows] = await Promise.all([
      db.select({ userId: accountMembers.userId }).from(accountMembers).where(eq(accountMembers.accountId, drive.accountId)),
      db.select({ id: accountGroups.groupId, name: accountGroups.name }).from(accountGroups).where(eq(accountGroups.accountId, drive.accountId)),
      db
        .selectDistinct({ name: projectSessions.agentName })
        .from(projectSessions)
        .where(eq(projectSessions.projectId, drive.projectId!)),
      db
        .select({ name: serviceAccounts.agentName })
        .from(serviceAccounts)
        .where(and(eq(serviceAccounts.projectId, drive.projectId!), isNotNull(serviceAccounts.agentName))),
    ]);
    const emails = await userEmails(members.map((m) => m.userId));
    const agents = [
      ...new Set([...(await projectAgentNames(drive.projectId!)), ...agentRows.map((a) => a.name), ...saRows.map((a) => a.name ?? '')].filter(Boolean)),
    ].sort();
    return c.json({
      people: members.map((m) => ({ id: m.userId, label: emails.get(m.userId) ?? m.userId })),
      teams: teams.map((t) => ({ id: t.id, label: t.name })),
      agents: agents.map((name) => ({ id: name, label: name })),
    });
  },
);

// ─── Conflicts and versions ───────────────────────────────────────────────

// GET /v1/drives/:driveId/conflicts
drivesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{driveId}/conflicts',
    tags: ['drives'],
    summary: 'List open conflict copies',
    description:
      'Files Kortix kept beside the original when two writers changed it at once, named `<name> (conflict <date> <time>)<ext>`, in folders the caller can see.',
    ...auth,
    request: { params: DriveParams },
    responses: { 200: json(z.object({ conflicts: z.array(DriveConflictSchema) }), 'Open conflicts'), ...errors(401, 404) },
  }),
  async (c: any) => {
    const caller = await loadDrive(c);
    const rows = (await openConflictRows(caller.drive.driveId)).filter(
      (r) => folderAccess(r.path, caller.grants, caller.subject) !== 'none',
    );
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
    description: 'Hides the notice and keeps the copy.',
    ...auth,
    request: { params: z.object({ driveId: z.string(), conflictId: z.string() }) },
    responses: { 204: { description: 'Dismissed' }, ...errors(401, 403, 404) },
  }),
  async (c: any) => {
    const caller = await loadDrive(c);
    const conflictId = c.req.param('conflictId');
    if (!isUuid(conflictId)) fail(404, 'Conflict not found');
    const [row] = await db
      .select({ path: driveConflicts.path })
      .from(driveConflicts)
      .where(and(eq(driveConflicts.driveId, caller.drive.driveId), eq(driveConflicts.conflictId, conflictId)))
      .limit(1);
    if (!row) fail(404, 'Conflict not found');
    need(caller, row.path, 'write');
    await db
      .update(driveConflicts)
      .set({ dismissedAt: new Date(), dismissedBy: caller.userId })
      .where(eq(driveConflicts.conflictId, conflictId));
    return c.body(null, 204);
  },
);

// GET /v1/drives/:driveId/versions
drivesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{driveId}/versions',
    tags: ['drives'],
    summary: 'List the project’s Files versions, newest first',
    description: 'Project admins only: a version is the whole drive.',
    ...auth,
    request: { params: DriveParams },
    responses: { 200: json(z.object({ versions: z.array(DriveVersionSchema) }), 'Versions'), ...errors(401, 403, 404, 503) },
  }),
  async (c: any) => {
    const caller = await loadDrive(c);
    if (!caller.subject.admin) fail(403, 'Only a project admin can see versions of Files');
    const commits = await withStorage(() => readDriveVolume(caller.drive, (volume) => listVolumeCommits(volume), () => []));
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
    summary: 'Restore the project’s Files to a version',
    description: 'Project admins only. Adds a new version whose files equal the chosen one. Later versions stay in the history.',
    ...auth,
    request: {
      params: DriveParams,
      body: { required: true, content: { 'application/json': { schema: z.object({ versionId: z.string().min(1) }) } } },
    },
    responses: { 204: { description: 'Restored' }, ...errors(400, 401, 403, 404, 503) },
  }),
  async (c: any) => {
    const caller = await loadDrive(c);
    if (!caller.subject.admin) fail(403, 'Only a project admin can restore Files');
    const { versionId } = c.req.valid('json') as { versionId: string };
    if (versionId === 'head' || !/^[A-Za-z0-9_-]{1,128}$/.test(versionId)) fail(400, 'Invalid version');
    const versionNotFound = (): never => fail(404, 'Version not found');
    try {
      await readDriveVolume(caller.drive, (volume) => restoreVolume(volume, versionId), versionNotFound);
    } catch (err) {
      if (err instanceof DriveStorageError && err.status === 404) versionNotFound();
      if (err instanceof DriveStorageError) fail(err.status, err.message, err.code);
      throw err;
    }
    noteDriveWrite(caller.drive.driveId);
    return c.body(null, 204);
  },
);
