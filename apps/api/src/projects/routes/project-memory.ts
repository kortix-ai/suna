/**
 * Memory pages (`project_channels`): `/v1/projects/:projectId/memory/*`.
 * Every rule lives in `../../memory`; these handlers read the request, build
 * the viewer and map a `MemoryError` to its status and `{error, code}` body.
 *
 * Every route needs `session` project access and the flag. People read and
 * write the layers they see. A session-bound caller (an agent's token) reads
 * only its thread's layers and gets 403 `use_remember` on writes.
 */
import { createRoute, z } from '@hono/zod-openapi';
import {
  MemoryChangeListSchema,
  MemoryDeleteResultSchema,
  MemoryLayerSchema,
  MemoryNoteInputSchema,
  MemoryPageCreateInputSchema,
  MemoryPageListSchema,
  MemoryPageSchema,
  MemoryPageStatusSchema,
  MemoryPageTypeSchema,
  MemoryPageUpdateInputSchema,
  MemoryRestoreInputSchema,
  MemoryUndoResultSchema,
  MemoryVersionListSchema,
} from '@kortix/api-contract';
import type { Context } from 'hono';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { PROJECT_ACTIONS } from '../../iam';
import {
  addNote,
  createPage,
  deletePage,
  getPage,
  layerChanges,
  layerView,
  listPages,
  MemoryError,
  pageHistory,
  resolveLayerKey,
  restorePage,
  undoVersion,
  updatePage,
  type Viewer,
} from '../../memory';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { auth, errors, json } from '../../openapi';
import type { AppEnv } from '../../types';
import { loadProjectForUser, projectCapabilityAllowed } from '../lib/access';
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

type Caller = { project: { projectId: string; metadata: unknown }; viewer: Viewer };

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
  const manager = await projectCapabilityAllowed(c, userId, row.accountId, row.projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);
  try {
    return await run({
      project: { projectId: row.projectId, metadata: row.metadata },
      viewer: { userId, manager, sessionId: callerKortixSessionId(c) },
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
        const pages = await listPages(layer, { type: query.type, status: query.status, deleted: query.deleted === '1' });
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
      description: 'Saves the sentence as a `note` page with the caller as its source, for an agent to file into a page.',
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
      description: 'Only the page’s creator or a project manager (`project.members.manage`); anyone else gets 403 `forbidden`.',
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
}
