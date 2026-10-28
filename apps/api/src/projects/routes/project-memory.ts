/**
 * Memory: `/v1/projects/:projectId/memory/*`. Memory is the Markdown files of
 * the project's Drive (`../../memory`); these handlers read the request,
 * build the viewer and map a `MemoryError` (or a Drive storage failure) to its
 * status and `{error, code}` body.
 *
 * Every route needs `session` project access and the `drives` flag (Memory
 * lives in Files), never `project_channels`: with Channels off the files are
 * the same and the routes keep working; only the Channels UI is hidden.
 * Read and write rights are the Drive folder rights. A session token (an
 * agent) gets 403 `use_files` on every route: agents use their `/drives` mounts.
 */
import { createRoute, z } from '@hono/zod-openapi';
import {
  MemoryDeleteResultSchema,
  MemoryLayerSchema,
  MemoryNoteInputSchema,
  MemoryPageCreateInputSchema,
  MemoryPageListSchema,
  MemoryPageSchema,
  MemoryPageTypeSchema,
  MemoryPageUpdateInputSchema,
  MEMORY_SEARCH_LIMITS,
  MemorySearchResultSchema,
  MemoryUsageSchema,
  MemoryVersionListSchema,
} from '@kortix/api-contract';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { DriveStorageError } from '../../drives/volumes';
import {
  addNote,
  assertFilesOn,
  authorName,
  createPage,
  decodePageId,
  deletePage,
  getPage,
  layerView,
  listPages,
  MemoryError,
  notFound,
  pageHistory,
  type Project,
  resolveLayer,
  searchMemory,
  threadLabelOf,
  threadUsage,
  updatePage,
  type Viewer,
} from '../../memory';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { auth, boundedIssues, errors, json } from '../../openapi';
import type { AppEnv } from '../../types';
import { loadProjectForUser, loadVisibleSession } from '../lib/access';
import { projectsApp } from '../lib/app';
import { addChannelsMark } from '../lib/channels-onboarding';

const projectParams = z.object({ projectId: z.string() });
const layerParams = projectParams.extend({ layerKey: z.string() });
const pageParams = projectParams.extend({ pageId: z.string() });

type Caller = {
  project: Project;
  viewer: Viewer;
  /** The session read rule for one thread of this project. */
  canOpenSession: (sessionId: string) => Promise<boolean>;
};

/**
 * The project (`session` access), the viewer, then `run`; a `MemoryError` or
 * a Drive storage failure becomes its status and `{error, code}` body.
 */
export async function withMemoryCaller<R>(c: Context<AppEnv>, run: (caller: Caller) => Promise<R>) {
  const loaded = await loadProjectForUser(c, c.req.param('projectId')!, 'session');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  if (callerKortixSessionId(c)) {
    return c.json({ error: 'Agents read and write memory as files in their /drives mounts.', code: 'use_files' }, 403);
  }
  const { row, userId } = loaded;
  const may = async (action: 'session' | 'write') => {
    try {
      return !!(await loadProjectForUser(c, row.projectId, action));
    } catch (error) {
      if (error instanceof HTTPException && (error.status === 403 || error.status === 404)) return false;
      throw error;
    }
  };
  try {
    return await run({
      project: { projectId: row.projectId, accountId: row.accountId, metadata: row.metadata },
      viewer: { userId, may },
      canOpenSession: async (sessionId) => (await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null, null)) !== null,
    });
  } catch (error) {
    if (error instanceof MemoryError) return c.json(error.body, error.status);
    if (error instanceof DriveStorageError) {
      return c.json({ error: error.message, code: error.code ?? 'drive_storage_error' }, error.status === 404 ? 404 : error.status);
    }
    throw error;
  }
}

/** A zod failure as the memory routes answer every refusal: `{error, code: invalid_input}`. */
function memoryValidationHook(
  result: { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } },
  c: Context,
) {
  if (result.success) return undefined;
  const issue = result.error?.issues[0];
  const where = issue?.path.length ? `${issue.path.map(String).join('.')}: ` : '';
  return c.json({ error: `${where}${issue?.message ?? 'Invalid input'}`, code: 'invalid_input', ...boundedIssues(result.error?.issues) }, 400);
}

/** The page of a page id: its layer (the viewer must read it) and its path in it. */
async function pageRef(project: Project, viewer: Viewer, pageId: string) {
  assertFilesOn(project);
  const ref = decodePageId(pageId);
  if (!ref) throw notFound();
  return { layer: await resolveLayer(project, ref.key, viewer), rel: ref.rel };
}

/** Writing in `#general` completes the "tell #general something" row of Get started. */
async function markGeneral(project: Project, viewer: Viewer, layer: { isDefault: boolean }) {
  if (layer.isDefault) await addChannelsMark(project.projectId, viewer.userId, 'get_started.remember');
}

const ERRORS = errors(400, 403, 404, 409, 413, 422, 503);

