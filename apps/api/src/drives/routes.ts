// /v1/drives: a project's Files. One drive per project; every route below the
// list resolves the drive and the caller's access at the path it touches.
// A folder the caller may not see answers 404, so a path is never an oracle
// for someone's private folder.

import { logger } from '../lib/logger';
import { recordDriveCommitAuthor } from '../artifacts/events-store';
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { featureDisabledBody, requireFeatureFlag } from '../feature-flags/gate';
import { projectFeatureFlagEnabled } from '../feature-flags/for-project';
import { combinedAuth } from '../middleware/auth';
import { callerKortixSessionId } from '../middleware/caller-session';
import { rejectSandboxTokens } from '../middleware/reject-sandbox-tokens';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import { actorOf } from '../iam/actor';
import { visibleDirectory } from '../iam/directory-visibility';
import { loadProjectForUser } from '../projects/surface';
import { ensureAgentServiceAccount } from '../repositories/service-accounts';
import { isUuid } from '../shared/validate';
import type { AppEnv } from '../types';
import {
  dismissConflict,
  driveConflict,
  isAccountMember,
  principalNames,
  projectAgentServiceAccount,
  projectNames,
  shareablePrincipals,
} from './queries';
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
  planFolderMounts,
  sessionMountCandidates,
  personalFolderOf,
  NO_PRIVATE_CHANNEL_FOLDERS,
  PRIVATE_CHANNELS_DIR,
  type PrivateChannelFolders,
  privateChannelFolderOf,
} from './folders';
import {
  type DriveRow,
  driveStats,
  driveSubjectFor,
  driveVolume,
  privateChannelRows,
  enforceProjectMounts,
  ensureProjectDrive,
  getDrive,
  listFolderGrants,
  moveDriveFolder,
  openConflictRows,
  readDriveVolume,
  removeFolderGrant,
  sessionFilesRefusalFor,
  setFolderGrant,
  toDriveJson,
  userEmails,
  writeDriveVolume,
} from './service';
import { type DriveUpload, openDriveUpload, sealDriveUpload } from './upload-token';
import { parseVolumeWriteCommit } from './volume-commit';
import {
  assertDriveWriteFits,
  driveFolderSizes,
  driveLimitsFor,
  driveVolumeUsage,
  accountDriveUsage,
  FOLDER_MOUNT_WARN_RATIO,
  forgetDriveUsage,
  MAX_DRIVE_REQUEST_BYTES,
} from './limits';
import {
  type DriveLimitDetail,
  DriveStorageError,
  type DriveStorageStatus,
  commitVolumeUpload,
  planVolumeUpload,
  putVolumeUploadBlock,
  listVolumeCommits,
  listVolumeFiles,
  readVolumeFile,
  removeVolumeFile,
  restoreVolume,
  sandboxMountLimit,
  statVolumeFile,
  writeVolumeFile,
  FILE_CHANGED_MESSAGE,
  type VolumeCommit,
} from './volumes';

export const MAX_DRIVE_UPLOAD_BYTES = MAX_DRIVE_REQUEST_BYTES;
/** A block of the block upload, as storage takes it. */
const UPLOAD_BLOCK_BYTES = 1024 * 1024;
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
/** Sessions whose mounts a sharing change has not reached yet (see enforceProjectMounts). */
const PendingSchema = z.object({ pendingSessions: z.number() });
const PathQuery = z.object({ path: z.string().optional() });

