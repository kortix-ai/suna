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
  SpaceLinkCreateInputSchema,
  SpaceLinkListSchema,
  SpaceLinkSchema,
  SpaceListSchema,
  SpaceSchema,
  SpaceSummarySchema,
  SpaceUpdateInputSchema,
} from '@kortix/api-contract';
import { gridApps } from '@kortix/shared/app-config';
import type { Context } from 'hono';
import { AppObject, appsJson } from '../../apps/serialize';
import { spaceApps } from '../../apps/space-apps';
import { makeChannelFolders, moveChannelFolder } from '../../drives/space-folders';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { PROJECT_ACTIONS } from '../../iam';
import type { AppEnv } from '../../types';
import { auth, errors, json } from '../../openapi';
import { isUuid } from '../../shared/validate';
import { DEFAULT_AGENT_SENTINEL, isLaunchableAgentName, loadProjectAgents } from '../agents';
import { assertProjectCapability, loadProjectForUser, projectCapabilityAllowed } from '../lib/access';
import { resolveAndAuthorizeAgent } from '../lib/agent-access';
import { projectsApp } from '../lib/app';
import {
  addSpaceLink,
  countSpaceLinks,
  deleteSpaceLink,
  listSpaceLinks,
  SPACE_LINKS_MAX,
  type LinkViewer,
} from '../lib/project-space-links';
import { countSpaceTriggers } from '../lib/trigger-space';
import {
  createChannel,
  findLiveChannel,
  findSessionSpace,
  getOrCreateDm,
  listSpacesForUser,
  serializeSpace,
  updateChannel,
} from '../lib/project-spaces';

const projectParams = z.object({ projectId: z.string() });
const spaceParams = projectParams.extend({ spaceId: z.string() });
const CHANNEL_NOT_FOUND = { error: 'Channel not found', code: 'space_not_found' } as const;

/**
 * The project (`session` access), the `project_channels` flag, then a live
 * channel of the project: the gate of every `/spaces/:spaceId/*` tab route.
 * A DM, an archived channel or an unknown id answers 404.
 */
async function loadChannel(c: Context<AppEnv>) {
  const loaded = await loadProjectForUser(c, c.req.param('projectId')!, 'session');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const gate = requireFeatureFlag(c, loaded.row.metadata, 'project_channels');
  if (gate) return gate;
  const spaceId = c.req.param('spaceId')!;
  const space = isUuid(spaceId) ? await findLiveChannel(loaded.row.projectId, spaceId) : null;
  if (!space) return c.json(CHANNEL_NOT_FOUND, 404);
  return { loaded, space };
}

type LoadedProject = NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>;

