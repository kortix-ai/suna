import { sessionSandboxes } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { Context } from 'hono';
import { normalizeDrivePath } from '../../drives/access';
import { noteDriveWrite } from '../../drives/conflicts';
import {
  type DriveRow,
  type RecordedDriveMount,
  getDrive,
  openVolumeFor,
  readDriveVolume,
  recordedDriveMounts,
  sessionDriveNotes,
  writeDriveVolume,
} from '../../drives/service';
import { isDriveSyncBox, syncMountAllows, syncVersionToken, withSyncPathLock } from '../../drives/sync';
import {
  DriveStorageError,
  commitVolumeUpload,
  getDriveVolume,
  listVolumeFilesPage,
  moveVolumeFile,
  planVolumeUpload,
  putVolumeUploadBlock,
  readVolumeFile,
  removeVolumeFile,
  statVolumeFile,
  writeVolumeFile,
} from '../../drives/volumes';
import { isSessionSandboxCredential } from '../../middleware/session-sandbox-credential';
import { isUuid } from '../../shared/validate';
import { db } from '../../shared/db';
import { projectsApp } from '../lib/app';

// Drive sync: the file calls a session box's daemon makes to keep the drives
// it was given in sync when it runs off Platinum (see drives/sync.ts). Only
// the session's own sandbox credential reaches them, only while the sandbox
// is live, only for the drives recorded on its row, only inside the folder
// each one covers, and a write only through a read-write drive. The box never
// sees the storage credential: these routes call storage for it.

const MAX_PUT_BYTES = 64 * 1024 * 1024;
const BLOCK_BYTES = 1024 * 1024;

type Ctx = Context<any>;

const param = (c: Ctx, name: string): string => c.req.param(name) ?? '';

interface SyncScope {
  sandboxId: string;
  accountId: string;
  mounts: RecordedDriveMount[];
  synced: boolean;
}

function refuse(c: Ctx, status: 400 | 403 | 404 | 413, error: string): Response {
  return c.json({ error }, status);
}

/** The session box calling, or a refusal. */
async function scopeOf(c: Ctx): Promise<SyncScope | Response> {
  const projectId = param(c, 'projectId');
  const sessionId = param(c, 'sessionId');
  if (!isUuid(sessionId) || !isSessionSandboxCredential(c) || c.get('sessionId') !== sessionId) {
    return refuse(c, 403, 'Drive sync takes the session sandbox credential');
  }
  const accountId = c.get('accountId') as string | undefined;
  if (!accountId) return refuse(c, 403, 'Drive sync takes the session sandbox credential');
  const [row] = await db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      provider: sessionSandboxes.provider,
      metadata: sessionSandboxes.metadata,
    })
    .from(sessionSandboxes)
    .where(
      and(
        eq(sessionSandboxes.sessionId, sessionId),
        eq(sessionSandboxes.projectId, projectId),
        eq(sessionSandboxes.accountId, accountId),
        inArray(sessionSandboxes.status, ['provisioning', 'active']),
      ),
    )
    .limit(1);
  if (!row) return refuse(c, 403, 'The session sandbox is not live');
  return {
    sandboxId: row.sandboxId,
    accountId,
    mounts: recordedDriveMounts(row.metadata),
    synced: isDriveSyncBox(row),
  };
}

/** The drive and the checked path, or a refusal. Drives not given to the session read as missing. */
async function driveFor(
  c: Ctx,
  need: 'read' | 'write',
  rawPath: string | undefined,
): Promise<{ drive: DriveRow; path: string } | Response> {
  const scope = await scopeOf(c);
  if (scope instanceof Response) return scope;
  if (!scope.synced) return refuse(c, 404, 'This session mounts its drives; there is nothing to sync');
  const driveId = param(c, 'driveId');
  const path = normalizeDrivePath(rawPath);
  if (!path) return refuse(c, 400, 'Invalid path');
  if (!isUuid(driveId) || !syncMountAllows(scope.mounts, driveId, path, 'read')) {
    return refuse(c, 404, 'Drive not found');
  }
  if (need === 'write' && !syncMountAllows(scope.mounts, driveId, path, 'write')) {
    return refuse(c, 403, 'This drive is read-only in this session');
  }
  const drive = await getDrive(driveId);
  if (!drive || drive.accountId !== scope.accountId) return refuse(c, 404, 'Drive not found');
  return { drive, path };
}

async function storage<T>(c: Ctx, op: () => Promise<T>): Promise<T | Response> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof DriveStorageError) return c.json({ error: err.message, code: err.code }, err.status);
    throw err;
  }
}

const notFound = (): never => {
  throw new DriveStorageError(404, 'File or folder not found', 'path_not_found');
};

const base = '/:projectId/sessions/:sessionId/drive-sync';