function fail(
  status: DriveStorageStatus,
  message: string,
  code?: string,
  detail?: DriveLimitDetail,
  retryAfterSeconds?: number,
): never {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (retryAfterSeconds !== undefined) headers['retry-after'] = String(retryAfterSeconds);
  throw new HTTPException(status, {
    message,
    // A limit refusal names its limit and numbers beside `code` (drives/limits.ts).
    res: new Response(JSON.stringify({ error: true, message, status, ...(code ? { code } : {}), ...(detail ?? {}) }), {
      status,
      headers,
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

/** The person behind the request on `drive` (`driveSubjectFor`), after the HTTP refusals. */
async function callerOn(c: DriveContext, drive: DriveRow): Promise<Caller> {
  const userId = callerId(c);
  const projectId = drive.projectId!;
  if (!(await mayUseProject(c, projectId, 'read'))) fail(404, 'Files not found');
  // Volumes off for the project: nothing new is written to Files. Reads stay
  // open, so a file a session already wrote under /drives still opens in its
  // transcript; the Files page itself is gated on GET /v1/drives?projectId=.
  if (c.req.method !== 'GET' && !(await projectFeatureFlagEnabled(projectId, 'drives'))) {
    const { error } = featureDisabledBody('drives');
    fail(403, error, 'feature_disabled');
  }
  return { drive, ...(await driveSubjectFor(drive, userId, (action) => mayUseProject(c, projectId, action), callerKortixSessionId(c))) };
}

async function loadDrive(c: DriveContext): Promise<Caller> {
  const driveId = c.req.param('driveId') ?? '';
  const drive = isUuid(driveId) ? await getDrive(driveId) : null;
  if (!drive || drive.kind !== 'project' || !drive.projectId) fail(404, 'Files not found');
  // A project-bound token (a session's) reaches only its own project's drive.
  const tokenProjectId = c.get('tokenProjectId');
  if (tokenProjectId && tokenProjectId !== drive.projectId) fail(404, 'Files not found');
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

/** The project's private channel folders, as the caller's folder rules know them. */
function privateFolders(caller: Pick<Caller, 'subject'>): PrivateChannelFolders {
  return caller.subject.privateChannelFolders ?? NO_PRIVATE_CHANNEL_FOLDERS;
}

/** Folders that hold the tree together: never moved, deleted or renamed. */
function structural(path: string, caller: Caller): boolean {
  return (
    path === '/' ||
    path === USERS_DIR ||
    path === COMPANY_DIR ||
    // `/Channels` holds the tree together only while it holds a private channel's folder.
    (path === PRIVATE_CHANNELS_DIR && privateFolders(caller).size > 0) ||
    personalFolderOf(path) === path ||
    privateChannelFolderOf(path, privateFolders(caller)) === path ||
    path === caller.personalFolder
  );
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
    if (err instanceof DriveStorageError) fail(err.status, err.message, err.code, err.detail, err.retryAfterSeconds);
    throw err;
  }
}

const notFound = (): never => fail(404, 'File or folder not found');

/** One raw request body over 64 MiB: the SDK sends such a file in 1 MiB blocks instead. */
const bodyTooLarge = (requested: number): never =>
  fail(413, `One upload request carries at most ${MAX_DRIVE_UPLOAD_BYTES / 1024 / 1024} MB. Send a larger file with the block upload (POST …/files/upload).`, 'payload_too_large', {
    limit: 'request_bytes',
    max: MAX_DRIVE_UPLOAD_BYTES,
    requested,
  });

/** The size of the file a write replaces, 0 when there is none: an overwrite frees what it replaces. */
async function existingFileSize(drive: DriveRow, path: string): Promise<number> {
  return readDriveVolume(
    drive,
    async (volume) => {
      try {
        const stat = await statVolumeFile(volume, path);
        return stat.type === 'file' ? stat.size : 0;
      } catch (err) {
        if (err instanceof DriveStorageError && err.status === 404) return 0;
        throw err;
      }
    },
    () => 0,
  );
}

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

/** The agents a project declares that start sessions (subagents never own one). Best effort. */
async function projectAgentNames(projectId: string): Promise<string[]> {
  try {
    const { listProjectAgents } = await import('../channels/slack/selection');
    return (await listProjectAgents(projectId)).filter((a) => a.mode !== 'subagent').map((a) => a.name);
  } catch (err) {
    logger.warn('[drives] reading the project agents failed:', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

export const drivesApp = makeOpenApiApp<AppEnv>();

drivesApp.use('*', combinedAuth);
// A sandbox token names no person, so it has no folder access to act with.
drivesApp.use('*', rejectSandboxTokens);
// A session token acts as the person who started the session, and only in
// their own private session (`sessionFilesRefusal`).
drivesApp.use('*', async (c, next) => {
  const sessionId = c.get('sessionId');
  if (c.get('authType') === 'pat' && sessionId) {
    const refusal = await sessionFilesRefusalFor(sessionId, c.get('userId') ?? null);
    if (refusal) fail(403, refusal);
  }
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
  async (c) => {
    const projectId = c.req.query('projectId');
    if (!projectId || !isUuid(projectId)) fail(400, 'projectId is required');
    const tokenProjectId = c.get('tokenProjectId');
    if (tokenProjectId && tokenProjectId !== projectId) fail(404, 'Project not found');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) fail(404, 'Project not found');
    const gate = requireFeatureFlag(c, loaded.row.metadata, 'drives');
    if (gate) return gate;
    const drive = await ensureProjectDrive(loaded.row.accountId, projectId);
    const caller = await callerOn(c, drive);
    const [stats, conflicts, limits] = await Promise.all([
      driveStats(drive),
      openConflictRows(drive.driveId),
      driveLimitsFor(drive.accountId).catch(() => null),
    ]);
    const visible = conflicts.filter((r) => folderAccess(r.path, caller.grants, caller.subject) !== 'none');
    return c.json({
      drives: [
        {
          ...toDriveJson(drive, {
            access: folderAccess('/', caller.grants, caller.subject),
            personalFolder: caller.personalFolder,
            openConflicts: visible.length,
            stats,
            limitBytes: limits?.projectBytes ?? null,
          }),
          sharedWithMe: sharedWithCaller(caller),
        },
      ],
    });
  },
);

// ─── Usage and limits ─────────────────────────────────────────────────────

const DriveLimitsSchema = z
  .object({
    /** What this project's Files may hold; null = no Kortix limit (Platinum's still applies). */
    projectBytes: z.number().nullable(),
    /** What all the account's projects' Files may hold together; null = no limit. */
    accountBytes: z.number().nullable(),
    /** The largest one file. */
    fileBytes: z.number(),
    /** One raw upload request (`PUT …/files/content`); the block upload takes larger files. */
    requestBytes: z.number(),
    /** The largest folder a session mounts. */
    folderMountBytes: z.number(),
    /** Folders one session mounts at most. */
    mountsPerSession: z.number(),
  })
  .openapi('DriveLimits');

const DriveFolderUsageSchema = z
  .object({
    path: z.string(),
    bytes: z.number(),
    files: z.number(),
    /** False when the drive was too large to measure to the end: `bytes` is then a floor. */
    complete: z.boolean(),
    /** `near_limit` from 80 % of `folderMountBytes`; `over_limit` past it: sessions cannot mount the folder. */
    state: z.enum(['ok', 'near_limit', 'over_limit']),
  })
  .openapi('DriveFolderUsage');

const DriveUsageSchema = z
  .object({
    driveId: z.string(),
    projectId: z.string(),
    /** What the project's Files hold now; null when storage could not say. */
    usedBytes: z.number().nullable(),
    fileCount: z.number().nullable(),
    limits: DriveLimitsSchema,
    /** The account's Files across its projects, when the account has a limit. */
    account: z.object({ usedBytes: z.number(), limitBytes: z.number(), complete: z.boolean() }).nullable(),
    /** The folders the caller can see that sessions mount, each against the folder-mount cap. */
    folders: z.array(DriveFolderUsageSchema),
  })
  .openapi('DriveUsage');

const LimitsShape = (l: Awaited<ReturnType<typeof driveLimitsFor>>) => ({
  projectBytes: l.projectBytes,
  accountBytes: l.accountBytes,
  fileBytes: l.fileBytes,
  requestBytes: l.requestBytes,
  folderMountBytes: l.folderMountBytes,
  mountsPerSession: l.mountsPerSession,
});

// GET /v1/drives/usage?account_id=
drivesApp.openapi(
  createRoute({
    method: 'get',
    path: '/usage',
    tags: ['drives'],
    summary: 'Files storage of an account, per project',
    description:
      'What each project’s Files hold against the plan’s limits, and the account’s total. Needs `billing.read` on the account (`account_id`, else the caller’s own).',
    ...auth,
    request: { query: z.object({ account_id: z.string().optional() }) },
    responses: {
      200: json(
        z.object({
          accountId: z.string(),
          usedBytes: z.number(),
          /** False when storage could not say what some project holds. */
          complete: z.boolean(),
          limits: DriveLimitsSchema,
          projects: z.array(
            z.object({ projectId: z.string(), name: z.string(), driveId: z.string(), usedBytes: z.number().nullable(), fileCount: z.number().nullable() }),
          ),
        }),
        'Files storage',
      ),
      ...errors(401, 403),
    },
  }),
  async (c) => {
    const { resolveBillingReadAccountId } = await import('../billing/http-require-billing-write');
    const accountId = await resolveBillingReadAccountId(c);
    const [limits, usage] = await Promise.all([driveLimitsFor(accountId), accountDriveUsage(accountId)]);
    const names = await projectNames(usage.projects.map((p) => p.projectId));
    return c.json({
      accountId,
      usedBytes: usage.usedBytes,
      complete: usage.complete,
      limits: LimitsShape(limits),
      projects: usage.projects
        .map((p) => ({ ...p, name: names.get(p.projectId) ?? '' }))
        .sort((a, b) => (b.usedBytes ?? 0) - (a.usedBytes ?? 0)),
    });
  },
);

// GET /v1/drives/:driveId/usage
drivesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{driveId}/usage',
    tags: ['drives'],
    summary: 'What the project’s Files hold, and their limits',
    description:
      'The project’s Files against its plan’s limits (one file, one folder a session mounts, the project, the account), and each folder the caller can see that sessions mount, so a folder near the folder-mount cap shows before a session fails to mount it.',
    ...auth,
    request: { params: DriveParams },
    responses: { 200: json(DriveUsageSchema, 'Usage'), ...errors(401, 403, 404) },
  }),
  async (c) => {
    const caller = await loadDrive(c);
    const drive = caller.drive;
    const limits = await driveLimitsFor(drive.accountId);
    const candidates = [...new Set([caller.personalFolder, ...caller.grants.map((g) => g.path)])].filter(
      (p): p is string => !!p && p !== '/' && p !== USERS_DIR && folderAccess(p, caller.grants, caller.subject) !== 'none',
    );
    const [usage, account, sizes] = await Promise.all([
      driveVolumeUsage(drive),
      limits.accountBytes === null ? Promise.resolve(null) : accountDriveUsage(drive.accountId),
      driveFolderSizes(drive, candidates),
    ]);
    const folders = [...sizes.values()]
      .map((f) => ({
        ...f,
        state:
          f.bytes > limits.folderMountBytes
            ? ('over_limit' as const)
            : f.bytes >= limits.folderMountBytes * FOLDER_MOUNT_WARN_RATIO
              ? ('near_limit' as const)
              : ('ok' as const),
      }))
      .sort((a, b) => b.bytes - a.bytes);
    return c.json({
      driveId: drive.driveId,
      projectId: drive.projectId ?? '',
      usedBytes: usage?.usedBytes ?? null,
      fileCount: usage?.fileCount ?? null,
      limits: LimitsShape(limits),
      account:
        account && limits.accountBytes !== null
          ? { usedBytes: account.usedBytes, limitBytes: limits.accountBytes, complete: account.complete }
          : null,
      folders,
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
  async (c) => {
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
    // A private channel's folder is named by its id (`/Channels/<space_id>`); it lists under `#<slug>`.
    const channelNames = entries.some((e) => privateChannelFolderOf(e.path, privateFolders(caller)) === e.path)
      ? new Map((await privateChannelRows(drive.projectId!)).flatMap((r) => (r.folder && r.slug ? [[r.folder, `#${r.slug}`] as const] : [])))
      : null;
    return c.json({
      access: folderAccess(path, grants, subject),
      entries: entries
        .filter((e) => folderVisible(e.path, grants, subject))
        .map((e) => ({
          ...e,
          ...(channelNames?.has(e.path) ? { name: channelNames.get(e.path)! } : {}),
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
      416: { description: 'Requested range is not satisfiable; Content-Range names the file size' },
      ...errors(400, 401, 404, 503),
    },
  }),
  async (c) => {
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
    return new Response(upstream.body, { status: upstream.status, headers });
  },
);

// PUT /v1/drives/:driveId/files/content
drivesApp.openapi(
  createRoute({
    method: 'put',
    path: '/{driveId}/files/content',
    tags: ['drives'],
    summary: 'Upload a file',
    description: `Raw request body, at most ${MAX_DRIVE_UPLOAD_BYTES} bytes (413 \`payload_too_large\`). Replaces an existing file at the path. With \`If-Match\` (the ETag the file was downloaded with), a file changed since then is refused with 409 \`file_changed\`. A file that does not fit the Files limits (\`GET …/usage\`) is refused before its bytes are read: 403 \`storage_limit_exceeded\` (\`limit\`: \`project_bytes\` or \`account_bytes\`, with \`max\`, \`used\`, \`requested\`), 413 \`file_too_large\` (\`limit: file_bytes\`); a write into a folder sessions mount that would take it past the folder-mount cap answers 422 \`sub_path_too_large\`; busy storage answers 429 with \`Retry-After\`.`,
    ...auth,
    request: { params: DriveParams, query: z.object({ path: z.string() }) },
    responses: {
      200: json(z.object({ path: z.string(), size: z.number(), version: z.string().optional() }), 'Uploaded'),
      ...errors(400, 401, 403, 404, 409, 413, 422, 429, 503),
    },
  }),
  async (c) => {
    const caller = await loadDrive(c);
    const path = drivePath(c.req.query('path'), { allowRoot: false });
    if (parentOf(path) === '/' || parentOf(path) === USERS_DIR) fail(400, 'Put files in a folder');
    need(caller, path, 'write');
    const declared = Number(c.req.header('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > MAX_DRIVE_UPLOAD_BYTES) bodyTooLarge(declared);
    // The limits are checked on the declared size before the body is read, so
    // an upload that cannot fit is refused before its bytes travel.
    if (Number.isFinite(declared)) await withStorage(() => assertDriveWriteFits(caller.drive, { bytes: declared, replaces: () => existingFileSize(caller.drive, path) }));
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength > MAX_DRIVE_UPLOAD_BYTES) bodyTooLarge(body.byteLength);
    if (!Number.isFinite(declared)) await withStorage(() => assertDriveWriteFits(caller.drive, { bytes: body.byteLength, replaces: () => existingFileSize(caller.drive, path) }));
    // A save from an editor names the version it was opened at (the download's
    // ETag). Someone else's write since then refuses the save instead of
    // silently replacing their change. Storage enforces it atomically with the
    // write (If-Match on the volume write); the read here only refuses a save
    // that is already stale before its bytes are sent.
    const ifMatch = c.req.header('if-match');
    if (ifMatch) {
      const current = await withStorage(() => currentFileVersion(caller.drive, path));
      if (!current || !sameVersion(current, ifMatch)) fail(409, FILE_CHANGED_MESSAGE, 'file_changed');
    }
    const written = await withStorage(() =>
      writeDriveVolume(caller.drive, (volume) =>
        writeVolumeFile(volume, path, body, { overwrite: true, ...(ifMatch ? { ifMatch } : {}) }),
      ),
    );
    await recordDriveCommitAuthor(caller.drive.driveId, written.commit, {
      userId: caller.userId,
      sessionId: callerKortixSessionId(c),
    });
    noteDriveWrite(caller.drive.driveId);
    forgetDriveUsage(caller.drive.platinumVolumeName);
    // The version this write made, as storage answered it: a read afterwards
    // could name a later save's version and let the next save clobber it.
    const version = ifMatch && written.version ? `"${bareVersion(written.version)}"` : null;
    if (version) c.header('etag', version);
    return c.json({ path: written.path, size: written.size, ...(version ? { version } : {}) });
  },
);

// The block upload, for files of any size (the PUT above takes at most 64
// MiB): plan names the file and the sha256 of each 1 MiB block, storage
// answers which blocks it lacks, only those are sent, and the commit lands
// the whole file at once. The upload id is sealed to the caller, the drive
// and the path (drives/upload-token.ts); write access at the path is checked
// again at every block and at the commit.

const UploadParams = z.object({ driveId: z.string(), uploadId: z.string() });

/** Storage forgot the upload: it lapsed (16 min without a block), was committed, or was cancelled. */
async function withUploadStorage<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await withStorage(fn);
  } catch (err) {
    if (err instanceof HTTPException && err.status === 404) fail(404, 'The upload expired. Start it again.', 'upload_not_found');
    throw err;
  }
}

/** The upload the caller planned on this drive, with write access at its path checked now. */
async function callerUpload(c: DriveContext): Promise<{ caller: Caller; upload: DriveUpload }> {
  const caller = await loadDrive(c);
  const upload = openDriveUpload(c.req.param('uploadId') ?? '', { driveId: caller.drive.driveId, userId: caller.userId });
  if (!upload) fail(404, 'Upload not found', 'upload_not_found');
  need(caller, upload.path, 'write');
  return { caller, upload };
}

// POST /v1/drives/:driveId/files/upload
drivesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{driveId}/files/upload',
    tags: ['drives'],
    summary: 'Start a block upload',
    description:
      '`blocks` is the lowercase sha256 of each 1 MiB block of the file, in order (the last may be short). Answers the upload id and the blocks storage lacks: send each with `PUT …/files/upload/{uploadId}/blocks/{sha}`, then commit. Replaces an existing file at the path. With `If-Match`, a file changed since is refused with 409 `file_changed`, here and at the commit. An upload without a block for 16 minutes expires.',
    ...auth,
    request: {
      params: DriveParams,
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              path: z.string(),
              size: z.number().int().positive(),
              blocks: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
            }),
          },
        },
      },
    },
    responses: {
      200: json(z.object({ uploadId: z.string(), missing: z.array(z.string()), expiresAt: z.string().nullable() }), 'Planned'),
      ...errors(400, 401, 403, 404, 409, 413, 422, 429, 503),
    },
  }),
  async (c) => {
    const caller = await loadDrive(c);
    const { path: rawPath, size, blocks } = c.req.valid('json') as { path: string; size: number; blocks: string[] };
    const path = drivePath(rawPath, { allowRoot: false });
    if (parentOf(path) === '/' || parentOf(path) === USERS_DIR) fail(400, 'Put files in a folder');
    need(caller, path, 'write');
    if (blocks.length !== Math.ceil(size / UPLOAD_BLOCK_BYTES)) fail(400, `A file of ${size} bytes has ${Math.ceil(size / UPLOAD_BLOCK_BYTES)} blocks`);
    // Before any block is sent: a file that does not fit is refused here.
    await withStorage(() => assertDriveWriteFits(caller.drive, { bytes: size, replaces: () => existingFileSize(caller.drive, path) }));
    const ifMatch = c.req.header('if-match');
    if (ifMatch) {
      const current = await withStorage(() => currentFileVersion(caller.drive, path));
      if (!current || !sameVersion(current, ifMatch)) fail(409, FILE_CHANGED_MESSAGE, 'file_changed');
    }
    const plan = (await withStorage(() =>
      writeDriveVolume(caller.drive, (volume) => planVolumeUpload(volume, { files: [{ path, size, blocks }], overwrite: true })),
    )) as { upload_id?: unknown; missing?: unknown; expires_at?: unknown };
    if (typeof plan.upload_id !== 'string' || !plan.upload_id) fail(503, 'Drive storage is unavailable, try again shortly', 'drive_storage_unavailable');
    const uploadId = sealDriveUpload({
      uploadId: plan.upload_id,
      driveId: caller.drive.driveId,
      userId: caller.userId,
      path,
      size,
      ...(ifMatch ? { ifMatch } : {}),
    });
    return c.json({
      uploadId,
      missing: Array.isArray(plan.missing) ? plan.missing.filter((m): m is string => typeof m === 'string') : [],
      expiresAt: typeof plan.expires_at === 'string' ? plan.expires_at : null,
    });
  },
);

// PUT /v1/drives/:driveId/files/upload/:uploadId/blocks/:sha
drivesApp.openapi(
  createRoute({
    method: 'put',
    path: '/{driveId}/files/upload/{uploadId}/blocks/{sha}',
    tags: ['drives'],
    summary: 'Send one block of a block upload',
    description: 'Raw request body, at most 1 MiB; its sha256 must equal `sha`. Safe to send again.',
    ...auth,
    request: { params: UploadParams.extend({ sha: z.string() }) },
    responses: { 204: { description: 'Stored' }, ...errors(400, 401, 403, 404, 413, 429, 503) },
  }),
  async (c) => {
    const { caller, upload } = await callerUpload(c);
    const sha = c.req.param('sha') ?? '';
    if (!/^[0-9a-f]{64}$/.test(sha)) fail(400, 'A block is named by its lowercase sha256');
    const declared = Number(c.req.header('content-length') ?? NaN);
    const blockTooLarge = (requested: number): never =>
      fail(413, 'A block is at most 1 MiB', 'payload_too_large', { limit: 'block_bytes', max: UPLOAD_BLOCK_BYTES, requested });
    if (Number.isFinite(declared) && declared > UPLOAD_BLOCK_BYTES) blockTooLarge(declared);
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength > UPLOAD_BLOCK_BYTES) blockTooLarge(body.byteLength);
    await withUploadStorage(() => putVolumeUploadBlock(driveVolume(caller.drive), upload.uploadId, sha, body));
    return c.body(null, 204);
  },
);

// POST /v1/drives/:driveId/files/upload/:uploadId/commit
drivesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{driveId}/files/upload/{uploadId}/commit',
    tags: ['drives'],
    summary: 'Commit a block upload',
    description: 'Lands the whole file at once, once every block storage lacked was sent. Safe to send again: a commit that landed answers the same.',
    ...auth,
    request: { params: UploadParams },
    responses: {
      200: json(z.object({ path: z.string(), size: z.number() }), 'Uploaded'),
      ...errors(400, 401, 403, 404, 409, 503),
    },
  }),
  async (c) => {
    const { caller, upload } = await callerUpload(c);
    // ponytail: storage's commit takes no If-Match, so the check and the commit
    // are two steps; a save landing between them is overwritten. Add it when storage does.
    if (upload.ifMatch) {
      const current = await withStorage(() => currentFileVersion(caller.drive, upload.path));
      if (!current || !sameVersion(current, upload.ifMatch)) fail(409, FILE_CHANGED_MESSAGE, 'file_changed');
    }
    const committed = await withUploadStorage(() =>
      writeDriveVolume(caller.drive, (volume) => commitVolumeUpload(volume, upload.uploadId)),
    );
    await recordDriveCommitAuthor(caller.drive.driveId, parseVolumeWriteCommit(committed), {
      userId: caller.userId,
      sessionId: callerKortixSessionId(c),
    });
    noteDriveWrite(caller.drive.driveId);
    forgetDriveUsage(caller.drive.platinumVolumeName);
    return c.json({ path: upload.path, size: upload.size });
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
  async (c) => {
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
    responses: {
      200: json(z.object({ from: z.string(), to: z.string(), pendingSessions: z.number().optional() }), 'Moved'),
      ...errors(400, 401, 403, 404, 409, 503),
    },
  }),
  async (c) => {
    const caller = await loadDrive(c);
    const body = c.req.valid('json') as { from: string; to: string };
    const from = drivePath(body.from, { allowRoot: false });
    const to = drivePath(body.to, { allowRoot: false });
    if (to === from || to.startsWith(`${from}/`)) fail(400, 'A folder cannot be moved into itself');
    if (structural(from, caller)) fail(400, 'This folder cannot be moved or renamed');
    if (parentOf(to) === USERS_DIR) fail(400, 'Put files in a folder');
    need(caller, from, 'write');
    need(caller, to, 'write');
    // The top level holds only folders: renaming a team folder is fine, a file is not.
    if (parentOf(to) === '/') {
      const stat = await withStorage(() => readDriveVolume(caller.drive, (volume) => statVolumeFile(volume, from), notFound));
      if (stat.type !== 'dir') fail(400, 'Put files in a folder');
    }
    // Moving a shared folder changes who can reach it: only someone who may change its sharing.
    if (caller.grants.some((g) => g.source !== 'system' && pathWithinFolder(g.path, from))) need(caller, from, 'manage');
    const pendingSessions = await withStorage(() => moveDriveFolder(caller.drive, from, to, notFound));
    noteDriveWrite(caller.drive.driveId);
    return c.json({ from, to, ...(pendingSessions ? { pendingSessions } : {}) });
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
    responses: {
      204: { description: 'Deleted' },
      202: json(PendingSchema, 'Deleted; running sessions not yet in line with its sharing'),
      ...errors(400, 401, 403, 404, 409, 503),
    },
  }),
  async (c) => {
    const caller = await loadDrive(c);
    const path = drivePath(c.req.query('path'), { allowRoot: false });
    if (structural(path, caller)) fail(400, 'This folder cannot be deleted');
    need(caller, path, 'write');
    const shared = caller.grants.filter((g) => g.grantId && pathWithinFolder(g.path, path));
    if (shared.some((g) => g.source !== 'system')) need(caller, path, 'manage');
    const recursive = c.req.query('recursive') === 'true' || c.req.query('recursive') === '1';
    await withStorage(() =>
      readDriveVolume(
        caller.drive,
        (volume) =>
          removeVolumeFile(volume, path, recursive).catch((err) => {
            if (!recursive && err instanceof DriveStorageError && err.status === 409 && err.code !== 'volume_busy') {
              fail(409, 'This folder is not empty: delete it with everything in it');
            }
            throw err;
          }),
        notFound,
      ),
    );
    for (const g of shared) await removeFolderGrant(caller.drive, g.grantId!);
    const pendingSessions = shared.length ? await enforceProjectMounts(caller.drive) : 0;
    noteDriveWrite(caller.drive.driveId);
    forgetDriveUsage(caller.drive.platinumVolumeName);
    if (pendingSessions) return c.json({ pendingSessions }, 202);
    return c.body(null, 204);
  },
);

