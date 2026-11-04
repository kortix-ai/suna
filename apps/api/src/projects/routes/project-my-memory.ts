/**
 * What My Kortix remembers about the caller:
 * `/v1/projects/:projectId/memory/me/agent/:agent[/pages/:name]`. `:agent` is
 * `mykortix` (its old slug `meta` too); any other agent is 404.
 *
 * Every route reads and writes the caller's own `/Users/<person>/Memory/mykortix`
 * folder, never another person's: a person with their login, or their My
 * Kortix session with its session token (the person is the token's
 * `on_behalf_of`). Any other session token gets 403 `my_kortix_only`. The
 * rules (one page per name, caps, secrets) are `../../memory/my-memory.ts`.
 * Files off: 403 `feature_disabled`, as on every memory route.
 */
import { createRoute, z } from '@hono/zod-openapi';
import {
  MyKortixMemoryDeleteResultSchema,
  MyKortixMemoryIndexSchema,
  MyKortixMemoryPageSchema,
  MyKortixMemorySaveInputSchema,
  MyKortixMemorySaveResultSchema,
} from '@kortix/api-contract';
import {
  assertMemoryName,
  assertMyKortixAgent,
  authorName,
  deleteMyMemory,
  listMyMemory,
  MY_KORTIX_AUTHOR,
  myKortixLayer,
  saveMyMemory,
  viewMyMemory,
} from '../../memory';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { auth, errors, json } from '../../openapi';
import { projectsApp } from '../lib/app';
import { memoryValidationHook, withMemoryCaller } from './project-memory';

const agentParams = z.object({ projectId: z.string(), agent: z.string() });
const pageParams = agentParams.extend({ name: z.string() });
const ERRORS = errors(400, 403, 404, 409, 413, 422, 503);
const MINE = { myKortixSession: true } as const;

export function registerProjectMyMemoryRoutes(): void {
  // GET /v1/projects/:projectId/memory/me/agent/:agent
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/memory/me/agent/{agent}',
      tags: ['memory'],
      summary: 'List what My Kortix remembers about you',
      description:
        'The caller’s own pages in `/Users/<person>/Memory/mykortix`, newest first, at most 200, and the index text a My Kortix turn starts with. ' +
        'A person, or their My Kortix session.',
      ...auth,
      request: { params: agentParams },
      responses: { 200: json(MyKortixMemoryIndexSchema, 'The index'), ...ERRORS },
    }),
    (c) =>
      withMemoryCaller(
        c,
        async ({ project, viewer }) => {
          assertMyKortixAgent(c.req.valid('param').agent);
          return c.json(await listMyMemory(await myKortixLayer(project, viewer)), 200);
        },
        MINE,
      ),
    memoryValidationHook,
  );

  // GET /v1/projects/:projectId/memory/me/agent/:agent/pages/:name
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/memory/me/agent/{agent}/pages/{name}',
      tags: ['memory'],
      summary: 'Read one thing My Kortix remembers about you',
      description: '`name` is the page’s slug. 404 `memory_not_found` when no page of the caller has it.',
      ...auth,
      request: { params: pageParams },
      responses: { 200: json(MyKortixMemoryPageSchema, 'The page'), ...ERRORS },
    }),
    (c) =>
      withMemoryCaller(
        c,
        async ({ project, viewer }) => {
          const { agent, name } = c.req.valid('param');
          assertMyKortixAgent(agent);
          assertMemoryName(name);
          return c.json(await viewMyMemory(await myKortixLayer(project, viewer), name), 200);
        },
        MINE,
      ),
    memoryValidationHook,
  );

  // PUT /v1/projects/:projectId/memory/me/agent/:agent/pages/:name
  projectsApp.openapi(
    createRoute({
      method: 'put',
      path: '/{projectId}/memory/me/agent/{agent}/pages/{name}',
      tags: ['memory'],
      summary: 'Save one thing My Kortix remembers about you',
      description:
        'Replaces the caller’s page with that `name`, or creates `<folder>/<name>.md`: one page per name. 201 when created, 200 when updated. ' +
        '409 `memory_full` past 200 pages; 413 `page_too_large` over 16,384 bytes; 422 `secret_detected`.',
      ...auth,
      request: { params: pageParams, body: { content: { 'application/json': { schema: MyKortixMemorySaveInputSchema } } } },
      responses: { 200: json(MyKortixMemorySaveResultSchema, 'Updated'), 201: json(MyKortixMemorySaveResultSchema, 'Created'), ...ERRORS },
    }),
    (c) =>
      withMemoryCaller(
        c,
        async ({ project, viewer }) => {
          const { agent, name } = c.req.valid('param');
          assertMyKortixAgent(agent);
          assertMemoryName(name);
          const layer = await myKortixLayer(project, viewer);
          // A My Kortix session writes as My Kortix; a person writes under their own name.
          const author = callerKortixSessionId(c) ? MY_KORTIX_AUTHOR : await authorName(viewer.userId);
          const saved = await saveMyMemory(layer, name, author, c.req.valid('json'));
          return saved.created ? c.json(saved, 201) : c.json(saved, 200);
        },
        MINE,
      ),
    memoryValidationHook,
  );

  // DELETE /v1/projects/:projectId/memory/me/agent/:agent/pages/:name
  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{projectId}/memory/me/agent/{agent}/pages/{name}',
      tags: ['memory'],
      summary: 'Forget one thing My Kortix remembers about you',
      description: 'Deletes the caller’s page with that `name` for good (a Drive delete). 404 `memory_not_found` when there is none.',
      ...auth,
      request: { params: pageParams },
      responses: { 200: json(MyKortixMemoryDeleteResultSchema, 'Deleted'), ...ERRORS },
    }),
    (c) =>
      withMemoryCaller(
        c,
        async ({ project, viewer }) => {
          const { agent, name } = c.req.valid('param');
          assertMyKortixAgent(agent);
          assertMemoryName(name);
          return c.json(await deleteMyMemory(await myKortixLayer(project, viewer), name), 200);
        },
        MINE,
      ),
    memoryValidationHook,
  );
}