// The drives to sync and where; `ready` stays false until the boot recorded them.
projectsApp.get(`${base}/mounts`, async (c: Ctx) => {
  const scope = await scopeOf(c);
  if (scope instanceof Response) return scope;
  if (!scope.synced) return c.json({ ready: false, mounts: [], notes: null });
  const { mounts, text } = await sessionDriveNotes(param(c, 'sessionId'));
  return c.json({
    ready: true,
    mounts: mounts.map((m) => ({
      driveId: m.driveId,
      name: m.name,
      mountPath: m.mountPath,
      readOnly: m.readOnly,
      ...(m.subdir ? { subdir: m.subdir } : {}),
    })),
    notes: text,
  });
});

// The drive's head commit: the daemon lists the drive again only when it moved.
projectsApp.get(`${base}/:driveId/head`, async (c: Ctx) => {
  // Any folder of the drive mounted here may ask: the head is the drive's, not a folder's.
  const mounted = await scopeOf(c);
  if (mounted instanceof Response) return mounted;
  const mount = mounted.synced ? mounted.mounts.find((m) => m.driveId === param(c, 'driveId')) : undefined;
  const got = await driveFor(c, 'read', mount?.subdir ?? '/');
  if (got instanceof Response) return got;
  const head = await storage(c, () =>
    readDriveVolume(got.drive, (volume) => getDriveVolume(volume).then((v) => v.head_commit_id ?? null), () => null),
  );
  if (head instanceof Response) return head;
  return c.json({ head });
});

projectsApp.get(`${base}/:driveId/files`, async (c: Ctx) => {
  const got = await driveFor(c, 'read', c.req.query('path'));
  if (got instanceof Response) return got;
  const page = await storage(c, () =>
    readDriveVolume(
      got.drive,
      (volume) =>
        listVolumeFilesPage(volume, got.path, {
          recursive: c.req.query('recursive') === 'true',
          cursor: c.req.query('cursor') || undefined,
        }),
      () => ({ entries: [], next_cursor: null }),
    ),
  );
  if (page instanceof Response) return page;
  return c.json(page);
});

projectsApp.get(`${base}/:driveId/files/stat`, async (c: Ctx) => {
  const got = await driveFor(c, 'read', c.req.query('path'));
  if (got instanceof Response) return got;
  const st = await storage(c, () => readDriveVolume(got.drive, (volume) => statVolumeFile(volume, got.path), notFound));
  if (st instanceof Response) return st;
  return c.json(st);
});

projectsApp.get(`${base}/:driveId/files/content`, async (c: Ctx) => {
  const got = await driveFor(c, 'read', c.req.query('path'));
  if (got instanceof Response) return got;
  const upstream = await storage(c, () =>
    readDriveVolume(got.drive, (volume) => readVolumeFile(volume, got.path, c.req.header('range') ?? undefined), notFound),
  );
  if (upstream instanceof Response && !upstream.ok) return upstream;
  const res = upstream as Response;
  const headers = new Headers({ 'content-type': 'application/octet-stream', 'cache-control': 'private, no-store' });
  for (const h of ['content-length', 'content-range', 'etag', 'accept-ranges', 'x-pt-content-length']) {
    const value = res.headers.get(h);
    if (value) headers.set(h, value);
  }
  return new Response(res.body, { status: res.status === 206 ? 206 : 200, headers });
});

projectsApp.put(`${base}/:driveId/files/content`, async (c: Ctx) => {
  const got = await driveFor(c, 'write', c.req.query('path'));
  if (got instanceof Response) return got;
  if (got.path === '/') return refuse(c, 400, 'Invalid path');
  const declared = Number(c.req.header('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_PUT_BYTES) return refuse(c, 413, 'Use the block upload for files this large');
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.byteLength > MAX_PUT_BYTES) return refuse(c, 413, 'Use the block upload for files this large');
  const written = await storage(c, () =>
    conditionalWrite(got.drive, got.path, c.req.query('expect'), () =>
      writeDriveVolume(got.drive, (volume) => writeVolumeFile(volume, got.path, body, { overwrite: true })),
    ),
  );
  if (written instanceof Response) return written;
  if (written === REMOTE_CHANGED) return remoteChanged(c);
  noteDriveWrite(got.drive.driveId);
  return c.json(written);
});

// Block upload, for large files: plan names every file it writes, each must be writable.
projectsApp.post(`${base}/:driveId/files/upload`, async (c: Ctx) => {
  const plan = (await c.req.json().catch(() => null)) as { files?: Array<{ path?: unknown }>; dirs?: unknown[] } | null;
  if (!plan || !Array.isArray(plan.files) || !plan.files.length || plan.dirs?.length) return refuse(c, 400, 'Invalid upload plan');
  let target: { drive: DriveRow; path: string } | null = null;
  for (const f of plan.files) {
    const got = await driveFor(c, 'write', typeof f?.path === 'string' ? f.path : undefined);
    if (got instanceof Response) return got;
    if (got.path === '/') return refuse(c, 400, 'Invalid path');
    f.path = got.path;
    target = got;
  }
  const drive = target!.drive;
  const r = await storage(c, async () => planVolumeUpload(await openVolumeFor(drive), { ...plan, overwrite: true }));
  if (r instanceof Response) return r;
  return c.json(r as Record<string, unknown>);
});

projectsApp.put(`${base}/:driveId/files/upload/:uploadId/blocks/:sha`, async (c: Ctx) => {
  // The plan checked every path; a block only lands for a plan of this drive.
  const drive = await anyWritable(c);
  if (drive instanceof Response) return drive;
  const sha = param(c, 'sha');
  if (!/^[0-9a-f]{64}$/.test(sha)) return refuse(c, 400, 'Invalid block');
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.byteLength > BLOCK_BYTES) return refuse(c, 413, 'A block is at most 1 MiB');
  const r = await storage(c, () => putVolumeUploadBlock(drive.platinumVolumeName, param(c, 'uploadId'), sha, body));
  if (r instanceof Response) return r;
  return c.body(null, 204);
});

