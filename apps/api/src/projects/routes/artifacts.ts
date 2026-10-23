// Artifacts (flag `artifacts`): HTML pages people and agents publish in a
// project — docs, slides, boards, dashboards, pages. Logic lives in
// `artifacts/service.ts`; the bytes are served by `artifacts/content-routes.ts`.
//
// Authorization, per route, for the caller's role AND an agent's
// `kortix_permissions` grant:
//   read  (types, list, get, versions, content)  project.read — every member
//   write (publish, update, restore, metadata,   project.session.start — anyone
//          share, delete, pin)                    who runs agents may publish
// On top, per artifact: view needs `canView`, every change but a pin needs
// `canEdit` (the creator, or project.write). A private artifact the caller
// may not view answers 404, never 403.
// Every route answers 403 `feature_disabled` while the project has the flag off.
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { auth, errors, json } from '../../openapi';
import { config } from '../../config';
import { PROJECT_ACTIONS } from '../../iam';
import { assertAgentScope } from '../../iam/agent-scope';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { assertProjectCapability, loadProjectForUser, projectCapabilityAllowed, resolveUserIdentities } from '../lib/access';
import { projectsApp } from '../lib/app';
import { DriveStorageError } from '../../drives/volumes';
import { ARTIFACT_TYPES, ARTIFACT_TYPE_KEYS } from '../../artifacts/kits';
import {
  ARTIFACTS_FLAG,
  ARTIFACT_VISIBILITIES,
  ArtifactError,
  artifactPublicContentUrl,
  artifactViewUrl,
  canEdit,
  canView,
  createArtifact,
  deleteArtifact,
  getArtifact,
  getVersion,
  isTextType,
  listArtifacts,
  listVersions,
  normalizeArtifactPath,
  publishVersion,
  readArtifactFile,
  restoreVersion,
  setPinned,
  updateArtifactMeta,
  type ArtifactFileRecord,
  type ArtifactRow,
  type ArtifactVersionRow,
} from '../../artifacts/service';

const ProjectParams = z.object({ projectId: z.string().uuid() });
const ArtifactParams = ProjectParams.extend({ artifactId: z.string().uuid() });
const TypeEnum = z.enum(ARTIFACT_TYPE_KEYS);
const VisibilityEnum = z.enum(ARTIFACT_VISIBILITIES);

const FileInputSchema = z.object({
  content: z.string().optional().openapi({ description: 'UTF-8 text.' }),
  content_base64: z.string().optional().openapi({ description: 'Bytes, base64. For images, fonts and other binary files.' }),
  content_type: z.string().max(200).optional().openapi({ description: 'Default: from the file extension.' }),
});

const PublishBody = z.object({
  title: z.string().min(1).max(200).optional().openapi({ description: "Default: the page's <title>, else Untitled." }),
  description: z.string().max(1000).nullable().optional(),
  type: TypeEnum.optional().openapi({ description: 'page (default), doc, slides, board, dashboard. The type picks the kit.' }),
  icon: z.string().max(40).nullable().optional(),
  visibility: VisibilityEnum.optional().openapi({ description: 'New artifacts only. Default private.' }),
  label: z.string().max(60).nullable().optional().openapi({ description: 'A short name for this version.' }),
  files: z.record(z.string(), FileInputSchema.nullable()).openapi({
    description: 'path → file. A new artifact needs index.html. On an update, a listed path is added or replaced, null removes it, and every other path carries over.',
  }),
  base_version: z.number().int().min(1).optional().openapi({ description: 'The version you edited. A newer current version answers 409 version_conflict.' }),
});

const PatchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  icon: z.string().max(40).nullable().optional(),
  type: TypeEnum.optional(),
  visibility: VisibilityEnum.optional(),
  shared_with_user_ids: z.array(z.string().uuid()).max(200).optional().openapi({ description: 'People who may view a private artifact. Replaces the list.' }),
});

const PersonSchema = z.object({ user_id: z.string(), name: z.string().nullable(), email: z.string().nullable(), avatar_url: z.string().nullable() });

