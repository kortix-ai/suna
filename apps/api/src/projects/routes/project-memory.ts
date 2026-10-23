/**
 * Memory pages (`project_channels`): `/v1/projects/:projectId/memory/*`.
 * Every rule lives in `../../memory`; these handlers read the request, build
 * the viewer and map a `MemoryError` to its status and `{error, code}` body.
 *
 * Every route needs `session` project access and the flag. People read and
 * write the layers they see. A session-bound caller (an agent's token) reads
 * only its thread's layers and gets 403 `use_remember` on writes. Agents
 * write with `POST …/memory/remember` and read their copy with the layer
 * export; both answer 403 `session_token_required` to anyone else.
 */
import { createRoute, z } from '@hono/zod-openapi';
import {
  MemoryChangeListSchema,
  MemoryDeleteResultSchema,
  MemoryLayerExportSchema,
  MemoryLayerSchema,
  MemoryNoteInputSchema,
  MemoryPageCreateInputSchema,
  MemoryPageListSchema,
  MemoryPageSchema,
  MemoryPageStatusSchema,
  MemoryPageTypeSchema,
  MemoryPageUpdateInputSchema,
  MemoryRememberInputSchema,
  MemoryRememberResultSchema,
  MemoryRestoreInputSchema,
  MEMORY_SEARCH_LIMITS,
  MemorySearchResultSchema,
  MemoryUndoResultSchema,
  MemoryUsageSchema,
  MemoryVersionListSchema,
} from '@kortix/api-contract';
import type { Context } from 'hono';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { PROJECT_ACTIONS } from '../../iam';
import {
  addNote,
  confirmPage,
  createPage,
  deletePage,
  exportLayer,
  getPage,
  layerChanges,
  layerView,
  listPages,
  MemoryError,
  pageHistory,
  remember,
  resolveLayerKey,
  restorePage,
  searchMemory,
  threadUsage,
  undoVersion,
  updatePage,
  type Viewer,
} from '../../memory';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { auth, errors, json } from '../../openapi';
import type { AppEnv } from '../../types';
import { loadProjectForUser, loadVisibleSession, loadVisibleSessionsForList, projectCapabilityAllowed } from '../lib/access';
import { projectsApp } from '../lib/app';

const projectParams = z.object({ projectId: z.string() });
const layerParams = projectParams.extend({ layerKey: z.string() });
const pageParams = projectParams.extend({ pageId: z.string() });
const versionParams = projectParams.extend({ versionId: z.string() });
const cursorQuery = (max: number) =>
  z.object({
    limit: z.coerce.number().int().min(1).max(max).optional(),
    before: z.string().optional(),
  });

type Caller = {
  project: { projectId: string; metadata: unknown };
  viewer: Viewer;
  /** The session read rule for one thread of this project. */
  canOpenSession: (sessionId: string) => Promise<boolean>;
};

/**
 * The project (`session` access), the `project_channels` flag and the viewer,
 * then `run`; a `MemoryError` becomes its status and `{error, code}` body.
 */
export async function withMemoryCaller<R>(c: Context<AppEnv>, run: (caller: Caller) => Promise<R>) {
  const loaded = await loadProjectForUser(c, c.req.param('projectId')!, 'session');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const gate = requireFeatureFlag(c, loaded.row.metadata, 'project_channels');
  if (gate) return gate;
  const { row, userId } = loaded;
  let manager: Promise<boolean> | undefined;
  const viewer: Viewer = {
    userId,
    sessionId: callerKortixSessionId(c),
    // Asked only by page delete rights, once per request.
    isManager: () => (manager ??= projectCapabilityAllowed(c, userId, row.accountId, row.projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE)),
    // The session read rule: a source in a thread the caller cannot open shows as "a private thread".
    canOpenThreads: async (ids) => new Set((await loadVisibleSessionsForList(loaded, ids, null, null)).keys()),
  };
  try {
    return await run({
      project: { projectId: row.projectId, metadata: row.metadata },
      viewer,
      canOpenSession: async (sessionId) => (await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null, viewer.sessionId)) !== null,
    });
  } catch (error) {
    if (error instanceof MemoryError) return c.json(error.body, error.status);
    throw error;
  }
}

/** A zod failure as the memory routes answer every refusal: `{error, code: invalid_input}`. */
export function memoryValidationHook(
  result: { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } },
  c: Context,
) {
  if (result.success) return undefined;
  const issue = result.error?.issues[0];
  const where = issue?.path.length ? `${issue.path.map(String).join('.')}: ` : '';
  return c.json({ error: `${where}${issue?.message ?? 'Invalid input'}`, code: 'invalid_input', issues: result.error?.issues }, 400);
}