/** A project manager may delete any link; anyone else only their own. */
async function linkViewer(c: Context<AppEnv>, loaded: LoadedProject): Promise<LinkViewer> {
  const { userId, row } = loaded;
  const manager = await projectCapabilityAllowed(c, userId, row.accountId, row.projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);
  return { userId, manager };
}

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
      // Its Files folder and Memory folder, best effort and off the response path.
      void makeChannelFolders(row.accountId, row.projectId, result.space.slug!);
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
      // The channel's folder follows a rename, best effort (it logs a failure).
      // Waited for, so the renaming client never sees the new slug before the
      // move settled. Another member who opens the Files tab during the move
      // can still make the new folder first; the move then fails with 409.
      if (result.renamedFrom) await moveChannelFolder(loaded.row.projectId, spaceId, result.renamedFrom, result.space.slug!);
      return c.json(serializeSpace(result.space), 200);
    },
  );

  // GET /v1/projects/:projectId/spaces/:spaceId/apps — Apps deployed from the channel's threads.
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/spaces/{spaceId}/apps',
      tags: ['spaces'],
      summary: 'List the Apps of a channel',
      description:
        'The live Apps of the project with a deployment made from a thread of this channel, filtered like ' +
        '`GET /projects/:id/apps`: only the Apps the caller may open. An App never deployed from a thread is in no channel.',
      ...auth,
      request: { params: spaceParams },
      responses: {
        200: json(z.object({ apps: z.array(AppObject) }), 'The channel’s Apps, newest first'),
        ...errors(403, 404),
      },
    }),
    async (c) => {
      const channel = await loadChannel(c);
      if (channel instanceof Response) return channel;
      const { loaded, space } = channel;
      const { userId, row } = loaded;
      await assertProjectCapability(c, userId, row.accountId, row.projectId, PROJECT_ACTIONS.PROJECT_APP_READ);
      const found = await spaceApps(row.projectId, space.spaceId, userId);
      return c.json({ apps: await appsJson(found.rows, userId, found.openable) }, 200);
    },
  );

  // GET /v1/projects/:projectId/spaces/:spaceId/links — the channel's links, newest first.
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/spaces/{spaceId}/links',
      tags: ['spaces'],
      summary: 'List the links of a channel',
      ...auth,
      request: { params: spaceParams },
      responses: { 200: json(SpaceLinkListSchema, 'The channel’s links, newest first'), ...errors(403, 404) },
    }),
    async (c) => {
      const channel = await loadChannel(c);
      if (channel instanceof Response) return channel;
      const { loaded, space } = channel;
      const links = await listSpaceLinks(space.spaceId, loaded.row.accountId, await linkViewer(c, loaded));
      return c.json({ links }, 200);
    },
  );

  // POST /v1/projects/:projectId/spaces/:spaceId/links — pin a link to the channel.
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/spaces/{spaceId}/links',
      tags: ['spaces'],
      summary: 'Add a link to a channel',
      ...auth,
      request: {
        params: spaceParams,
        body: { content: { 'application/json': { schema: SpaceLinkCreateInputSchema } } },
      },
      responses: { 201: json(SpaceLinkSchema, 'The added link'), ...errors(400, 403, 404, 409) },
    }),
    async (c) => {
      const channel = await loadChannel(c);
      if (channel instanceof Response) return channel;
      const { loaded, space } = channel;
      const viewer = await linkViewer(c, loaded);
      const link = await addSpaceLink(loaded.row.projectId, space.spaceId, loaded.row.accountId, viewer, c.req.valid('json'));
      if (link === 'link_limit') {
        return c.json({ error: `A channel holds at most ${SPACE_LINKS_MAX} links. Remove one first.`, code: 'link_limit' }, 409);
      }
      return c.json(link, 201);
    },
  );

  // DELETE /v1/projects/:projectId/spaces/:spaceId/links/:linkId — the link's creator or a project manager.
  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{projectId}/spaces/{spaceId}/links/{linkId}',
      tags: ['spaces'],
      summary: 'Remove a link from a channel',
      ...auth,
      request: { params: spaceParams.extend({ linkId: z.string() }) },
      responses: { 200: json(z.object({ ok: z.literal(true) }), 'Removed'), ...errors(403, 404) },
    }),
    async (c) => {
      const channel = await loadChannel(c);
      if (channel instanceof Response) return channel;
      const { loaded, space } = channel;
      const linkId = c.req.param('linkId');
      const result = isUuid(linkId) ? await deleteSpaceLink(space.spaceId, linkId, await linkViewer(c, loaded)) : 'not_found';
      if (result === 'not_found') return c.json({ error: 'Link not found', code: 'link_not_found' }, 404);
      if (result === 'forbidden') {
        return c.json({ error: 'Only the person who added the link or a project manager can remove it.', code: 'forbidden' }, 403);
      }
      return c.json({ ok: true as const }, 200);
    },
  );

  // GET /v1/projects/:projectId/spaces/:spaceId/summary — the counts beside the tab labels.
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/spaces/{spaceId}/summary',
      tags: ['spaces'],
      summary: 'Count the Apps, links and triggers of a channel or the caller’s DM',
      description:
        '`apps` counts the cards the channel’s Apps tab shows (the Apps grid rule); 0 for a caller without the App read permission. ' +
        '`triggers` counts the triggers that post to the space; 0 without the trigger read permission. A DM has no Apps or links: both are 0. ' +
        'Later fields are added, never renamed.',
      ...auth,
      request: { params: spaceParams },
      responses: { 200: json(SpaceSummarySchema, 'The tab counts'), ...errors(403, 404) },
    }),
    async (c) => {
      const loaded = await loadProjectForUser(c, c.req.param('projectId'), 'session');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      const gate = requireFeatureFlag(c, loaded.row.metadata, 'project_channels');
      if (gate) return gate;
      const { userId, row } = loaded;
      const spaceId = c.req.param('spaceId');
      // A live channel or the caller's own DM; another member's DM reads as not found.
      const space = isUuid(spaceId) ? await findSessionSpace(row.projectId, spaceId, userId) : null;
      if (!space) return c.json(CHANNEL_NOT_FOUND, 404);
      const allowed = (action: string) => projectCapabilityAllowed(c, userId, row.accountId, row.projectId, action);
      const channel = space.kind === 'channel';
      const [appsAllowed, appAdmin, triggersAllowed, links] = await Promise.all([
        channel && allowed(PROJECT_ACTIONS.PROJECT_APP_READ),
        channel && allowed(PROJECT_ACTIONS.PROJECT_APP_ADMIN),
        allowed(PROJECT_ACTIONS.PROJECT_TRIGGER_READ),
        channel ? countSpaceLinks(space.spaceId) : 0,
      ]);
      let apps = 0;
      if (appsAllowed) {
        // The cards the Apps tab shows: the grid's rule over the same list, with the web's `canAdmin` leaf.
        const found = await spaceApps(row.projectId, space.spaceId, userId);
        apps = gridApps(await appsJson(found.rows, userId, found.openable), appAdmin).length;
      }
      const triggers = triggersAllowed ? await countSpaceTriggers(space.spaceId) : 0;
      return c.json({ apps, links, triggers }, 200);
    },
  );
}