const ArtifactSchema = z.object({
  artifact_id: z.string(),
  project_id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  type: TypeEnum,
  icon: z.string().nullable(),
  visibility: VisibilityEnum,
  shared_with_user_ids: z.array(z.string()),
  pinned: z.boolean(),
  current_version: z.number(),
  created_by: PersonSchema,
  created_by_session_id: z.string().nullable(),
  can_edit: z.boolean(),
  view_url: z.string().openapi({ description: 'Signed URL of the current version, valid 12 h. Embed it in an iframe.' }),
  web_url: z.string().openapi({ description: 'The artifact in the Kortix app.' }),
  public_url: z.string().nullable().openapi({ description: 'Anyone-with-the-link page, when public.' }),
  public_content_url: z.string().nullable().openapi({ description: 'The raw page without Kortix chrome, when public.' }),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi('Artifact');

const VersionSchema = z.object({
  version: z.number(),
  label: z.string().nullable(),
  files: z.array(z.object({ path: z.string(), size: z.number(), content_type: z.string() })),
  created_by_user_id: z.string(),
  created_by_session_id: z.string().nullable(),
  created_at: z.string(),
}).openapi('ArtifactVersion');

const ArtifactDetailSchema = ArtifactSchema.extend({
  version: VersionSchema.extend({ view_url: z.string() }),
}).openapi('ArtifactDetail');

function frontendBase(): string {
  return (config.FRONTEND_URL ?? '').replace(/\/+$/, '');
}

function serializeVersion(v: ArtifactVersionRow) {
  return {
    version: v.version,
    label: v.label,
    files: Object.entries(v.files as Record<string, ArtifactFileRecord>).sort(([a], [b]) => a.localeCompare(b)).map(([path, f]) => ({ path, size: f.size, content_type: f.content_type })),
    created_by_user_id: v.createdByUserId,
    created_by_session_id: v.createdBySessionId,
    created_at: v.createdAt.toISOString(),
  };
}

async function serialize(rows: ArtifactRow[], userId: string, projectWrite: boolean) {
  const people = await resolveUserIdentities(rows.map((r) => r.createdByUserId));
  return rows.map((row) => {
    const who = people.get(row.createdByUserId);
    const isPublic = row.visibility === 'public';
    return {
      artifact_id: row.artifactId,
      project_id: row.projectId,
      title: row.title,
      description: row.description,
      type: row.type as z.infer<typeof TypeEnum>,
      icon: row.icon,
      visibility: row.visibility as z.infer<typeof VisibilityEnum>,
      shared_with_user_ids: row.sharedWithUserIds,
      pinned: row.pinnedByUserIds.includes(userId),
      current_version: row.currentVersion,
      created_by: { user_id: row.createdByUserId, name: who?.displayName ?? null, email: who?.email ?? null, avatar_url: who?.avatarUrl ?? null },
      created_by_session_id: row.createdBySessionId,
      can_edit: canEdit(row, userId, projectWrite),
      view_url: artifactViewUrl(row.artifactId, row.currentVersion),
      web_url: `${frontendBase()}/projects/${row.projectId}/artifacts/${row.artifactId}`,
      public_url: isPublic ? `${frontendBase()}/share/artifact/${row.artifactId}` : null,
      public_content_url: isPublic ? artifactPublicContentUrl(row.artifactId) : null,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  });
}

/** Load the project, require the flag, and assert the read or write leaf. */
async function authorize(c: Context, projectId: string, mode: 'read' | 'write') {
  // Loaded for read: the leaves below are the gate ('session' would assert
  // project.session.start for a read, too).
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return { ok: false as const, response: c.json({ error: 'Not found' }, 404) };
  const disabled = requireFeatureFlag(c, loaded.row.metadata, ARTIFACTS_FLAG);
  if (disabled) return { ok: false as const, response: disabled };
  const action = mode === 'read' ? PROJECT_ACTIONS.PROJECT_READ : PROJECT_ACTIONS.PROJECT_SESSION_START;
  assertAgentScope(c, action);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, action);
  const projectWrite = await projectCapabilityAllowed(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_WRITE);
  return { ok: true as const, loaded, userId: loaded.userId as string, projectWrite };
}

/** The artifact the caller may view (404 otherwise), and, for `edit`, may change (403). */
async function loadArtifact(c: Context, projectId: string, artifactId: string, mode: 'read' | 'write' | 'edit') {
  const access = await authorize(c, projectId, mode === 'read' ? 'read' : 'write');
  if (!access.ok) return access;
  const row = await getArtifact(projectId, artifactId);
  if (!row || !canView(row, access.userId)) return { ok: false as const, response: c.json({ error: 'Artifact not found' }, 404) };
  if (mode === 'edit' && !canEdit(row, access.userId, access.projectWrite)) {
    return { ok: false as const, response: c.json({ error: 'Only its creator or a project manager can change this artifact', code: 'artifact_read_only' }, 403) };
  }
  return { ...access, row };
}

function author(c: Context, userId: string) {
  return { userId, sessionId: callerKortixSessionId(c) };
}

/** A service error as a response; anything else rethrows. */
function failure(c: Context, err: unknown) {
  if (err instanceof ArtifactError) return c.json({ error: err.message, code: err.code }, err.status);
  if (err instanceof DriveStorageError) return c.json({ error: err.message, code: err.code }, err.status);
  throw err;
}

async function detail(row: ArtifactRow, version: ArtifactVersionRow, userId: string, projectWrite: boolean) {
  const [base] = await serialize([row], userId, projectWrite);
  return { ...base!, version: { ...serializeVersion(version), view_url: artifactViewUrl(row.artifactId, version.version) } };
}

const PUBLISH_LIMIT = bodyLimit({ maxSize: 48 * 1024 * 1024, onError: (c) => c.json({ error: 'One publish carries at most 32 MB', code: 'publish_too_large' }, 413) });

export function registerArtifactRoutes(): void {
  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/artifacts/types', tags: ['artifacts'],
    summary: 'The artifact types, their format and a starter page',
    ...auth,
    request: { params: ProjectParams },
    responses: {
      200: json(z.object({ types: z.array(z.object({ type: TypeEnum, name: z.string(), description: z.string(), format: z.string(), starter: z.string() })) }), 'The types'),
      ...errors(403, 404),
    },
  }), async (c) => {
    const access = await authorize(c, c.req.valid('param').projectId, 'read');
    if (!access.ok) return access.response;
    return c.json({ types: ARTIFACT_TYPES.map(({ type, name, description, format, starter }) => ({ type, name, description, format, starter })) }, 200);
  });

  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/artifacts', tags: ['artifacts'],
    summary: "List the project's artifacts you may view",
    description: '`scope`: all (default), mine (you created), shared (others created), pinned (you pinned). Newest change first.',
    ...auth,
    request: {
      params: ProjectParams,
      query: z.object({
        scope: z.enum(['all', 'mine', 'shared', 'pinned']).optional(),
        type: TypeEnum.optional(),
        q: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
    },
    responses: { 200: json(z.object({ artifacts: z.array(ArtifactSchema) }), 'The artifacts'), ...errors(400, 403, 404) },
  }), async (c) => {
    const { projectId } = c.req.valid('param');
    const q = c.req.valid('query');
    const access = await authorize(c, projectId, 'read');
    if (!access.ok) return access.response;
    const rows = await listArtifacts(projectId, access.userId, { scope: q.scope ?? 'all', type: q.type, q: q.q, limit: q.limit ?? 100 });
    return c.json({ artifacts: await serialize(rows, access.userId, access.projectWrite) }, 200);
  });

  projectsApp.use('/:projectId/artifacts', PUBLISH_LIMIT);
  projectsApp.openapi(createRoute({
    method: 'post', path: '/{projectId}/artifacts', tags: ['artifacts'],
    summary: 'Publish a new artifact',
    ...auth,
    request: { params: ProjectParams, body: { required: true, content: { 'application/json': { schema: PublishBody } } } },
    responses: { 201: json(ArtifactDetailSchema, 'The artifact'), ...errors(400, 403, 404, 409, 413, 503) },
  }), async (c) => {
    const { projectId } = c.req.valid('param');
    const body = c.req.valid('json');
    const access = await authorize(c, projectId, 'write');
    if (!access.ok) return access.response;
    try {
      const { artifact, version } = await createArtifact(
        { accountId: access.loaded.row.accountId, projectId },
        author(c, access.userId),
        body,
      );
      return c.json(await detail(artifact, version, access.userId, access.projectWrite), 201);
    } catch (err) {
      return failure(c, err);
    }
  });

  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/artifacts/{artifactId}', tags: ['artifacts'],
    summary: 'Read an artifact: its metadata, a version (default current) and its files',
    ...auth,
    request: { params: ArtifactParams, query: z.object({ version: z.coerce.number().int().min(1).optional() }) },
    responses: { 200: json(ArtifactDetailSchema, 'The artifact'), ...errors(403, 404) },
  }), async (c) => {
    const { projectId, artifactId } = c.req.valid('param');
    const loaded = await loadArtifact(c, projectId, artifactId, 'read');
    if (!loaded.ok) return loaded.response;
    const version = await getVersion(artifactId, c.req.valid('query').version ?? loaded.row.currentVersion);
    if (!version) return c.json({ error: 'Version not found' }, 404);
    return c.json(await detail(loaded.row, version, loaded.userId, loaded.projectWrite), 200);
  });

  projectsApp.use('/:projectId/artifacts/:artifactId', PUBLISH_LIMIT);
  projectsApp.openapi(createRoute({
    method: 'put', path: '/{projectId}/artifacts/{artifactId}', tags: ['artifacts'],
    summary: 'Publish a new version',
    description: 'Listed files are added or replaced, null removes a path, every other path carries over. Pass base_version to refuse a stale write (409 version_conflict).',
    ...auth,
    request: { params: ArtifactParams, body: { required: true, content: { 'application/json': { schema: PublishBody.omit({ visibility: true }) } } } },
    responses: { 200: json(ArtifactDetailSchema, 'The new version'), ...errors(400, 403, 404, 409, 413, 503) },
  }), async (c) => {
    const { projectId, artifactId } = c.req.valid('param');
    const loaded = await loadArtifact(c, projectId, artifactId, 'edit');
    if (!loaded.ok) return loaded.response;
    try {
      const { artifact, version } = await publishVersion(loaded.row, author(c, loaded.userId), c.req.valid('json'));
      return c.json(await detail(artifact, version, loaded.userId, loaded.projectWrite), 200);
    } catch (err) {
      return failure(c, err);
    }
  });

  projectsApp.openapi(createRoute({
    method: 'patch', path: '/{projectId}/artifacts/{artifactId}', tags: ['artifacts'],
    summary: 'Rename, retype or share an artifact',
    description: 'visibility: private (you and shared_with_user_ids), project (every project member), public (anyone with the link).',
    ...auth,
    request: { params: ArtifactParams, body: { required: true, content: { 'application/json': { schema: PatchBody } } } },
    responses: { 200: json(ArtifactSchema, 'The artifact'), ...errors(400, 403, 404) },
  }), async (c) => {
    const { projectId, artifactId } = c.req.valid('param');
    const loaded = await loadArtifact(c, projectId, artifactId, 'edit');
    if (!loaded.ok) return loaded.response;
    const updated = await updateArtifactMeta(loaded.row, c.req.valid('json'));
    const [out] = await serialize([updated], loaded.userId, loaded.projectWrite);
    return c.json(out!, 200);
  });

  projectsApp.openapi(createRoute({
    method: 'delete', path: '/{projectId}/artifacts/{artifactId}', tags: ['artifacts'],
    summary: 'Delete an artifact, every version and its files',
    ...auth,
    request: { params: ArtifactParams },
    responses: { 200: json(z.object({ deleted: z.literal(true) }), 'Deleted'), ...errors(403, 404) },
  }), async (c) => {
    const { projectId, artifactId } = c.req.valid('param');
    const loaded = await loadArtifact(c, projectId, artifactId, 'edit');
    if (!loaded.ok) return loaded.response;
    await deleteArtifact(loaded.row);
    return c.json({ deleted: true as const }, 200);
  });

  for (const method of ['put', 'delete'] as const) {
    projectsApp.openapi(createRoute({
      method, path: '/{projectId}/artifacts/{artifactId}/pin', tags: ['artifacts'],
      summary: method === 'put' ? 'Pin an artifact for yourself' : 'Unpin an artifact',
      ...auth,
      request: { params: ArtifactParams },
      responses: { 200: json(ArtifactSchema, 'The artifact'), ...errors(403, 404) },
    }), async (c) => {
      const { projectId, artifactId } = c.req.valid('param');
      // Pinning is personal: viewing is enough.
      const loaded = await loadArtifact(c, projectId, artifactId, 'read');
      if (!loaded.ok) return loaded.response;
      const updated = await setPinned(loaded.row, loaded.userId, method === 'put');
      const [out] = await serialize([updated], loaded.userId, loaded.projectWrite);
      return c.json(out!, 200);
    });
  }

  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/artifacts/{artifactId}/versions', tags: ['artifacts'],
    summary: "An artifact's versions, newest first",
    ...auth,
    request: { params: ArtifactParams },
    responses: { 200: json(z.object({ versions: z.array(VersionSchema) }), 'The versions'), ...errors(403, 404) },
  }), async (c) => {
    const { projectId, artifactId } = c.req.valid('param');
    const loaded = await loadArtifact(c, projectId, artifactId, 'read');
    if (!loaded.ok) return loaded.response;
    return c.json({ versions: (await listVersions(artifactId)).map(serializeVersion) }, 200);
  });

  projectsApp.openapi(createRoute({
    method: 'post', path: '/{projectId}/artifacts/{artifactId}/restore', tags: ['artifacts'],
    summary: 'Restore an old version as a new version',
    ...auth,
    request: { params: ArtifactParams, body: { required: true, content: { 'application/json': { schema: z.object({ version: z.number().int().min(1) }) } } } },
    responses: { 200: json(ArtifactDetailSchema, 'The new version'), ...errors(400, 403, 404, 409, 413, 503) },
  }), async (c) => {
    const { projectId, artifactId } = c.req.valid('param');
    const loaded = await loadArtifact(c, projectId, artifactId, 'edit');
    if (!loaded.ok) return loaded.response;
    try {
      const { artifact, version } = await restoreVersion(loaded.row, author(c, loaded.userId), c.req.valid('json').version);
      return c.json(await detail(artifact, version, loaded.userId, loaded.projectWrite), 200);
    } catch (err) {
      return failure(c, err);
    }
  });

  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/artifacts/{artifactId}/content', tags: ['artifacts'],
    summary: "One file's source, as stored (no kit)",
    description: 'Text files answer text/plain; binary files answer application/octet-stream. Default path index.html, default version current.',
    ...auth,
    request: {
      params: ArtifactParams,
      query: z.object({ path: z.string().max(512).optional(), version: z.coerce.number().int().min(1).optional() }),
    },
    responses: { 200: { description: 'The file bytes' }, ...errors(400, 403, 404, 503) },
  }), async (c) => {
    const { projectId, artifactId } = c.req.valid('param');
    const q = c.req.valid('query');
    const loaded = await loadArtifact(c, projectId, artifactId, 'read');
    if (!loaded.ok) return loaded.response;
    const version = await getVersion(artifactId, q.version ?? loaded.row.currentVersion);
    const path = normalizeArtifactPath(q.path ?? 'index.html');
    const file = path ? version?.files[path] : undefined;
    if (!file) return c.json({ error: 'File not found' }, 404);
    try {
      const upstream = await readArtifactFile(loaded.row, file);
      // Never rendered as a page here: the content server is the only renderer.
      return new Response(upstream.body, {
        status: 200,
        headers: {
          'Content-Type': isTextType(file.content_type) ? 'text/plain; charset=utf-8' : 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, no-store',
          'X-Artifact-Content-Type': file.content_type,
        },
      }) as never;
    } catch (err) {
      return failure(c, err);
    }
  });
}