/** The session of an agent's token; a browser or personal token is 403 `session_token_required`. */
function sessionOf(viewer: Viewer): string {
  if (!viewer.sessionId) {
    throw new MemoryError(403, 'session_token_required', 'Only an agent’s session token can call this route.');
  }
  return viewer.sessionId;
}

// Every status a MemoryError can carry; a read answers only 400, 403 and 404.
const READ_ERRORS = errors(400, 403, 404, 409, 413, 422);
const WRITE_ERRORS = READ_ERRORS;

export function registerProjectMemoryRoutes(): void {
  // GET /v1/projects/:projectId/memory/layers/:layerKey — made on first read.
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/memory/layers/{layerKey}',
      tags: ['memory'],
      summary: 'Read a memory layer and its page counts',
      description: '`layerKey` is `company` or the space id of a channel or the caller’s DM. Another member’s DM is 404 `memory_not_found`.',
      ...auth,
      request: { params: layerParams },
      responses: { 200: json(MemoryLayerSchema, 'The layer'), ...READ_ERRORS },
    }),
    (c) =>
      withMemoryCaller(c, async ({ project, viewer }) => {
        const layer = await resolveLayerKey(project, c.req.valid('param').layerKey, viewer);
        return c.json(await layerView(layer, viewer), 200);
      }),
    memoryValidationHook,
  );

  // GET /v1/projects/:projectId/memory/layers/:layerKey/pages
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/memory/layers/{layerKey}/pages',
      tags: ['memory'],
      summary: 'List the pages of a memory layer',
      description: 'At most 200 summaries, newest first, without bodies. `deleted=1` lists the trash instead.',
      ...auth,
      request: {
        params: layerParams,
        query: z.object({
          type: MemoryPageTypeSchema.optional(),
          status: MemoryPageStatusSchema.optional(),
          deleted: z.enum(['0', '1']).optional(),
        }),
      },
      responses: { 200: json(MemoryPageListSchema, 'The pages'), ...READ_ERRORS },
    }),
    (c) =>
      withMemoryCaller(c, async ({ project, viewer }) => {
        const layer = await resolveLayerKey(project, c.req.valid('param').layerKey, viewer);
        const query = c.req.valid('query');
        const pages = await listPages(layer, viewer, { type: query.type, status: query.status, deleted: query.deleted === '1' });
        return c.json({ pages }, 200);
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
        '409 `title_taken` (with `page_id`) when a live page of the layer has the title, `page_limit` at 200 live pages, ' +
        '`layer_read_only` for an archived channel; 413 `page_too_large` over 8,192 bytes; 422 `secret_detected`.',
      ...auth,
      request: { params: layerParams, body: { content: { 'application/json': { schema: MemoryPageCreateInputSchema } } } },
      responses: { 201: json(MemoryPageSchema, 'The created page'), ...WRITE_ERRORS },
    }),
    (c) =>
      withMemoryCaller(c, async ({ project, viewer }) => {
        const layer = await resolveLayerKey(project, c.req.valid('param').layerKey, viewer);
        const pageId = await createPage(layer, viewer, c.req.valid('json'));
        return c.json(await getPage(project.projectId, pageId, viewer), 201);
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
        'Saves the sentence as a `note` page with the caller as its source, for an agent to file into a page. ' +
        'A `source_session_id` the caller cannot open is 404 `session_not_found`.',
      ...auth,
      request: { params: layerParams, body: { content: { 'application/json': { schema: MemoryNoteInputSchema } } } },
      responses: { 201: json(MemoryPageSchema, 'The note'), ...WRITE_ERRORS },
    }),
    (c) =>
      withMemoryCaller(c, async ({ project, viewer }) => {
        const layer = await resolveLayerKey(project, c.req.valid('param').layerKey, viewer);
        const pageId = await addNote(layer, viewer, c.req.valid('json'));
        return c.json(await getPage(project.projectId, pageId, viewer), 201);
      }),
    memoryValidationHook,
  );

  // GET /v1/projects/:projectId/memory/layers/:layerKey/changes — Recent changes.
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/memory/layers/{layerKey}/changes',
      tags: ['memory'],
      summary: 'List the recent changes of a memory layer',
      description: 'Newest first. Pass `next` back as `before` for the following page.',
      ...auth,
      request: { params: layerParams, query: cursorQuery(100) },
      responses: { 200: json(MemoryChangeListSchema, 'The changes'), ...READ_ERRORS },
    }),
    (c) =>
      withMemoryCaller(c, async ({ project, viewer }) => {
        const layer = await resolveLayerKey(project, c.req.valid('param').layerKey, viewer);
        const query = c.req.valid('query');
        return c.json(await layerChanges(layer, viewer, { limit: query.limit ?? 20, before: query.before }), 200);
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
      ...auth,
      request: { params: pageParams },
      responses: { 200: json(MemoryPageSchema, 'The page'), ...READ_ERRORS },
    }),
    (c) =>
      withMemoryCaller(c, async ({ project, viewer }) => c.json(await getPage(project.projectId, c.req.valid('param').pageId, viewer), 200)),
    memoryValidationHook,
  );

  // PATCH /v1/projects/:projectId/memory/pages/:pageId
  projectsApp.openapi(
    createRoute({
      method: 'patch',
      path: '/{projectId}/memory/pages/{pageId}',
      tags: ['memory'],
      summary: 'Edit a memory page',
      description: '409 `version_conflict` when the page changed since `base_version`.',
      ...auth,
      request: { params: pageParams, body: { content: { 'application/json': { schema: MemoryPageUpdateInputSchema } } } },
      responses: { 200: json(MemoryPageSchema, 'The page after the edit'), ...WRITE_ERRORS },
    }),
    (c) =>
      withMemoryCaller(c, async ({ project, viewer }) => {
        const pageId = c.req.valid('param').pageId;
        await updatePage(project.projectId, pageId, viewer, c.req.valid('json'));
        return c.json(await getPage(project.projectId, pageId, viewer), 200);
      }),
    memoryValidationHook,
  );

  // DELETE /v1/projects/:projectId/memory/pages/:pageId — to the trash.
  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{projectId}/memory/pages/{pageId}',
      tags: ['memory'],
      summary: 'Move a memory page to the trash',
      description:
        'Only the page’s creator or a project manager (`project.members.manage`); anyone else gets 403 `forbidden`. ' +
        'An unconfirmed page (Discard in Needs confirming) is open to anyone who writes the layer.',
      ...auth,
      request: { params: pageParams },
      responses: { 200: json(MemoryDeleteResultSchema, 'Deleted'), ...WRITE_ERRORS },
    }),
    (c) =>
      withMemoryCaller(c, async ({ project, viewer }) => {
        const versionId = await deletePage(project.projectId, c.req.valid('param').pageId, viewer);
        return c.json({ ok: true as const, version_id: versionId }, 200);
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
      description: 'Newest first. Pass `next` back as `before` for the following page.',
      ...auth,
      request: { params: pageParams, query: cursorQuery(100) },
      responses: { 200: json(MemoryVersionListSchema, 'The versions'), ...READ_ERRORS },
    }),
    (c) =>
      withMemoryCaller(c, async ({ project, viewer }) => {
        const query = c.req.valid('query');
        const history = await pageHistory(project.projectId, c.req.valid('param').pageId, viewer, { limit: query.limit ?? 50, before: query.before });
        return c.json(history, 200);
      }),
    memoryValidationHook,
  );

  // POST /v1/projects/:projectId/memory/pages/:pageId/restore
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/memory/pages/{pageId}/restore',
      tags: ['memory'],
      summary: 'Restore a memory page to one of its versions',
      description: 'Also brings a page back from the trash.',
      ...auth,
      request: { params: pageParams, body: { content: { 'application/json': { schema: MemoryRestoreInputSchema } } } },
      responses: { 200: json(MemoryPageSchema, 'The restored page'), ...WRITE_ERRORS },
    }),
    (c) =>
      withMemoryCaller(c, async ({ project, viewer }) => {
        const pageId = c.req.valid('param').pageId;
        await restorePage(project.projectId, pageId, c.req.valid('json').version_id, viewer);
        return c.json(await getPage(project.projectId, pageId, viewer), 200);
      }),
    memoryValidationHook,
  );

  // POST /v1/projects/:projectId/memory/pages/:pageId/confirm — Needs confirming.
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/memory/pages/{pageId}/confirm',
      tags: ['memory'],
      summary: 'Confirm an unconfirmed memory page',
      description:
        'Agents get an unconfirmed page (outside content) only after a person confirms it. A "(to confirm)" page merges into the page it names ' +
        'and goes to the trash; the response is that page. Discard is `DELETE`. 409 `not_unconfirmed` for a confirmed page.',
      ...auth,
      request: { params: pageParams },
      responses: { 200: json(MemoryPageSchema, 'The confirmed page'), ...WRITE_ERRORS },
    }),
    (c) =>
      withMemoryCaller(c, async ({ project, viewer }) => {
        const pageId = await confirmPage(project.projectId, c.req.valid('param').pageId, viewer);
        return c.json(await getPage(project.projectId, pageId, viewer), 200);
      }),
    memoryValidationHook,
  );

  // POST /v1/projects/:projectId/memory/versions/:versionId/undo
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/memory/versions/{versionId}/undo',
      tags: ['memory'],
      summary: 'Undo a memory change',
      description:
        'Reverts every page the change wrote (both pages of a filed note). 409 `already_undone`, or `superseded` when a page changed since.',
      ...auth,
      request: { params: versionParams },
      responses: { 200: json(MemoryUndoResultSchema, 'The pages live after the undo'), ...WRITE_ERRORS },
    }),
    (c) =>
      withMemoryCaller(c, async ({ project, viewer }) => {
        const live = await undoVersion(project.projectId, c.req.valid('param').versionId, viewer);
        const pages = await Promise.all(live.map((pageId) => getPage(project.projectId, pageId, viewer)));
        return c.json({ pages }, 200);
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
        'Full text over title, summary and body, then titles containing `q`. A person searches Company, every live channel and their own DMs, ' +
        'or the one layer `layer` names. A session token searches its thread’s layers, confirmed pages only.',
      ...auth,
      request: {
        params: projectParams,
        query: z.object({
          q: z
            .string()
            .trim()
            .min(MEMORY_SEARCH_LIMITS.q_min)
            .max(MEMORY_SEARCH_LIMITS.q_max)
            // Postgres refuses NUL in a text parameter: 400 here, not a 500 from the query.
            .refine((q) => !q.includes('\u0000'), 'q must not contain NUL'),
          layer: z.string().optional(),
          type: MemoryPageTypeSchema.optional(),
          limit: z.coerce.number().int().min(1).max(MEMORY_SEARCH_LIMITS.limit).optional(),
        }),
      },
      responses: { 200: json(MemorySearchResultSchema, 'The hits, best first'), ...READ_ERRORS },
    }),
    (c) =>
      withMemoryCaller(c, async ({ project, viewer }) => {
        const query = c.req.valid('query');
        const result = await searchMemory(project, viewer, { ...query, limit: query.limit ?? MEMORY_SEARCH_LIMITS.limit });
        return c.json(result, 200);
      }),
    memoryValidationHook,
  );

  // GET /v1/projects/:projectId/sessions/:sessionId/memory-usage — "Used memory".
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/sessions/{sessionId}/memory-usage',
      tags: ['memory'],
      summary: 'List the memory pages a thread’s agent was given',
      description:
        'The pages listed to the agent at the thread’s first turn, by layer; pages deleted since are left out. `loaded_at` is null before the first turn. ' +
        'A thread the caller cannot open is 404 `session_not_found`.',
      ...auth,
      request: { params: projectParams.extend({ sessionId: z.string() }) },
      responses: { 200: json(MemoryUsageSchema, 'The pages, by layer'), ...READ_ERRORS },
    }),
    (c) =>
      withMemoryCaller(c, async ({ viewer, canOpenSession }) => {
        const sessionId = c.req.valid('param').sessionId;
        if (!(await canOpenSession(sessionId))) throw new MemoryError(404, 'session_not_found', 'Thread not found.');
        return c.json(await threadUsage(sessionId, viewer.userId), 200);
      }),
    memoryValidationHook,
  );

  registerAgentMemoryRoutes();
}

