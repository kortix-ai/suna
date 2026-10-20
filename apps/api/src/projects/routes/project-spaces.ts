/**
 * Project spaces: channels and the caller's DMs with an agent
 * (`lib/project-spaces.ts`). Every route needs `session` project access and the
 * `project_channels` flag. Phase 1 has no channel membership: every member of
 * the project sees and uses every channel; a DM is visible to its owner only.
 */
import { createRoute, z } from '@hono/zod-openapi';
import {
  SpaceCreateInputSchema,
  SpaceDmInputSchema,
  SpaceListSchema,
  SpaceSchema,
  SpaceUpdateInputSchema,
} from '@kortix/api-contract';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { auth, errors, json } from '../../openapi';
import { isUuid } from '../../shared/validate';
import { DEFAULT_AGENT_SENTINEL, isLaunchableAgentName, loadProjectAgents } from '../agents';
import { loadProjectForUser } from '../lib/access';
import { resolveAndAuthorizeAgent } from '../lib/agent-access';
import { projectsApp } from '../lib/app';
import {
  createChannel,
  getOrCreateDm,
  listSpacesForUser,
  serializeSpace,
  updateChannel,
} from '../lib/project-spaces';

const projectParams = z.object({ projectId: z.string() });

export function registerProjectSpacesRoutes(): void {
  // GET /v1/projects/:projectId/spaces — creates `#general` on first read.
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/spaces',
      tags: ['spaces'],
      summary: 'List the channels of a project and the caller’s direct messages',
      ...auth,
      request: { params: projectParams },
      responses: {
        200: json(SpaceListSchema, 'Live channels (default first, then oldest first), then the caller’s DMs'),
        ...errors(403, 404),
      },
    }),
    async (c) => {
      const loaded = await loadProjectForUser(c, c.req.param('projectId'), 'session');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      const gate = requireFeatureFlag(c, loaded.row.metadata, 'project_channels');
      if (gate) return gate;
      const { row, userId } = loaded;
      const rows = await listSpacesForUser(row.projectId, row.accountId, userId);
      return c.json({ spaces: rows.map(serializeSpace) }, 200);
    },
  );

  // POST /v1/projects/:projectId/spaces — create a channel.
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/spaces',
      tags: ['spaces'],
      summary: 'Create a channel',
      ...auth,
      request: {
        params: projectParams,
        body: { content: { 'application/json': { schema: SpaceCreateInputSchema } } },
      },
      responses: {
        201: json(SpaceSchema, 'The created channel'),
        ...errors(400, 403, 404, 409),
      },
    }),
    async (c) => {
      const loaded = await loadProjectForUser(c, c.req.param('projectId'), 'session');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      const gate = requireFeatureFlag(c, loaded.row.metadata, 'project_channels');
      if (gate) return gate;
      const { row, userId } = loaded;
      const result = await createChannel(row.projectId, row.accountId, userId, c.req.valid('json'));
      if ('error' in result) return c.json(result.error.body, result.error.status);
      return c.json(serializeSpace(result.space), 201);
    },
  );

  // POST /v1/projects/:projectId/spaces/dm — the caller's DM with one agent.
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/spaces/dm',
      tags: ['spaces'],
      summary: 'Open the caller’s direct message with an agent',
      ...auth,
      request: {
        params: projectParams,
        body: { content: { 'application/json': { schema: SpaceDmInputSchema } } },
      },
      responses: {
        200: json(SpaceSchema, 'The DM, created on first call'),
        ...errors(400, 403, 404),
      },
    }),
    async (c) => {
      const loaded = await loadProjectForUser(c, c.req.param('projectId'), 'session');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      const gate = requireFeatureFlag(c, loaded.row.metadata, 'project_channels');
      if (gate) return gate;
      const agentName = c.req.valid('json').agent_name;
      // The session create route's gates: the caller may run this agent, and
      // the project's manifest declares it.
      await resolveAndAuthorizeAgent(c, loaded, loaded.row.projectId, agentName);
      const agents = await loadProjectAgents(loaded.row, { forceRefresh: 'tip-proof', rethrowReadErrors: true });
      if (agentName === DEFAULT_AGENT_SENTINEL || !isLaunchableAgentName(agentName, agents)) {
        return c.json({ error: `No agent "${agentName}" in this project.`, code: 'agent_not_found' }, 404);
      }
      const space = await getOrCreateDm(loaded.row.projectId, loaded.row.accountId, loaded.userId, agentName);
      return c.json(serializeSpace(space), 200);
    },
  );

  // PATCH /v1/projects/:projectId/spaces/:spaceId — rename, describe, archive, unarchive.
  projectsApp.openapi(
    createRoute({
      method: 'patch',
      path: '/{projectId}/spaces/{spaceId}',
      tags: ['spaces'],
      summary: 'Update a channel',
      ...auth,
      request: {
        params: projectParams.extend({ spaceId: z.string() }),
        body: { content: { 'application/json': { schema: SpaceUpdateInputSchema } } },
      },
      responses: {
        200: json(SpaceSchema, 'The updated channel'),
        ...errors(400, 403, 404, 409),
      },
    }),
    async (c) => {
      const loaded = await loadProjectForUser(c, c.req.param('projectId'), 'session');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      const gate = requireFeatureFlag(c, loaded.row.metadata, 'project_channels');
      if (gate) return gate;
      const spaceId = c.req.param('spaceId');
      if (!isUuid(spaceId)) return c.json({ error: 'Channel not found', code: 'space_not_found' }, 404);
      const result = await updateChannel(loaded.row.projectId, loaded.userId, spaceId, c.req.valid('json'));
      if ('error' in result) return c.json(result.error.body, result.error.status);
      return c.json(serializeSpace(result.space), 200);
    },
  );
}