projectsApp.post(`${base}/:driveId/files/upload/:uploadId/commit`, async (c: Ctx) => {
  const drive = await anyWritable(c);
  if (drive instanceof Response) return drive;
  // `path` + `expect`: the file the plan writes and the version it was based on.
  const target = c.req.query('path');
  let path: string | null = null;
  if (target !== undefined) {
    const got = await driveFor(c, 'write', target);
    if (got instanceof Response) return got;
    path = got.path;
  }
  const commit = () => commitVolumeUpload(drive.platinumVolumeName, param(c, 'uploadId'));
  const r = await storage(c, () =>
    path ? conditionalWrite(drive, path, c.req.query('expect'), commit) : commit(),
  );
  if (r instanceof Response) return r;
  if (r === REMOTE_CHANGED) return remoteChanged(c);
  noteDriveWrite(drive.driveId);
  return c.json(r as Record<string, unknown>);
});

const REMOTE_CHANGED = Symbol('remote_changed');

function remoteChanged(c: Ctx): Response {
  return c.json({ error: 'The file changed on the drive since this box last read it', code: 'remote_changed' }, 409);
}

/**
 * The write, only when the drive's file is still the version the box based
 * its change on (`expect`: "size:mtime" or "absent"). Checked and written
 * under a per-path lock (drives/sync.ts withSyncPathLock, which documents
 * what it cannot cover). Without `expect` the write is unconditional.
 */
async function conditionalWrite<T>(
  drive: DriveRow,
  path: string,
  expect: string | undefined,
  write: () => Promise<T>,
): Promise<T | typeof REMOTE_CHANGED> {
  if (!expect) return write();
  return withSyncPathLock(drive.driveId, path, async () => {
    const current = await readDriveVolume(
      drive,
      (volume) =>
        statVolumeFile(volume, path).catch((err) => {
          if (err instanceof DriveStorageError && err.status === 404) return null;
          throw err;
        }),
      () => null,
    );
    if (syncVersionToken(current) !== expect) return REMOTE_CHANGED;
    return write();
  });
}

/** The drive, when the session writes any part of it (the block and commit calls of a checked plan). */
async function anyWritable(c: Ctx): Promise<DriveRow | Response> {
  const scope = await scopeOf(c);
  if (scope instanceof Response) return scope;
  const driveId = param(c, 'driveId');
  if (!scope.synced || !isUuid(driveId) || !scope.mounts.some((m) => m.driveId === driveId && !m.readOnly)) {
    return refuse(c, 403, 'This drive is read-only in this session');
  }
  const drive = await getDrive(driveId);
  if (!drive || drive.accountId !== scope.accountId) return refuse(c, 404, 'Drive not found');
  return drive;
}

projectsApp.post(`${base}/:driveId/files/move`, async (c: Ctx) => {
  const body = (await c.req.json().catch(() => null)) as { src?: unknown; dst?: unknown } | null;
  const src = await driveFor(c, 'write', typeof body?.src === 'string' ? body.src : undefined);
  if (src instanceof Response) return src;
  const dst = await driveFor(c, 'write', typeof body?.dst === 'string' ? body.dst : undefined);
  if (dst instanceof Response) return dst;
  if (src.path === '/' || dst.path === '/') return refuse(c, 400, 'Invalid path');
  const r = await storage(c, () => writeDriveVolume(src.drive, (volume) => moveVolumeFile(volume, src.path, dst.path)));
  if (r instanceof Response) return r;
  noteDriveWrite(src.drive.driveId);
  return c.json({ ok: true });
});

projectsApp.delete(`${base}/:driveId/files`, async (c: Ctx) => {
  const got = await driveFor(c, 'write', c.req.query('path'));
  if (got instanceof Response) return got;
  if (got.path === '/') return refuse(c, 400, 'The drive root cannot be removed');
  const r = await storage(c, () =>
    readDriveVolume(got.drive, (volume) => removeVolumeFile(volume, got.path, c.req.query('recursive') === 'true'), () => undefined),
  );
  if (r instanceof Response) return r;
  noteDriveWrite(got.drive.driveId);
  return c.json({ ok: true });
});
