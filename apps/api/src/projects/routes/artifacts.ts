// Artifacts: paths in the project's Files volume shared as
// a doc (Markdown) or a page (HTML). Logic lives in `artifacts/service.ts`;
// the bytes are served by `artifacts/content-routes.ts`.
//
// Authorization, per route, for the caller's role AND an agent's
// `kortix_permissions` grant (the project.artifact.* leaves):
//   read    types, list, get, versions, content, pin   project.artifact.read
//   write   publish, share a folder, save, restore,    project.artifact.write
//           rename / share / unshare your own
//   manage  rename / share / unshare anyone's           project.artifact.manage
//   public  any change that makes an artifact public    project.artifact.public
// On top, per artifact: view needs `canView`; saving and restoring need write
// access to its folder in Files. A private artifact the caller may not view
// answers 404, never 403.
// A Kortix that stores no Drive answers 403 `feature_disabled` on every route.
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { auth, errors, json } from '../../openapi';
import { config } from '../../config';
import { PROJECT_ACTIONS } from '../../iam';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { projectCapabilityAllowed, resolveUserIdentities } from '../lib/access';
import { authorizeArtifactCaller as authorize, loadArtifactForCaller as loadArtifact } from '../lib/artifact-access';
import { projectsApp } from '../lib/app';
import { loadProjectRosterIds } from '../lib/project-access-view';
import { buildSessionParticipants, sessionAudienceIds } from '../lib/session-audience';
import { DriveStorageError, legacyDriveStatus } from '../../drives/volumes';
import { ARTIFACT_TYPES, ARTIFACT_TYPE_KEYS } from '../../artifacts/formats';
import { BINDING_AGENT_RE, SPACE_SLUG_RE } from '@kortix/shared/app-config';
import {
  ARTIFACT_VISIBILITIES,
  ArtifactError,
  artifactPublicContentUrl,
  artifactViewUrl,
  canManage,
  contentTypeFor,
  entryVersion,
  isTextType,
  listArtifacts,
  listFiles,
  listVersions,
  mayWrite,
  normalizeArtifactPath,
  publishChanges,
  publishNew,
  readArtifactFile,
  restoreVersion,
  setPinned,
  share,
  sharedPath,
  unshare,
  updateArtifactMeta,
  type ArtifactRow,
  type Viewer,
} from '../../artifacts/service';

const ProjectParams = z.object({ workspaceId: z.string().uuid() });
const ArtifactParams = ProjectParams.extend({ artifactId: z.string().uuid() });
const TypeEnum = z.enum(ARTIFACT_TYPE_KEYS);
const VisibilityEnum = z.enum(ARTIFACT_VISIBILITIES);
const CommitId = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);

const FileInputSchema = z.object({
  content: z.string().optional().openapi({ description: 'UTF-8 text.' }),
  content_base64: z.string().optional().openapi({ description: 'Bytes, base64. For images, fonts and other binary files.' }),
});
const Files = z.record(z.string(), FileInputSchema);

// Where an artifact is grouped. Grouping only: a binding grants nothing.
const SpaceSlug = z.string().regex(SPACE_SLUG_RE, 'a space slug: lowercase letters, digits, "-" or "_", at most 63 characters');
const AgentName = z.string().regex(BINDING_AGENT_RE, 'an agent name');
const BindingFields = {
  space: SpaceSlug.nullable().optional().openapi({ description: 'The space it is grouped in. Null: project-wide (or the space of `agent`).' }),
  agent: AgentName.nullable().optional().openapi({ description: 'The owning agent. Default on publish and share from a session: that session\'s agent.' }),
};

const PublishBody = z.object({
  title: z.string().min(1).max(200).optional().openapi({ description: "Default: a doc's first `# ` heading, a page's <title>." }),
  description: z.string().max(1000).nullable().optional(),
  visibility: VisibilityEnum.optional().openapi({ description: 'Default private.' }),
  files: Files.openapi({ description: 'path → file. index.md makes a doc, index.html a page. One file is stored as `<title>.md|.html` in your folder in Files, more as a folder.' }),
  ...BindingFields,
});