// ─── Sharing ──────────────────────────────────────────────────────────────

async function grantLabels(drive: DriveRow, grants: FolderGrant[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const users = grants.filter((g) => g.principalType === 'user').map((g) => g.principalId);
  const groups = grants.filter((g) => g.principalType === 'group').map((g) => g.principalId);
  const agents = grants.filter((g) => g.principalType === 'agent').map((g) => g.principalId);
  const [emails, { groups: groupRows, agents: agentRows }] = await Promise.all([userEmails(users), principalNames(groups, agents)]);
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
  async (c) => {
    const caller = await loadDrive(c);
    const path = drivePath(c.req.query('path'), { allowRoot: true });
    const access = path === '/' ? folderAccess('/', caller.grants, caller.subject) : need(caller, path, 'read');
    const covering = grantsCovering(path, caller.grants, privateFolders(caller));
    const labels = await grantLabels(caller.drive, covering);
    return c.json({
      path,
      access,
      grantable: grantableFolder(path, privateFolders(caller)),
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
    responses: {
      200: json(z.object({ grantId: z.string(), pendingSessions: z.number().optional() }), 'Shared'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c) => {
    const caller = await loadDrive(c);
    const body = c.req.valid('json') as z.infer<typeof ShareBody>;
    const path = drivePath(body.path, { allowRoot: false });
    if (!grantableFolder(path, privateFolders(caller))) fail(400, 'Share a folder inside Files');
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
      const existing = await projectAgentServiceAccount(drive.projectId!, name);
      if (!declared.includes(name) && !existing) fail(404, 'No agent by that name in this project');
      principalId = existing ?? (await ensureAgentServiceAccount({ accountId: drive.accountId, projectId: drive.projectId!, agentName: name }));
    } else {
      if (!body.principalId || !isUuid(body.principalId)) fail(400, 'principalId is required');
      principalId = body.principalId;
      if (body.principalType === 'user') {
        if (path === caller.personalFolder && principalId === caller.userId) fail(400, 'This is already your folder');
        if (!(await isAccountMember(drive.accountId, principalId))) fail(404, 'That person is not a member of this account');
      }
    }
    const grantId = await setFolderGrant({
      drive,
      path,
      principal: { type: body.principalType, id: principalId },
      level: body.level,
      grantedBy: caller.userId,
    });
    const pendingSessions = await enforceProjectMounts(drive);
    return c.json({ grantId, ...(pendingSessions ? { pendingSessions } : {}) });
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
    responses: {
      204: { description: 'Removed' },
      202: json(PendingSchema, 'Removed; running sessions not yet in line'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c) => {
    const caller = await loadDrive(c);
    const grantId = c.req.param('grantId');
    const grant = isUuid(grantId) ? caller.grants.find((g) => g.grantId === grantId) : undefined;
    if (!grant) fail(404, 'Grant not found');
    if (grant.source === 'system' && grant.principalType === 'user' && personalFolderOf(grant.path) === grant.path) {
      fail(400, 'A person always has their own folder');
    }
    need(caller, grant.path, 'manage');
    await removeFolderGrant(caller.drive, grantId);
    const pendingSessions = await enforceProjectMounts(caller.drive);
    // 202: the grant is gone, but a running session still mounts the folder
    // until its detach lands (retried by the drive worker, refused at the API meanwhile).
    if (pendingSessions) return c.json({ pendingSessions }, 202);
    return c.body(null, 204);
  },
);

// GET /v1/drives/:driveId/agents/:agentName/mounts
const AgentMountSchema = z.object({
  /** The Files folder, e.g. `/Company/Reports`. */
  path: z.string(),
  /** Where a session sees it, e.g. `/drives/Company/Reports`. */
  mountPath: z.string(),
  readOnly: z.boolean(),
  /** `agent`: shared with this agent. `project`: shared with everyone in the project. */
  via: z.enum(['agent', 'project']),
  /** The agent's own grant on this folder, to change or remove; absent when it comes through the project. */
  grantId: z.string().optional(),
  level: LevelSchema,
});

const MountPlanSchema = z.object({ mounts: z.array(AgentMountSchema), skipped: z.array(z.string()), slots: z.number() });

/** The folders a new session mounts through an agent (when named) and through the project, planned as a boot plans them. */
async function mountPlan(c: DriveContext, agentName: string | null) {
  const caller = await loadDrive(c);
  need(caller, '/', 'read');
  const { drive } = caller;
  const [grants, agentId, slots] = await Promise.all([
    listFolderGrants(drive),
    agentName ? projectAgentServiceAccount(drive.projectId!, agentName) : Promise.resolve(null),
    sandboxMountLimit(),
  ]);
  const candidates = sessionMountCandidates(grants, {
    agentId,
    owner: null,
    groupIds: new Set(),
    own: null,
    channelFolder: null,
    privateChannelFolders: privateFolders(caller),
  });
  const plan = planFolderMounts(candidates, slots, privateFolders(caller));
  const ownGrant = (path: string) =>
    agentId ? grants.find((g) => g.principalType === 'agent' && g.principalId === agentId && g.path === path) : undefined;
  const projectGrant = (path: string) =>
    grants.find((g) => g.principalType === 'project' && g.path === path && g.source !== 'system');
  return {
    mounts: plan.mounts.map((m) => {
      const viaAgent = candidates.some((x) => x.path === m.path && x.priority === 0);
      const grant = agentName ? ownGrant(m.path) : projectGrant(m.path);
      const level = candidates
        .filter((x) => x.path === m.path)
        .reduce<FolderLevel>((acc, x) => (RANK_OF[x.level] > RANK_OF[acc] ? x.level : acc), 'read');
      return {
        path: m.path,
        mountPath: m.mountPath,
        readOnly: m.readOnly,
        via: viaAgent ? ('agent' as const) : ('project' as const),
        ...(grant?.grantId ? { grantId: grant.grantId } : {}),
        level,
      };
    }),
    skipped: plan.skipped,
    slots,
  };
}

drivesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{driveId}/mounts',
    tags: ['drives'],
    summary: 'The folders every session mounts',
    description:
      "The Files folders every new session of the project mounts: the ones shared with everyone in the project, where each appears and read-only or not. `grantId` is the project grant to change or remove (absent for the ones Kortix made, such as Company). An agent adds its own folders (`/agents/{agentName}/mounts`); a person's own folders join the sessions they start.",
    ...auth,
    request: { params: DriveParams },
    responses: { 200: json(MountPlanSchema, 'Project mounts'), ...errors(401, 404) },
  }),
  async (c) => c.json(await mountPlan(c, null)),
);

drivesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{driveId}/agents/{agentName}/mounts',
    tags: ['drives'],
    summary: 'The folders an agent mounts',
    description:
      "The Files folders a new session of this agent mounts, where, and read-only or not: the folders shared with the agent and with everyone in the project, planned the way a session boots (a folder inside a mounted one at the same level or less is not mounted twice). A person's own folder and folders shared with them join a session they start and are not listed. `skipped` names folders past the sandbox's mount slots.",
    ...auth,
    request: { params: DriveParams.extend({ agentName: z.string().min(1).max(128) }) },
    responses: { 200: json(MountPlanSchema, 'Agent mounts'), ...errors(401, 404) },
  }),
  async (c) => c.json(await mountPlan(c, c.req.param('agentName') ?? '')),
);