/** The agent section: `remember` and the layer export (session token only). */
function registerAgentMemoryRoutes(): void {
  // POST /v1/projects/:projectId/memory/remember — kortixd's `remember` tool.
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/memory/remember',
      tags: ['memory'],
      summary: 'Save a fact to the calling thread’s memory',
      description:
        'Session token only. `layer` defaults to the thread’s channel or DM; `dm` outside a DM thread or `channel` outside a channel ' +
        'thread is 403 `memory_layer_forbidden`. A live page of the title gets the fact or body; else a page of `type` is made. ' +
        '409 `layer_read_only` / `page_limit`, 413 `page_too_large`, 422 `secret_detected`.',
      ...auth,
      request: { params: projectParams, body: { content: { 'application/json': { schema: MemoryRememberInputSchema } } } },
      responses: { 200: json(MemoryRememberResultSchema, 'Saved'), ...WRITE_ERRORS },
    }),
    (c) =>
      withMemoryCaller(c, async ({ project, viewer }) =>
        c.json(await remember(project.projectId, sessionOf(viewer), c.req.valid('json')), 200),
      ),
    memoryValidationHook,
  );

  // GET /v1/projects/:projectId/memory/layers/:layerId/export — kortixd's copy sync.
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/memory/layers/{layerId}/export',
      tags: ['memory'],
      summary: 'Export a memory layer as the files of the read-only copy',
      description:
        'Session token only, for a layer the calling thread reads (else 403 `memory_layer_forbidden`). INDEX.md and one markdown file per confirmed page, ' +
        'source tokens resolved to `[label]`.',
      ...auth,
      request: { params: projectParams.extend({ layerId: z.string() }) },
      responses: { 200: json(MemoryLayerExportSchema, 'The layer’s files'), ...READ_ERRORS },
    }),
    (c) =>
      withMemoryCaller(c, async ({ project, viewer }) =>
        c.json(await exportLayer(project.projectId, sessionOf(viewer), c.req.valid('param').layerId), 200),
      ),
    memoryValidationHook,
  );
}
