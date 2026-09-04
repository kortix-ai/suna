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

    // `Number('abc')` is NaN, and Math.min/max propagate it — which drops the
    // LIMIT clause entirely and returns every row. Reject rather than ignore.
    const limitRaw = c.req.query('limit');
    let limit: number | undefined;
    if (limitRaw !== undefined && limitRaw !== '') {
      const parsed = Number(limitRaw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return c.json({ error: 'limit must be a positive integer' }, 400);
      }
      limit = parsed;
    }
    const result = await listFiles({
      filesystemId: fs.filesystemId,
      prefix: c.req.query('prefix') ?? '',
      limit,
    });
    if (!result.ok) return c.json({ error: result.reason }, 400);
    return c.json({ files: result.files.map(serializeFile) }, 200);
  },
);

/**
 * The file path travels as `?path=`, not as a URL segment.
 *
 * A path like `notes/2026/plan.md` contains slashes, and an OpenAPI `{path}`
 * parameter matches ONE segment — so a segment-based route 404s on every real
 * nested path (measured against the deployed preview before this changed).
 * `/v1/projects/:id/files/content?path=` already solves it the same way, so
 * this follows the convention the API established rather than inventing a
 * wildcard the typed router does not support.
 */
const filePath = (c: any): string => String(c.req.query('path') ?? '');

/**
 * Read a request body, aborting the moment it exceeds `limit`.
 *
 * The counter is the only guard: this route has no ambient memory ceiling to
 * fall back on, so reading first and measuring second is how one request OOMs
 * the shared pod for every tenant.
 */
async function readBodyAtMost(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > limit) throw new Error('body too large');
      // COPY: the reader may reuse the backing ArrayBuffer.
      parts.push(new Uint8Array(value));
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // already gone
    }
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/filesystems/{name}/files/content',
    tags: ['projects'],
    summary: 'Write a file into a shared filesystem',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), name: z.string() }),
      query: z.object({ path: z.string() }),
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

    // Refuse on the DECLARED length first — cheapest rejection when it is there.
    const declared = Number(c.req.header('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
      return c.json({ error: `file exceeds the ${MAX_FILE_BYTES} byte limit` }, 413);
    }
    // Then COUNT while reading, never `arrayBuffer()`. A chunked request
    // declares no length, so an oversized body would otherwise be fully
    // resident before any check ran — and the image that ships pins
    // `BUN_VERSION=1.2` (apps/api/Dockerfile), where Bun applies NO
    // maxRequestBodySize to a chunked body. Reproduced on bun 1.2.23: a
    // 1600 MiB chunked PUT in a 2 GB cgroup killed the process, while the same
    // probe on a laptop's bun 1.3.14 answered 413 — the protection exists in
    // dev and not in production. Same counting-reader shape as
    // `readAtMost` in routes/secret-relay.ts, for the same reason.
    let buf: Uint8Array;
    try {
      buf = await readBodyAtMost(c.req.raw.body, MAX_FILE_BYTES);
    } catch {
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
    path: '/{projectId}/filesystems/{name}/files/content',
    tags: ['projects'],
    summary: 'Read a file from a shared filesystem',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), name: z.string() }),
      query: z.object({ path: z.string() }),
    },
    responses: { 200: { description: 'File bytes' }, ...errors(400, 403, 404, 500) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'project not found' }, 404);
    const fs = await findFilesystem(projectId, c.req.param('name'));
    if (!fs) return c.json({ error: 'filesystem not found' }, 404);

    const result = await readFile(fs.filesystemId, filePath(c));
    if (!result.ok) {
      // Three distinct causes, three distinct answers. Collapsing them into
      // 404 would report a configuration gap and a lost blob as "no such file".
      if (result.reason === 'not_found') return c.json({ error: 'file not found' }, 404);
      if (result.reason === 'storage_unavailable') {
        return c.json(
          { error: 'this file lives in a storage backend this deployment is not configured for' },
          500,
        );
      }
      return c.json({ error: 'file content is unavailable' }, 500);
    }
    return c.body(result.bytes, 200, {
      // The content type is caller-supplied and stored verbatim, so a file
      // written as text/html would otherwise execute in a browser on this
      // origin. nosniff stops the type being upgraded, and the attachment
      // disposition stops it rendering inline at all.
      'content-type': result.file.contentType,
      'content-length': String(result.file.size),
      'x-content-type-options': 'nosniff',
      'content-disposition': 'attachment',
      etag: `"${result.file.sha256}"`,
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/filesystems/{name}/files/content',
    tags: ['projects'],
    summary: 'Delete a file from a shared filesystem',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), name: z.string() }),
      query: z.object({ path: z.string() }),
    },
    responses: { 204: { description: 'Deleted' }, ...errors(400, 403, 404) },
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
