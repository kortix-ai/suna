/**
 * Shared filesystems — /v1/projects/:projectId/filesystems*
 *
 * "A Google Drive between the agents": a named volume of files that outlives
 * every session, so two agents in one project can hand state to each other
 * without going through git. Deliberately separate from
 * /v1/projects/:projectId/files*, which reads the project REPO — config, cloned
 * per session, versioned by git. State and config do not share a surface.
 *
 * Authorization rides the ordinary project ladder: 'read' to read or list,
 * 'write' to create, write or delete. Nothing here is a new authority — a
 * caller who can already write the project can already write its state.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json } from '../../openapi';
import {
  createFilesystem,
  deleteFile,
  deleteFilesystem,
  findFilesystem,
  listFilesystems,
  listFiles,
  MAX_FILE_BYTES,
  putFile,
  readFile,
  statFile,
} from '../../filesystems/service';
import { loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';

const FilesystemSchema = z.object({
  filesystem_id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const FileSchema = z.object({
  path: z.string(),
  size: z.number(),
  sha256: z.string(),
  content_type: z.string(),
  storage: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

const serializeFs = (f: {
  filesystemId: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  filesystem_id: f.filesystemId,
  name: f.name,
  description: f.description,
  created_at: f.createdAt.toISOString(),
  updated_at: f.updatedAt.toISOString(),
});

const serializeFile = (f: {
  path: string;
  size: number;
  sha256: string;
  contentType: string;
  storage: string;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  path: f.path,
  size: f.size,
  sha256: f.sha256,
  content_type: f.contentType,
  storage: f.storage,
  created_at: f.createdAt.toISOString(),
  updated_at: f.updatedAt.toISOString(),
});

// ---- filesystems --------------------------------------------------------

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/filesystems',
    tags: ['projects'],
    summary: 'List the project shared filesystems',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: {
      200: json(z.object({ filesystems: z.array(FilesystemSchema) }), 'Filesystems'),
      ...errors(403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'project not found' }, 404);
    const rows = await listFilesystems(projectId);
    return c.json({ filesystems: rows.map(serializeFs) }, 200);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/filesystems',
    tags: ['projects'],
    summary: 'Create a shared filesystem (idempotent by name)',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({ name: z.string(), description: z.string().optional() }),
          },
        },
      },
    },
    responses: {
      200: json(FilesystemSchema, 'Filesystem already existed'),
      201: json(FilesystemSchema, 'Filesystem created'),
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'project not found' }, 404);

    const body = await c.req.json().catch(() => ({}));
    const result = await createFilesystem(projectId, String(body?.name ?? ''), body?.description);
    if (!result.ok) return c.json({ error: result.reason }, 400);
    return c.json(serializeFs(result.filesystem), result.created ? 201 : 200);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/filesystems/{name}',
    tags: ['projects'],
    summary: 'Delete a shared filesystem and every file in it',
    ...auth,
    request: { params: z.object({ projectId: z.string(), name: z.string() }) },
    responses: { 204: { description: 'Deleted' }, ...errors(403, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'project not found' }, 404);
    const removed = await deleteFilesystem(projectId, c.req.param('name'));
    if (!removed) return c.json({ error: 'filesystem not found' }, 404);
    return c.body(null, 204);
  },
);

// ---- files --------------------------------------------------------------

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/filesystems/{name}/files',
    tags: ['projects'],
    summary: 'List files in a shared filesystem',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), name: z.string() }),
      query: z.object({ prefix: z.string().optional(), limit: z.string().optional() }),
    },
    responses: {
      200: json(z.object({ files: z.array(FileSchema) }), 'Files'),
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'project not found' }, 404);
    const fs = await findFilesystem(projectId, c.req.param('name'));
    if (!fs) return c.json({ error: 'filesystem not found' }, 404);

    const limitRaw = c.req.query('limit');
    const result = await listFiles({
      filesystemId: fs.filesystemId,
      prefix: c.req.query('prefix') ?? '',
      limit: limitRaw ? Number(limitRaw) : undefined,
    });
    if (!result.ok) return c.json({ error: result.reason }, 400);
    return c.json({ files: result.files.map(serializeFile) }, 200);
  },
);

/**
 * The path is the REST of the URL, so `notes/2026/plan.md` stays one readable
 * path instead of an opaque encoded segment. Hono gives it as a wildcard.
 */
const filePath = (c: any): string => {
  const full = c.req.path as string;
  const marker = '/files/';
  const at = full.indexOf(marker, full.indexOf('/filesystems/'));
  return at === -1 ? '' : full.slice(at + marker.length);
};

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/filesystems/{name}/files/{path}',
    tags: ['projects'],
    summary: 'Write a file into a shared filesystem',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), name: z.string(), path: z.string() }),
      body: { content: { 'application/octet-stream': { schema: z.any() } } },
    },
    responses: {
      200: json(FileSchema, 'File replaced'),
      201: json(FileSchema, 'File created'),
      ...errors(400, 403, 404, 413),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'project not found' }, 404);
    const fs = await findFilesystem(projectId, c.req.param('name'));
    if (!fs) return c.json({ error: 'filesystem not found' }, 404);

    const buf = new Uint8Array(await c.req.arrayBuffer());
    if (buf.byteLength > MAX_FILE_BYTES) {
      return c.json({ error: `file exceeds the ${MAX_FILE_BYTES} byte limit` }, 413);
    }

    const result = await putFile({
      filesystemId: fs.filesystemId,
      path: filePath(c),
      bytes: buf,
      contentType: c.req.header('content-type') ?? undefined,
    });
    if (!result.ok) return c.json({ error: result.reason }, 400);
    return c.json(serializeFile(result.file), result.created ? 201 : 200);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/filesystems/{name}/files/{path}',
    tags: ['projects'],
    summary: 'Read a file from a shared filesystem',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), name: z.string(), path: z.string() }),
    },
    responses: { 200: { description: 'File bytes' }, ...errors(403, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'project not found' }, 404);
    const fs = await findFilesystem(projectId, c.req.param('name'));
    if (!fs) return c.json({ error: 'filesystem not found' }, 404);

    const result = await readFile(fs.filesystemId, filePath(c));
    if (!result.ok) {
      // `bytes_missing` is a metadata row whose blob is gone — a real fault,
      // not "no such file". Saying 404 for both would hide it.
      return result.reason === 'not_found'
        ? c.json({ error: 'file not found' }, 404)
        : c.json({ error: 'file content is unavailable' }, 500);
    }
    return c.body(result.bytes, 200, {
      'content-type': result.file.contentType,
      'content-length': String(result.file.size),
      etag: `"${result.file.sha256}"`,
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/filesystems/{name}/files/{path}',
    tags: ['projects'],
    summary: 'Delete a file from a shared filesystem',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), name: z.string(), path: z.string() }),
    },
    responses: { 204: { description: 'Deleted' }, ...errors(403, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'project not found' }, 404);
    const fs = await findFilesystem(projectId, c.req.param('name'));
    if (!fs) return c.json({ error: 'filesystem not found' }, 404);
    const removed = await deleteFile(fs.filesystemId, filePath(c));
    if (!removed) return c.json({ error: 'file not found' }, 404);
    return c.body(null, 204);
  },
);

export { statFile };