const ShareBody = z.object({
  path: z.string().min(1).max(1024).openapi({ description: 'A path in Files: a .md or .html file, or a folder with index.md or index.html.' }),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  visibility: VisibilityEnum.optional(),
  ...BindingFields,
});

const SaveBody = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  files: Files.openapi({ description: 'path → file, written into the artifact in Files. A single-file artifact takes only its entry (index.md / index.html stand for it).' }),
  base_version: z.string().min(1).max(200).optional().openapi({ description: 'The entry version (`entry_version`) you edited. A newer save answers 409 version_conflict.' }),
});

const PatchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  visibility: VisibilityEnum.optional(),
  shared_with_user_ids: z.array(z.string().uuid()).max(200).optional().openapi({ description: 'People who may view a private artifact. Replaces the list.' }),
  ...BindingFields,
});

const PersonSchema = z.object({ user_id: z.string(), name: z.string().nullable(), email: z.string().nullable(), avatar_url: z.string().nullable() });

const ArtifactSchema = z.object({
  artifact_id: z.string(),
  project_id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  type: TypeEnum,
  path: z.string().openapi({ description: 'The shared path in Files: a folder, or a single file.' }),
  entry: z.string(),
  visibility: VisibilityEnum,
  shared_with_user_ids: z.array(z.string()),
  pinned: z.boolean(),
  created_by: PersonSchema,
  created_by_session_id: z.string().nullable(),
  can_manage: z.boolean().openapi({ description: 'May share, rename or unshare it.' }),
  view_url: z.string().openapi({ description: 'Signed URL of the current state, valid 12 h. Embed it in an iframe.' }),
  web_url: z.string(),
  public_url: z.string().nullable().openapi({ description: 'Anyone-with-the-link page, when public.' }),
  public_content_url: z.string().nullable().openapi({ description: 'The raw page without Kortix chrome, when public.' }),
  space: z.string().nullable().openapi({ description: 'The space it is grouped in, or null. Grouping only.' }),
  agent: z.string().nullable().openapi({ description: 'The owning agent, or null. Grouping only.' }),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi('Artifact');

const VersionSchema = z.object({
  id: z.string().openapi({ description: 'The Files commit that made this version.' }),
  number: z.number(),
  created_at: z.string(),
}).openapi('ArtifactVersion');

const ParticipantsSchema = z.object({
  participants: z.array(PersonSchema.extend({ is_viewer: z.boolean() })),
  total: z.number(),
  multi_user: z.boolean(),
}).openapi('ArtifactParticipants', {
  description: 'Who can open it, owner first (at most 20; see total), as a session lists its participants. GET only.',
});

const ArtifactDetailSchema = ArtifactSchema.extend({
  can_edit: z.boolean().openapi({ description: 'May write its files: write access to its path in Files.' }),
  entry_version: z.string().nullable().openapi({ description: 'The entry file version now. Pass it as base_version when you save.' }),
  version: z.object({
    id: z.string().nullable().openapi({ description: 'The commit shown, null for the current state.' }),
    files: z.array(z.object({ path: z.string(), size: z.number(), content_type: z.string() })),
    view_url: z.string(),
  }),
  participants: ParticipantsSchema.optional(),
}).openapi('ArtifactDetail');

function frontendBase(): string {
  return (config.FRONTEND_URL ?? '').replace(/\/+$/, '');
}

async function serialize(rows: ArtifactRow[], viewer: Viewer) {
  const people = await resolveUserIdentities(rows.map((r) => r.createdByUserId));
  const person = (userId: string) => {
    const who = people.get(userId);
    return { user_id: userId, name: who?.displayName ?? null, email: who?.email ?? null, avatar_url: who?.avatarUrl ?? null };
  };
  return rows.map((row) => {
    const isPublic = row.visibility === 'public';
    return {
      artifact_id: row.artifactId,
      project_id: row.projectId,
      title: row.title,
      description: row.description,
      type: row.type as z.infer<typeof TypeEnum>,
      path: sharedPath(row),
      entry: row.entry,
      visibility: row.visibility as z.infer<typeof VisibilityEnum>,
      shared_with_user_ids: row.sharedWithUserIds,
      pinned: row.pinnedByUserIds.includes(viewer.userId),
      created_by: person(row.createdByUserId),
      created_by_session_id: row.createdBySessionId,
      can_manage: canManage(row, viewer),
      view_url: artifactViewUrl(row.artifactId, null),
      web_url: `${frontendBase()}/workspaces/${row.projectId}/artifacts/${row.artifactId}`,
      public_url: isPublic ? `${frontendBase()}/share/artifact/${row.artifactId}` : null,
      public_content_url: isPublic ? artifactPublicContentUrl(row.artifactId) : null,
      space: row.space,
      agent: row.agent,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  });
}

/** A public link needs project.artifact.public (the role and an agent's grant): 403 otherwise. */
async function refusePublic(c: Context, access: { can: (leaf: string) => Promise<boolean> | boolean }, visibility: string | undefined) {
  if (visibility !== 'public' || (await access.can(PROJECT_ACTIONS.PROJECT_ARTIFACT_PUBLIC))) return null;
  return c.json({ error: 'You cannot give an artifact a public link (project.artifact.public)', code: 'public_link_forbidden' }, 403);
}

function author(c: Context, userId: string) {
  return { userId, sessionId: callerKortixSessionId(c) };
}

/** A service error as a response; anything else rethrows. */
function failure(c: Context, err: unknown) {
  if (err instanceof ArtifactError) return c.json({ error: err.message, code: err.code }, err.status);
  if (err instanceof DriveStorageError) return c.json({ error: err.message, code: err.code, ...(err.detail ?? {}) }, legacyDriveStatus(err));
  throw err;
}

/**
 * Who can open the artifact, owner first, in the session participants' shape
 * (the header's avatar stack): a private one is its creator and the people it
 * is shared with; a project or public one, everyone with access to the project.
 */
async function participants(c: Context, access: { loaded: { userId: string | null; row: { accountId: string; projectId: string } }; viewer: Viewer; row: ArtifactRow }) {
  const { loaded, viewer, row } = access;
  const ownerId = row.createdByUserId;
  const isPrivate = row.visibility === 'private';
  const [canReadMembers, roster] = await Promise.all([
    projectCapabilityAllowed(c, viewer.userId, loaded.row.accountId, row.projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_READ),
    isPrivate ? Promise.resolve(null) : loadProjectRosterIds(loaded),
  ]);
  const audienceIds = isPrivate
    ? [ownerId, ...row.sharedWithUserIds.filter((id) => id !== ownerId)]
    : sessionAudienceIds({ ownerId, visibility: 'project', grants: [], rosterIds: roster?.ids ?? [], groupMembers: new Map() });
  const identities = await resolveUserIdentities([...audienceIds, viewer.userId]);
  return buildSessionParticipants({ viewerId: viewer.userId, ownerId, audienceIds, identities, canReadMembers });
}

/** The artifact now, or at one commit: its files and a signed URL that shows exactly that. */
async function detail(row: ArtifactRow, viewer: Viewer, at?: string) {
  const [base] = await serialize([row], viewer);
  const [canEdit, version, files] = await Promise.all([mayWrite(row, viewer), entryVersion(row), listFiles(row, at)]);
  return {
    ...base!,
    can_edit: canEdit,
    entry_version: version,
    version: { id: at ?? null, files, view_url: artifactViewUrl(row.artifactId, at ?? null) },
  };
}

const PUBLISH_LIMIT = bodyLimit({ maxSize: 48 * 1024 * 1024, onError: (c) => c.json({ error: 'One publish carries at most 32 MB', code: 'publish_too_large' }, 413) });

export function registerArtifactRoutes(): void {
  projectsApp.openapi(createRoute({
    method: 'get', path: '/{workspaceId}/artifacts/types', tags: ['artifacts'],
    summary: 'The artifact types, their format and a starter',
    ...auth,
    request: { params: ProjectParams },
    responses: {
      200: json(z.object({ types: z.array(z.object({ type: TypeEnum, name: z.string(), description: z.string(), format: z.string(), starter: z.string() })) }), 'The types'),
      ...errors(403, 404),
    },
  }), async (c) => {
    const access = await authorize(c, c.req.valid('param').workspaceId, 'read');
    if (!access.ok) return access.response;
    return c.json({ types: ARTIFACT_TYPES.map(({ type, name, description, format, starter }) => ({ type, name, description, format, starter })) }, 200);
  });

  projectsApp.openapi(createRoute({
    method: 'get', path: '/{workspaceId}/artifacts', tags: ['artifacts'],
    summary: "List the project's artifacts you may view",
    description:
      '`scope`: all (default), mine (you shared), shared (others shared), pinned (you pinned). Newest change first. ' +
      '`space`: only artifacts bound to that space; with `agent` (repeatable, the agents of that space) also those with no space owned by one of them. ' +
      '`agent` alone: owned by one of them. `unbound=1`: no space and no agent (project-wide).',
    ...auth,
    request: {
      params: ProjectParams,
      query: z.object({
        scope: z.enum(['all', 'mine', 'shared', 'pinned']).optional(),
        type: TypeEnum.optional(),
        q: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        space: SpaceSlug.optional(),
        agent: z.union([AgentName, z.array(AgentName).max(100)]).optional(),
        unbound: z.enum(['1', 'true']).optional(),
      }),
    },
    responses: { 200: json(z.object({ artifacts: z.array(ArtifactSchema) }), 'The artifacts'), ...errors(400, 403, 404) },
  }), async (c) => {
    const { workspaceId: projectId } = c.req.valid('param');
    const q = c.req.valid('query');
    const access = await authorize(c, projectId, 'read');
    if (!access.ok) return access.response;
    // One `agent` validates as a string, a repeated one as an array.
    const agents = q.agent === undefined ? [] : [q.agent].flat();
    const rows = await listArtifacts(projectId, access.viewer, {
      scope: q.scope ?? 'all', type: q.type, q: q.q, limit: q.limit ?? 100,
      space: q.space, agents, unbound: q.unbound !== undefined,
    });
    return c.json({ artifacts: await serialize(rows, access.viewer) }, 200);
  });

  projectsApp.use('/:workspaceId/artifacts', PUBLISH_LIMIT);
  projectsApp.openapi(createRoute({
    method: 'post', path: '/{workspaceId}/artifacts', tags: ['artifacts'],
    summary: 'Publish new files as an artifact (into your folder in Files)',
    ...auth,
    request: { params: ProjectParams, body: { required: true, content: { 'application/json': { schema: PublishBody } } } },
    responses: { 201: json(ArtifactDetailSchema, 'The artifact'), ...errors(400, 403, 404, 409, 413, 503) },
  }), async (c) => {
    const { workspaceId: projectId } = c.req.valid('param');
    const access = await authorize(c, projectId, 'write');
    if (!access.ok) return access.response;
    const refused = await refusePublic(c, access, c.req.valid('json').visibility);
    if (refused) return refused;
    try {
      const row = await publishNew(
        { accountId: access.loaded.row.accountId, projectId },
        author(c, access.viewer.userId),
        c.req.valid('json'),
        access.viewer.channelFolder,
      );
      return c.json(await detail(row, access.viewer), 201);
    } catch (err) {
      return failure(c, err);
    }
  });

  projectsApp.openapi(createRoute({
    method: 'post', path: '/{workspaceId}/artifacts/share', tags: ['artifacts'],
    summary: 'Share a path that is already in Files as an artifact',
    description: 'A .md file (doc), a .html file (page), or a folder with index.md or index.html. You must be able to read it in Files. 409 already_shared when the path already is an artifact.',
    ...auth,
    request: { params: ProjectParams, body: { required: true, content: { 'application/json': { schema: ShareBody } } } },
    responses: { 201: json(ArtifactDetailSchema, 'The artifact'), ...errors(400, 403, 404, 409, 413, 503) },
  }), async (c) => {
    const { workspaceId: projectId } = c.req.valid('param');
    const access = await authorize(c, projectId, 'write');
    if (!access.ok) return access.response;
    const refused = await refusePublic(c, access, c.req.valid('json').visibility);
    if (refused) return refused;
    try {
      const row = await share({ accountId: access.loaded.row.accountId, projectId }, author(c, access.viewer.userId), access.viewer, c.req.valid('json'));
      return c.json(await detail(row, access.viewer), 201);
    } catch (err) {
      return failure(c, err);
    }
  });

  projectsApp.openapi(createRoute({
    method: 'get', path: '/{workspaceId}/artifacts/{artifactId}', tags: ['artifacts'],
    summary: 'Read an artifact: its metadata, its files now or at a version, and a signed URL',
    ...auth,
    request: { params: ArtifactParams, query: z.object({ version: CommitId.optional() }) },
    responses: { 200: json(ArtifactDetailSchema, 'The artifact'), ...errors(400, 403, 404, 409, 413, 503) },
  }), async (c) => {
    const { workspaceId: projectId, artifactId } = c.req.valid('param');
    const loaded = await loadArtifact(c, projectId, artifactId, 'read');
    if (!loaded.ok) return loaded.response;
    try {
      const [body, people] = await Promise.all([detail(loaded.row, loaded.viewer, c.req.valid('query').version), participants(c, loaded)]);
      return c.json({ ...body, participants: people }, 200);
    } catch (err) {
      return failure(c, err);
    }
  });

  projectsApp.use('/:workspaceId/artifacts/:artifactId', PUBLISH_LIMIT);
  projectsApp.openapi(createRoute({
    method: 'put', path: '/{workspaceId}/artifacts/{artifactId}', tags: ['artifacts'],
    summary: 'Save files into the artifact in Files',
    description: 'Each file is written to its path in Files (a save, a commit of the volume). Pass base_version to refuse a stale save (409 version_conflict).',
    ...auth,
    request: { params: ArtifactParams, body: { required: true, content: { 'application/json': { schema: SaveBody } } } },
    responses: { 200: json(ArtifactDetailSchema, 'The artifact now'), ...errors(400, 403, 404, 409, 413, 503) },
  }), async (c) => {
    const { workspaceId: projectId, artifactId } = c.req.valid('param');
    const loaded = await loadArtifact(c, projectId, artifactId, 'write');
    if (!loaded.ok) return loaded.response;
    try {
      const row = await publishChanges(loaded.row, c.req.valid('json'));
      return c.json(await detail(row, loaded.viewer), 200);
    } catch (err) {
      return failure(c, err);
    }
  });

  projectsApp.openapi(createRoute({
    method: 'patch', path: '/{workspaceId}/artifacts/{artifactId}', tags: ['artifacts'],
    summary: 'Rename or share an artifact',
    description: 'visibility: private (you and shared_with_user_ids), project (every project member), public (anyone with the link).',
    ...auth,
    request: { params: ArtifactParams, body: { required: true, content: { 'application/json': { schema: PatchBody } } } },
    responses: { 200: json(ArtifactSchema, 'The artifact'), ...errors(400, 403, 404) },
  }), async (c) => {
    const { workspaceId: projectId, artifactId } = c.req.valid('param');
    const loaded = await loadArtifact(c, projectId, artifactId, 'manage');
    if (!loaded.ok) return loaded.response;
    const refused = await refusePublic(c, loaded, c.req.valid('json').visibility);
    if (refused) return refused;
    let updated: ArtifactRow;
    try {
      updated = await updateArtifactMeta(loaded.row, c.req.valid('json'));
    } catch (err) {
      // 403 `private_channel`: a private channel's artifact stays private.
      if (err instanceof ArtifactError && err.status === 403) return c.json({ error: err.message, code: err.code }, 403);
      throw err;
    }
    const [out] = await serialize([updated], loaded.viewer);
    return c.json(out!, 200);
  });

  projectsApp.openapi(createRoute({
    method: 'delete', path: '/{workspaceId}/artifacts/{artifactId}', tags: ['artifacts'],
    summary: 'Stop sharing: remove it from Artifacts (its files stay in Files)',
    ...auth,
    request: { params: ArtifactParams },
    responses: { 200: json(z.object({ deleted: z.literal(true) }), 'Removed'), ...errors(403, 404) },
  }), async (c) => {
    const { workspaceId: projectId, artifactId } = c.req.valid('param');
    const loaded = await loadArtifact(c, projectId, artifactId, 'manage');
    if (!loaded.ok) return loaded.response;
    await unshare(loaded.row);
    return c.json({ deleted: true as const }, 200);
  });

  for (const method of ['put', 'delete'] as const) {
    projectsApp.openapi(createRoute({
      method, path: '/{workspaceId}/artifacts/{artifactId}/pin', tags: ['artifacts'],
      summary: method === 'put' ? 'Pin an artifact for yourself' : 'Unpin an artifact',
      ...auth,
      request: { params: ArtifactParams },
      responses: { 200: json(ArtifactSchema, 'The artifact'), ...errors(403, 404) },
    }), async (c) => {
      const { workspaceId: projectId, artifactId } = c.req.valid('param');
      // Pinning is personal: viewing is enough.
      const loaded = await loadArtifact(c, projectId, artifactId, 'pin');
      if (!loaded.ok) return loaded.response;
      const updated = await setPinned(loaded.row, loaded.viewer.userId, method === 'put');
      const [out] = await serialize([updated], loaded.viewer);
      return c.json(out!, 200);
    });
  }

  projectsApp.openapi(createRoute({
    method: 'get', path: '/{workspaceId}/artifacts/{artifactId}/versions', tags: ['artifacts'],
    summary: "An artifact's history from the Files volume, newest first",
    description: 'Every save of its entry file, read from the Files commit log (the last 200 commits of Files).',
    ...auth,
    request: { params: ArtifactParams },
    responses: { 200: json(z.object({ versions: z.array(VersionSchema) }), 'The versions'), ...errors(400, 403, 404, 409, 413, 503) },
  }), async (c) => {
    const { workspaceId: projectId, artifactId } = c.req.valid('param');
    const loaded = await loadArtifact(c, projectId, artifactId, 'read');
    if (!loaded.ok) return loaded.response;
    try {
      return c.json({ versions: await listVersions(loaded.row) }, 200);
    } catch (err) {
      return failure(c, err);
    }
  });

  projectsApp.openapi(createRoute({
    method: 'post', path: '/{workspaceId}/artifacts/{artifactId}/restore', tags: ['artifacts'],
    summary: 'Restore an old version: its files are written back to Files, as a new save',
    ...auth,
    request: { params: ArtifactParams, body: { required: true, content: { 'application/json': { schema: z.object({ version: CommitId }) } } } },
    responses: { 200: json(ArtifactDetailSchema, 'The artifact now'), ...errors(400, 403, 404, 409, 413, 503) },
  }), async (c) => {
    const { workspaceId: projectId, artifactId } = c.req.valid('param');
    const loaded = await loadArtifact(c, projectId, artifactId, 'write');
    if (!loaded.ok) return loaded.response;
    try {
      const row = await restoreVersion(loaded.row, c.req.valid('json').version);
      return c.json(await detail(row, loaded.viewer), 200);
    } catch (err) {
      return failure(c, err);
    }
  });

  projectsApp.openapi(createRoute({
    method: 'get', path: '/{workspaceId}/artifacts/{artifactId}/content', tags: ['artifacts'],
    summary: "One file's source, as stored in Files",
    description: 'Text files answer text/plain; binary files answer application/octet-stream. Default the entry file, default version now.',
    ...auth,
    request: {
      params: ArtifactParams,
      query: z.object({ path: z.string().max(512).optional(), version: CommitId.optional() }),
    },
    responses: { 200: { description: 'The file bytes' }, ...errors(400, 403, 404, 409, 413, 503) },
  }), async (c) => {
    const { workspaceId: projectId, artifactId } = c.req.valid('param');
    const q = c.req.valid('query');
    const loaded = await loadArtifact(c, projectId, artifactId, 'read');
    if (!loaded.ok) return loaded.response;
    const path = q.path ? normalizeArtifactPath(q.path) : loaded.row.entry;
    if (!path) return c.json({ error: 'File not found' }, 404);
    try {
      const upstream = await readArtifactFile(loaded.row, path, q.version);
      // Never rendered as a page here: the content server is the only renderer.
      return new Response(upstream.body, {
        status: 200,
        headers: {
          'Content-Type': isTextType(contentTypeFor(path)) ? 'text/plain; charset=utf-8' : 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, no-store',
          'X-Artifact-Content-Type': contentTypeFor(path),
        },
      }) as never;
    } catch (err) {
      if (err instanceof DriveStorageError && err.status === 404) return c.json({ error: 'File not found' }, 404);
      return failure(c, err);
    }
  });
}