const RANK_OF: Record<FolderLevel, number> = { read: 1, write: 2, manage: 3 };

// GET /v1/drives/:driveId/principals
drivesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{driveId}/principals',
    tags: ['drives'],
    summary: 'Who a folder can be shared with',
    description: 'The account’s people and teams the caller may see, and the project’s agents.',
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
  async (c) => {
    const { drive } = await loadDrive(c);
    const [principals, visible] = await Promise.all([
      shareablePrincipals(drive),
      visibleDirectory(await actorOf(c, drive.accountId)),
    ]);
    const { agentNames } = principals;
    const members = principals.members.filter((id) => !visible.userIds || visible.userIds.has(id));
    const teams = principals.teams.filter((t) => !visible.groupIds || visible.groupIds.has(t.id));
    const emails = await userEmails(members);
    const agents = [...new Set([...(await projectAgentNames(drive.projectId!)), ...agentNames].filter(Boolean))].sort();
    return c.json({
      people: members.map((id) => ({ id, label: emails.get(id) ?? id })),
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
  async (c) => {
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
  async (c) => {
    const caller = await loadDrive(c);
    const conflictId = c.req.param('conflictId');
    if (!isUuid(conflictId)) fail(404, 'Conflict not found');
    const row = await driveConflict(caller.drive.driveId, conflictId);
    if (!row) fail(404, 'Conflict not found');
    need(caller, row.path, 'write');
    await dismissConflict(conflictId, caller.userId);
    return c.body(null, 204);
  },
);

/**
 * The restore floor compares a storage commit's time (Platinum's clock) with a
 * channel's `updated_at` (the API's clock), and a conversion's folder move
 * commits just before `updated_at` is written. A version within this margin
 * after the floor is refused too, so a storage clock up to 10 minutes ahead
 * cannot let the last pre-conversion version through.
 * ponytail: a wall-clock margin; record the conversion's commit id if versions
 * right after a channel change must be restorable.
 */
const RESTORE_CLOCK_MARGIN_MS = 10 * 60_000;

/**
 * A restore is one whole-volume version: it rewrites every private channel's
 * folder and can bring a converted channel's files back into `/Company`.
 * While the project has a private channel, only an admin who is a member of
 * every one may restore (403), and only to a version newer than each private
 * channel's last change (its creation, conversion or rename: 409
 * `restore_crosses_private_channel`).
 */
async function refuseRestoreAcrossPrivateChannels(caller: Caller, versionId: string, versionNotFound: () => never): Promise<void> {
  const channels = await privateChannelRows(caller.drive.projectId!);
  if (channels.length === 0) return;
  const folders = new Set(channels.flatMap((ch) => (ch.folder ? [ch.folder] : [])));
  const visible = new Set(caller.grants.map((g) => privateChannelFolderOf(g.path, folders)).filter(Boolean));
  if (channels.some((ch) => ch.folder && !visible.has(ch.folder))) {
    fail(403, 'Restoring Files would rewrite a private channel you are not in. Ask a member of every private channel.', 'restore_crosses_private_channel');
  }
  const commits = await withStorage(() => readDriveVolume(caller.drive, (volume) => listVolumeCommits(volume), () => []));
  const target = commits.find((commit) => commit.id === versionId);
  if (!target) versionNotFound();
  const newest = Math.max(...channels.map((ch) => ch.updatedAt.getTime()));
  if (Date.parse(target!.created_at) < newest + RESTORE_CLOCK_MARGIN_MS) {
    fail(409, 'This version is older than a private channel’s last change: restoring it could bring that channel’s files back where others can read them.', 'restore_crosses_private_channel');
  }
}

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
  async (c) => {
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
    description:
      'Project admins only. Adds a new version whose files equal the chosen one. Later versions stay in the history. ' +
      'With a private channel in the project: an admin outside one gets 403 and a version older than a private channel’s last change gets 409, both `restore_crosses_private_channel`.',
    ...auth,
    request: {
      params: DriveParams,
      body: { required: true, content: { 'application/json': { schema: z.object({ versionId: z.string().min(1) }) } } },
    },
    responses: { 204: { description: 'Restored' }, ...errors(400, 401, 403, 404, 409, 503) },
  }),
  async (c) => {
    const caller = await loadDrive(c);
    if (!caller.subject.admin) fail(403, 'Only a project admin can restore Files');
    const { versionId } = c.req.valid('json') as { versionId: string };
    if (versionId === 'head' || !/^[A-Za-z0-9_-]{1,128}$/.test(versionId)) fail(400, 'Invalid version');
    const versionNotFound = (): never => fail(404, 'Version not found');
    await refuseRestoreAcrossPrivateChannels(caller, versionId, versionNotFound);
    try {
      await readDriveVolume(caller.drive, (volume) => restoreVolume(volume, versionId), versionNotFound);
    } catch (err) {
      if (err instanceof DriveStorageError && err.status === 404) versionNotFound();
      if (err instanceof DriveStorageError) fail(err.status, err.message, err.code);
      throw err;
    }
    noteDriveWrite(caller.drive.driveId);
    forgetDriveUsage(caller.drive.platinumVolumeName);
    return c.body(null, 204);
  },
);