export function registerProjectMemoryRoutes(): void {
  // GET /v1/projects/:projectId/memory/layers/:layerKey
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/memory/layers/{layerKey}',
      tags: ['memory'],
      summary: 'Read a memory layer: its Drive folder and page counts',
      description: '`layerKey` is `company` or the space id of a channel or the caller’s DM. Another member’s DM is 404 `memory_not_found`.',
      ...auth,
      request: { params: layerParams },
      responses: { 200: json(MemoryLayerSchema, 'The layer'), ...ERRORS },
    }),
    (c) =>
      withMemoryCaller(c, async ({ project, viewer }) =>
        c.json(await layerView(await resolveLayer(project, c.req.valid('param').layerKey, viewer)), 200),
      ),
    memoryValidationHook,
  );

  // GET /v1/projects/:projectId/memory/layers/:layerKey/pages
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/memory/layers/{layerKey}/pages',
      tags: ['memory'],
      summary: 'List the pages of a memory layer',
      description: 'One summary per Markdown file, newest first (a DM’s agent folder first), at most 500 (`truncated` past it).',
      ...auth,
      request: {
        params: layerParams,
        query: z.object({ type: MemoryPageTypeSchema.optional() }),
      },
      responses: { 200: json(MemoryPageListSchema, 'The pages'), ...ERRORS },
    }),
    (c) =>
      withMemoryCaller(c, async ({ project, viewer }) => {
        const layer = await resolveLayer(project, c.req.valid('param').layerKey, viewer);
        return c.json(await listPages(layer, { type: c.req.valid('query').type }), 200);
      }),
    memoryValidationHook,
  );

  // POST /v1/projects/:projectId/memory/layers/:layerKey/pages
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/memory/layers/{layerKey}/pages',
      tags: ['memory'],
      summary: 'Create a memory page',
      description:
        'Writes `<folder>/<type>/<slug>.md` (`other`: `<folder>/<slug>.md`; a DM page in the agent folder unless `agent_folder: false`). ' +
        '409 `title_taken` (with `page_id`) when the file exists, `layer_read_only` for an archived channel; 413 `page_too_large` over 262,144 bytes; 422 `secret_detected`.',
      ...auth,
      request: { params: layerParams, body: { content: { 'application/json': { schema: MemoryPageCreateInputSchema } } } },
      responses: { 201: json(MemoryPageSchema, 'The created page'), ...ERRORS },
    }),
    (c) =>
      withMemoryCaller(c, async ({ project, viewer }) => {
        const layer = await resolveLayer(project, c.req.valid('param').layerKey, viewer);
        const rel = await createPage(layer, await authorName(viewer.userId), c.req.valid('json'));
        await markGeneral(project, viewer, layer);
        return c.json(await getPage(layer, rel), 201);
      }),
    memoryValidationHook,
  );

  // POST /v1/projects/:projectId/memory/layers/:layerKey/notes — the Remember box.
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/memory/layers/{layerKey}/notes',
      tags: ['memory'],
      summary: 'Save a note to a memory layer',
      description:
        'Appends `- <text> — <name>, <date>[ (from <thread>)]` to the layer’s `Notes.md` (a DM’s: in the agent folder), for an agent to file into a topic file. ' +
        'A `source_session_id` the caller cannot open is 404 `session_not_found`.',
      ...auth,
      request: { params: layerParams, body: { content: { 'application/json': { schema: MemoryNoteInputSchema } } } },
      responses: { 201: json(MemoryPageSchema, 'The notes page'), ...ERRORS },
    }),
    (c) =>
      withMemoryCaller(c, async ({ project, viewer, canOpenSession }) => {
        const layer = await resolveLayer(project, c.req.valid('param').layerKey, viewer);
        const input = c.req.valid('json');
        if (input.source_session_id && !(await canOpenSession(input.source_session_id))) {
          throw new MemoryError(404, 'session_not_found', 'Thread not found.');
        }
        const label = input.source_session_id ? await threadLabelOf(project.projectId, input.source_session_id, layer.spaceId) : null;
        const rel = await addNote(layer, await authorName(viewer.userId), input, label);
        await markGeneral(project, viewer, layer);
        return c.json(await getPage(layer, rel), 201);
      }),
    memoryValidationHook,
  );

  // GET /v1/projects/:projectId/memory/pages/:pageId
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/memory/pages/{pageId}',
      tags: ['memory'],
      summary: 'Read a memory page',
      description: '413 `page_too_large` (with `path`) for a file over 256 KiB: open it in Files.',
      ...auth,
      request: { params: pageParams },
      responses: { 200: json(MemoryPageSchema, 'The page'), ...ERRORS },
    }),
    (c) =>
      withMemoryCaller(c, async ({ project, viewer }) => {
        const { layer, rel } = await pageRef(project, viewer, c.req.valid('param').pageId);
        return c.json(await getPage(layer, rel), 200);
      }),
    memoryValidationHook,
  );

  // PATCH /v1/projects/:projectId/memory/pages/:pageId
  projectsApp.openapi(
    createRoute({
      method: 'patch',
      path: '/{projectId}/memory/pages/{pageId}',
      tags: ['memory'],
      summary: 'Edit the body of a memory page',
      description: 'The body only: front-matter and the `# ` title line are kept. 409 `version_conflict` when the file changed since `base_version`.',
      ...auth,
      request: { params: pageParams, body: { content: { 'application/json': { schema: MemoryPageUpdateInputSchema } } } },
      responses: { 200: json(MemoryPageSchema, 'The page after the edit'), ...ERRORS },
    }),
    (c) =>
      withMemoryCaller(c, async ({ project, viewer }) => {
        const { layer, rel } = await pageRef(project, viewer, c.req.valid('param').pageId);
        await updatePage(layer, rel, await authorName(viewer.userId), c.req.valid('json'));
        return c.json(await getPage(layer, rel), 200);
      }),
    memoryValidationHook,
  );

  // DELETE /v1/projects/:projectId/memory/pages/:pageId
  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{projectId}/memory/pages/{pageId}',
      tags: ['memory'],
      summary: 'Delete a memory page',
      description: 'Deletes the file for good (a Drive delete). Anyone who may write the layer.',
      ...auth,
      request: { params: pageParams },
      responses: { 200: json(MemoryDeleteResultSchema, 'Deleted'), ...ERRORS },
    }),
    (c) =>
      withMemoryCaller(c, async ({ project, viewer }) => {
        const pageId = c.req.valid('param').pageId;
        const { layer, rel } = await pageRef(project, viewer, pageId);
        await deletePage(layer, rel);
        return c.json({ ok: true as const, version_id: pageId }, 200);
      }),
    memoryValidationHook,
  );

  // GET /v1/projects/:projectId/memory/pages/:pageId/history
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/memory/pages/{pageId}/history',
      tags: ['memory'],
      summary: 'List the versions of a memory page',
      description: 'From the drive’s newest 100 Drive commits, one entry per distinct file version, newest first, at most 20. Older versions: Files → Versions.',
      ...auth,
      request: { params: pageParams },
      responses: { 200: json(MemoryVersionListSchema, 'The versions'), ...ERRORS },
    }),
    (c) =>
      withMemoryCaller(c, async ({ project, viewer }) => {
        const { layer, rel } = await pageRef(project, viewer, c.req.valid('param').pageId);
        return c.json(await pageHistory(layer, rel), 200);
      }),
    memoryValidationHook,
  );

  // GET /v1/projects/:projectId/memory/search
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/memory/search',
      tags: ['memory'],
      summary: 'Search memory pages',
      description:
        'Case-insensitive text match over title and body, title hits first. A person searches Company, every live channel and their own Memory folder, ' +
        'or the one layer `layer` names.',
      ...auth,
      request: {
        params: projectParams,
        query: z.object({
          q: z
            .string()
            .trim()
            .min(MEMORY_SEARCH_LIMITS.q_min)
            .max(MEMORY_SEARCH_LIMITS.q_max)
            .refine((q) => !q.includes('\u0000'), 'q must not contain NUL'),
          layer: z.string().optional(),
          type: MemoryPageTypeSchema.optional(),
          limit: z.coerce.number().int().min(1).max(MEMORY_SEARCH_LIMITS.limit).optional(),
        }),
      },
      responses: { 200: json(MemorySearchResultSchema, 'The hits, best first'), ...ERRORS },
    }),
    (c) =>
      withMemoryCaller(c, async ({ project, viewer }) => {
        assertFilesOn(project);
        const query = c.req.valid('query');
        return c.json(await searchMemory(project, viewer, { ...query, limit: query.limit ?? MEMORY_SEARCH_LIMITS.limit }), 200);
      }),
    memoryValidationHook,
  );

  // GET /v1/projects/:projectId/sessions/:sessionId/memory-usage — "Used memory".
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/sessions/{sessionId}/memory-usage',
      tags: ['memory'],
      summary: 'List the memory files a thread’s agent was listed',
      description:
        'The files listed to the agent at the thread’s first turn, by layer; files deleted since are left out. `loaded_at` is null before the first turn. ' +
        'A thread the caller cannot open is 404 `session_not_found`.',
      ...auth,
      request: { params: projectParams.extend({ sessionId: z.string() }) },
      responses: { 200: json(MemoryUsageSchema, 'The pages, by layer'), ...ERRORS },
    }),
    (c) =>
      withMemoryCaller(c, async ({ viewer, canOpenSession }) => {
        const sessionId = c.req.valid('param').sessionId;
        if (!(await canOpenSession(sessionId))) throw new MemoryError(404, 'session_not_found', 'Thread not found.');
        return c.json(await threadUsage(sessionId, viewer.userId), 200);
      }),
    memoryValidationHook,
  );
}
