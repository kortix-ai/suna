/**
 * Project spaces: channels and the caller's DMs with an agent
 * (`lib/project-spaces.ts`). Every route needs `session` project access and the
 * `project_channels` flag. A public channel is seen and used by every member
 * of the project; membership (`lib/project-space-members.ts`) is its roster. A
 * private channel exists only for its members (`lib/space-access.ts`): to
 * anyone else every route answers 404 `space_not_found`, never 403, so its id
 * is never confirmed. A project manager outside it may only rename, archive,
 * list and remove its members; they read none of its content. A DM is
 * visible to its owner only.
 */
import { createRoute, z } from '@hono/zod-openapi';
import {
  ChannelsOnboardingMarkInputSchema,
  ChannelsOnboardingSchema,
  PrivateChannelListSchema,
  SpaceCreateInputSchema,
  SpaceDmInputSchema,
  SpaceLinkCreateInputSchema,
  SpaceLinkListSchema,
  SpaceLinkPinInputSchema,
  SpaceLinkPinResultSchema,
  SpaceLinkSchema,
  SpaceListSchema,
  SpaceMemberListSchema,
  SpaceMembersAddInputSchema,
  SpaceSchema,
  SpaceUpdateInputSchema,
} from '@kortix/api-contract';
import type { Context } from 'hono';
import { AppObject, appsJson } from '../../apps/serialize';
import { spaceApps } from '../../apps/space-apps';
import { afterPrivateChannelChange, makeChannelFolders, makeDmFolders, moveChannelFolder, refreshRunningThreadNotes } from '../../drives/space-folders';
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
  deleteSpaceLink,
  listSpaceLinks,
  pinSpaceLink,
  SPACE_ADDED_LINKS_MAX,
  SPACE_LINKS_MAX,
  type LinkViewer,
} from '../lib/project-space-links';
import { addChannelsMark, channelsOnboarding, generalNotice } from '../lib/channels-onboarding';
import {
  addSpaceMembers,
  isSpaceMember,
  joinedChannelIds,
  joinSpace,
  listSpaceMembers,
  removeSpaceMember,
} from '../lib/project-space-members';
import {
  SPACE_NOT_FOUND,
  createChannel,
  findLiveChannel,
  findSessionSpace,
  getOrCreateDm,
  listHiddenPrivateChannels,
  listSpacesForUser,
  serializeSpace,
  type SpaceViewer,
  updateChannel,
} from '../lib/project-spaces';
import { canSeeSpace, PRIVATE_CHANNELS_UNAVAILABLE, privateChannelsAvailable, spaceAccessFor } from '../../shared/space-access';
import { callerKortixSessionId } from '../../middleware/caller-session';

const projectParams = z.object({ projectId: z.string() });
const spaceParams = projectParams.extend({ spaceId: z.string() });

/**
 * The project (`session` access), the `project_channels` flag, then a live
 * channel of the project the caller may see: the gate of every
 * `/spaces/:spaceId/*` tab route. A DM, an archived channel, an unknown id and
 * a private channel the caller is not in answer 404. `managerMay`: a project
 * manager also passes for a private channel they are not in (the member list
 * and removal); such a route reads no channel content.
 */
async function loadChannel(c: Context<AppEnv>, opts: { managerMay?: boolean } = {}) {
  const loaded = await loadSpacesProject(c);
  if (loaded instanceof Response) return loaded;
  const spaceId = c.req.param('spaceId')!;
  const space = isUuid(spaceId) ? await findLiveChannel(loaded.row.projectId, spaceId) : null;
  if (!space) return c.json(SPACE_NOT_FOUND, 404);
  const viewer = await spaceViewer(c, loaded);
  if (!canSeeSpace(space, viewer.access) && !(opts.managerMay && viewer.manager)) return c.json(SPACE_NOT_FOUND, 404);
  return { loaded, space, viewer };
}

type LoadedProject = NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>;

/** The project (`session` access) and the `project_channels` flag: the gate of every route here. */
async function loadSpacesProject(c: Context<AppEnv>) {
  const loaded = await loadProjectForUser(c, c.req.param('projectId')!, 'session');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const gate = requireFeatureFlag(c, loaded.row.metadata, 'project_channels');
  if (gate) return gate;
  return loaded;
}

/** Whether a name is an agent the project's manifest declares and a thread can start on. */
async function projectAgentCheck(loaded: LoadedProject): Promise<(name: string) => boolean> {
  const agents = await loadProjectAgents(loaded.row, { forceRefresh: 'tip-proof', rethrowReadErrors: true });
  return (name) => name !== DEFAULT_AGENT_SENTINEL && isLaunchableAgentName(name, agents);
}

/**
 * Renaming, archiving, converting, joining and changing members are people's
 * decisions: a session-bound agent/sandbox token is refused before any channel
 * is looked up (403), so the answer says nothing about the id.
 */
const SESSION_BOUND_CALLER = {
  error: 'An agent cannot change a channel or its members. A person must do it.',
  code: 'session_bound_caller',
} as const;

/**
 * A project manager may edit any channel and delete any link; anyone else only
 * their own. A session-bound token never carries the manager standing, and
 * sees only its own thread's private channel (`access`).
 */
async function spaceViewer(c: Context<AppEnv>, loaded: LoadedProject): Promise<LinkViewer & SpaceViewer> {
  const { userId, row } = loaded;
  const bound = callerKortixSessionId(c);
  const [manager, access] = await Promise.all([
    bound === null
      ? projectCapabilityAllowed(c, userId, row.accountId, row.projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE)
      : Promise.resolve(false),
    spaceAccessFor(row.projectId, userId, bound),
  ]);
  return { userId, manager, access };
}

/** The 400 body for a channel agent list with a repeated name or a name that is not an agent of the project; null when it is valid. */
async function invalidChannelAgents(loaded: LoadedProject, names: readonly string[]) {
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated) return { error: `"${repeated}" is in the list twice.`, code: 'invalid_agents' };
  if (names.length === 0) return null;
  const isAgent = await projectAgentCheck(loaded);
  const unknown = names.find((name) => !isAgent(name));
  return unknown ? { error: `No agent "${unknown}" in this project.`, code: 'invalid_agents' } : null;
}

/** Registers every `/spaces` and `/onboarding/channels` route, in dispatch order. */
export function registerProjectSpacesRoutes(): void {
  registerSpaceRoutes();
  registerSpaceLinkRoutes();
  registerSpaceMemberRoutes();
  registerChannelsOnboardingRoutes();
}

/** The spaces list, private channels, create, DM, update and a channel's Apps. */
function registerSpaceRoutes(): void {
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
      const loaded = await loadSpacesProject(c);
      if (loaded instanceof Response) return loaded;
      const { row, userId } = loaded;
      const [viewer, joined] = await Promise.all([spaceViewer(c, loaded), joinedChannelIds(row.projectId, userId)]);
      const rows = await listSpacesForUser(row.projectId, row.accountId, viewer.access);
      return c.json(
        {
          spaces: rows.map((space) => serializeSpace(space, viewer, joined.has(space.spaceId))),
          general_notice: generalNotice(row.metadata),
          private_channels_available: privateChannelsAvailable(),
        },
        200,
      );
    },
  );

  // GET /v1/projects/:projectId/spaces/private — managers: the private channels they are not in.
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/spaces/private',
      tags: ['spaces'],
      summary: 'List the private channels the caller is not in (project managers)',
      description:
        'Project managers only (403 `forbidden` otherwise). Name, member count and creator of each private channel ' +
        'the caller is not in, archived ones included. Never its threads, files, memory or links. ' +
        'A manager renames or archives it with `PATCH /spaces/:spaceId` and lists, adds and removes its people with ' +
        '`/spaces/:spaceId/members`.',
      ...auth,
      request: { params: projectParams },
      responses: { 200: json(PrivateChannelListSchema, 'The private channels the caller is not in'), ...errors(403, 404) },
    }),
    async (c) => {
      const loaded = await loadSpacesProject(c);
      if (loaded instanceof Response) return loaded;
      const viewer = await spaceViewer(c, loaded);
      if (!viewer.manager) return c.json({ error: 'Only a project manager can list private channels.', code: 'forbidden' }, 403);
      return c.json({ channels: await listHiddenPrivateChannels(loaded.row, viewer.access) }, 200);
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
        ...errors(400, 403, 404, 409, 503),
      },
    }),
    async (c) => {
      const loaded = await loadSpacesProject(c);
      if (loaded instanceof Response) return loaded;
      const { row } = loaded;
      const input = c.req.valid('json');
      if (input.visibility === 'private' && !privateChannelsAvailable()) return c.json(PRIVATE_CHANNELS_UNAVAILABLE, 409);
      // Creating a channel is a person's decision too.
      if (callerKortixSessionId(c) !== null) return c.json(SESSION_BOUND_CALLER, 403);
      // The viewer: a taken slug's 409 says whether the caller may unarchive its channel.
      const viewer = await spaceViewer(c, loaded);
      const result = await createChannel(row.projectId, row.accountId, viewer, input);
      if ('error' in result) return c.json(result.error.body, result.error.status);
      // Its Files folder, best effort and off the response path.
      void makeChannelFolders(row.accountId, row.projectId, result.space.slug!, result.space.visibility === 'private' ? result.space.spaceId : null);
      return c.json(serializeSpace(result.space, viewer, true), 201);
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
      const loaded = await loadSpacesProject(c);
      if (loaded instanceof Response) return loaded;
      const agentName = c.req.valid('json').agent_name;
      // The session create route's gates: the caller may run this agent, and
      // the project's manifest declares it.
      await resolveAndAuthorizeAgent(c, loaded, loaded.row.projectId, agentName);
      if (!(await projectAgentCheck(loaded))(agentName)) {
        return c.json({ error: `No agent "${agentName}" in this project.`, code: 'agent_not_found' }, 404);
      }
      const space = await getOrCreateDm(loaded.row.projectId, loaded.row.accountId, loaded.userId, agentName);
      // Its Files folder in the caller’s own folder, best effort and off the response path.
      // The web opens a DM only when it is not listed yet, so this runs about once per DM; a repeat is a no-op.
      void makeDmFolders(loaded.row.accountId, loaded.row.projectId, loaded.userId, agentName);
      return c.json(serializeSpace(space, await spaceViewer(c, loaded), true), 200);
    },
  );

  // PATCH /v1/projects/:projectId/spaces/:spaceId — rename, describe, archive, unarchive, set the agent list.
  projectsApp.openapi(
    createRoute({
      method: 'patch',
      path: '/{projectId}/spaces/{spaceId}',
      tags: ['spaces'],
      summary: 'Update a channel',
      description:
        'Only the channel’s creator or a project manager (`project.members.manage`) may edit it; anyone else gets 403 `forbidden`. ' +
        'A DM is 400 `dm_not_editable`. `agents` replaces the channel’s agent list (the first is its default): a repeated name or ' +
        'a name that is not an agent of the project is 400 `invalid_agents`.',
      ...auth,
      request: {
        params: projectParams.extend({ spaceId: z.string() }),
        body: { content: { 'application/json': { schema: SpaceUpdateInputSchema } } },
      },
      responses: {
        200: json(SpaceSchema, 'The updated channel'),
        ...errors(400, 403, 404, 409, 503),
      },
    }),
    async (c) => {
      if (callerKortixSessionId(c) !== null) return c.json(SESSION_BOUND_CALLER, 403);
      const loaded = await loadSpacesProject(c);
      if (loaded instanceof Response) return loaded;
      const spaceId = c.req.param('spaceId');
      if (!isUuid(spaceId)) return c.json(SPACE_NOT_FOUND, 404);
      const input = c.req.valid('json');
      if (input.visibility === 'private' && !privateChannelsAvailable()) return c.json(PRIVATE_CHANNELS_UNAVAILABLE, 409);
      if (input.agents !== undefined) {
        const invalid = await invalidChannelAgents(loaded, input.agents);
        if (invalid) return c.json(invalid, 400);
      }
      const viewer = await spaceViewer(c, loaded);
      const result = await updateChannel(loaded.row.projectId, viewer, spaceId, input);
      if ('error' in result) return c.json(result.error.body, result.error.status);
      // The channel's folder follows a rename, best effort (it logs a failure).
      // Waited for, so the renaming client never sees the new slug before the
      // move settled. Another member who opens the Files tab during the move
      // can still make the new folder first; the move then fails with 409.
      if (result.renamedFrom) {
        await moveChannelFolder(loaded.row.projectId, spaceId, result.renamedFrom, result.space.slug!, result.space.visibility);
      }
      // Made private: the members' folder grants, every sandbox in line with
      // the moved folder, and the channel's running threads told its new path.
      if (result.converted) {
        await afterPrivateChannelChange(loaded.row.projectId, { enforce: true });
        void refreshRunningThreadNotes(loaded.row.projectId, spaceId);
      }
      const serialized = serializeSpace(result.space, viewer, await isSpaceMember(result.space, viewer.userId));
      // A manager outside a private channel gets its name and state, not its description or agents.
      if (!canSeeSpace(result.space, viewer.access)) return c.json({ ...serialized, description: null, agents: [] }, 200);
      return c.json(serialized, 200);
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
}

/** A channel's links: list, add, pin and remove. */
function registerSpaceLinkRoutes(): void {

  // GET /v1/projects/:projectId/spaces/:spaceId/links — the channel's links, the most recently shared first.
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/spaces/{spaceId}/links',
      tags: ['spaces'],
      summary: 'List the links of a channel',
      ...auth,
      request: { params: spaceParams },
      responses: {
        200: json(SpaceLinkListSchema, 'The channel’s links: pinned and shared in its threads, the most recently shared first'),
        ...errors(403, 404),
      },
    }),
    async (c) => {
      const channel = await loadChannel(c);
      if (channel instanceof Response) return channel;
      const { loaded, space, viewer } = channel;
      const links = await listSpaceLinks(space.spaceId, loaded.row.accountId, viewer);
      return c.json({ links }, 200);
    },
  );

  // POST /v1/projects/:projectId/spaces/:spaceId/links — add a link to the channel, unpinned.
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/spaces/{spaceId}/links',
      tags: ['spaces'],
      summary: 'Add a link to a channel',
      description:
        'The link is added unpinned and listed with the caller as its adder. An address the channel already holds keeps its row ' +
        '(and its pin) and takes the new title. A channel holds at most 200 added links: one more answers 409 `link_limit`.',
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
      const { loaded, space, viewer } = channel;
      const link = await addSpaceLink(loaded.row.projectId, space.spaceId, loaded.row.accountId, viewer, c.req.valid('json'));
      if (link === 'link_limit') {
        return c.json({ error: `A channel holds at most ${SPACE_ADDED_LINKS_MAX} added links. Remove one first.`, code: 'link_limit' }, 409);
      }
      // Running threads list the pinned links in their notes file: a new title on a pinned link reaches them.
      void refreshRunningThreadNotes(loaded.row.projectId, space.spaceId);
      return c.json(link, 201);
    },
  );

  // PATCH /v1/projects/:projectId/spaces/:spaceId/links/:linkId — pin or unpin; any member of the channel.
  projectsApp.openapi(
    createRoute({
      method: 'patch',
      path: '/{projectId}/spaces/{spaceId}/links/{linkId}',
      tags: ['spaces'],
      summary: 'Pin or unpin a link of a channel',
      description:
        'Agents in the channel read its pinned links. Unpinning only clears the pin: the link stays listed (DELETE removes it). ' +
        'Pinning past 200 pinned links answers 409 `link_limit`.',
      ...auth,
      request: {
        params: spaceParams.extend({ linkId: z.string() }),
        body: { content: { 'application/json': { schema: SpaceLinkPinInputSchema } } },
      },
      responses: { 200: json(SpaceLinkPinResultSchema, 'The link after the change'), ...errors(400, 403, 404, 409) },
    }),
    async (c) => {
      const channel = await loadChannel(c);
      if (channel instanceof Response) return channel;
      const { loaded, space, viewer } = channel;
      const linkId = c.req.param('linkId');
      const result = isUuid(linkId)
        ? await pinSpaceLink(space.spaceId, linkId, loaded.row.accountId, viewer, c.req.valid('json').pinned)
        : 'not_found';
      if (result === 'not_found') return c.json({ error: 'Link not found', code: 'link_not_found' }, 404);
      if (result === 'link_limit') {
        return c.json({ error: `A channel pins at most ${SPACE_LINKS_MAX} links. Unpin one first.`, code: 'link_limit' }, 409);
      }
      void refreshRunningThreadNotes(loaded.row.projectId, space.spaceId);
      return c.json({ link: result }, 200);
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
      const { loaded, space, viewer } = channel;
      const linkId = c.req.param('linkId');
      const result = isUuid(linkId) ? await deleteSpaceLink(space.spaceId, linkId, viewer) : 'not_found';
      if (result === 'not_found') return c.json({ error: 'Link not found', code: 'link_not_found' }, 404);
      if (result === 'forbidden') {
        return c.json({ error: 'Only the person who added the link or a project manager can remove it.', code: 'forbidden' }, 403);
      }
      void refreshRunningThreadNotes(loaded.row.projectId, space.spaceId);
      return c.json({ ok: true as const }, 200);
    },
  );
}

/** A channel's people: list, add, remove or leave, and join. */
function registerSpaceMemberRoutes(): void {
  // GET /v1/projects/:projectId/spaces/:spaceId/members — the channel's people.
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/spaces/{spaceId}/members',
      tags: ['spaces'],
      summary: 'List the people in a channel',
      description:
        'The same list for every viewer: the people added to the channel or who joined it, among the project’s people. ' +
        '`#general` lists every project member (`implicit: true`). Names are display names, never emails.',
      ...auth,
      request: { params: spaceParams },
      responses: { 200: json(SpaceMemberListSchema, 'The channel’s people, the caller first'), ...errors(403, 404) },
    }),
    async (c) => {
      const channel = await loadChannel(c, { managerMay: true });
      if (channel instanceof Response) return channel;
      const { loaded, space, viewer } = channel;
      return c.json(await listSpaceMembers(space, loaded.row, viewer), 200);
    },
  );

  // POST /v1/projects/:projectId/spaces/:spaceId/members — add people in one request.
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/spaces/{spaceId}/members',
      tags: ['spaces'],
      summary: 'Add people to a channel',
      description:
        'A member of the channel, its creator or a project manager may add; anyone else gets 403 `forbidden`. ' +
        'A manager outside a private channel adds other people, never themself (403 `manager_self_add`). ' +
        'Every id must be a member of the project, else 400 `not_project_member` names them and nobody is added. ' +
        'Someone already in the channel is skipped. `#general` is 400 `default_channel`.',
      ...auth,
      request: {
        params: spaceParams,
        body: { content: { 'application/json': { schema: SpaceMembersAddInputSchema } } },
      },
      responses: { 200: json(SpaceMemberListSchema, 'The channel’s people after the add'), ...errors(400, 403, 404) },
    }),
    async (c) => {
      if (callerKortixSessionId(c) !== null) return c.json(SESSION_BOUND_CALLER, 403);
      const channel = await loadChannel(c, { managerMay: true });
      if (channel instanceof Response) return channel;
      const { loaded, space, viewer } = channel;
      const result = await addSpaceMembers(space, loaded.row, viewer, c.req.valid('json').user_ids);
      if ('error' in result) return c.json(result.error.body, result.error.status);
      // A private channel's new members get its folder grant.
      if (space.visibility === 'private') await afterPrivateChannelChange(loaded.row.projectId, { enforce: false });
      return c.json(result.list, 200);
    },
  );

  // DELETE /v1/projects/:projectId/spaces/:spaceId/members/:userId — remove someone, or leave (the caller's own id).
  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{projectId}/spaces/{spaceId}/members/{userId}',
      tags: ['spaces'],
      summary: 'Remove a person from a channel, or leave it',
      description:
        'A project manager removes anyone. The channel’s creator removes anyone but themself. A member removes only ' +
        'themself (Leave; `me` names the caller). The creator is removed only by a manager (403 `creator_not_removable`); other refusals are ' +
        '403 `forbidden`. `#general` is 400 `default_channel`.',
      ...auth,
      request: { params: spaceParams.extend({ userId: z.string() }) },
      responses: { 200: json(SpaceMemberListSchema, 'The channel’s people after the removal'), ...errors(400, 403, 404) },
    }),
    async (c) => {
      if (callerKortixSessionId(c) !== null) return c.json(SESSION_BOUND_CALLER, 403);
      const channel = await loadChannel(c, { managerMay: true });
      if (channel instanceof Response) return channel;
      const { loaded, space, viewer } = channel;
      // `me`: the caller (Leave), so a client needs no user id of its own.
      const param = c.req.param('userId');
      const userId = param === 'me' ? loaded.userId : param;
      if (!isUuid(userId)) return c.json({ error: 'Member not found', code: 'member_not_found' }, 404);
      const result = await removeSpaceMember(space, loaded.row, viewer, userId);
      if ('error' in result) return c.json(result.error.body, result.error.status);
      // Leaving a private channel ends its folder grant and any mount of it.
      if (space.visibility === 'private') await afterPrivateChannelChange(loaded.row.projectId, { enforce: true });
      return c.json(result.list, 200);
    },
  );

  // POST /v1/projects/:projectId/spaces/:spaceId/join — the caller joins a public channel (a private one is 404).
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/spaces/{spaceId}/join',
      tags: ['spaces'],
      summary: 'Join a channel',
      description: 'Any member of the project joins a public channel; a private channel they are not in is 404 `space_not_found`. Idempotent. `#general` is 400 `default_channel`.',
      ...auth,
      request: { params: spaceParams },
      responses: { 200: json(SpaceMemberListSchema, 'The channel’s people, the caller among them'), ...errors(400, 403, 404) },
    }),
    async (c) => {
      if (callerKortixSessionId(c) !== null) return c.json(SESSION_BOUND_CALLER, 403);
      const channel = await loadChannel(c);
      if (channel instanceof Response) return channel;
      const { loaded, space, viewer } = channel;
      const result = await joinSpace(space, loaded.row, viewer);
      if ('error' in result) return c.json(result.error.body, result.error.status);
      return c.json(result.list, 200);
    },
  );
}

/** The caller's Channels onboarding: the intro and the `#general` "Get started" rows. */
function registerChannelsOnboardingRoutes(): void {
  // GET /v1/projects/:projectId/onboarding/channels — the caller's intro and "Get started" state.
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/onboarding/channels',
      tags: ['spaces'],
      summary: 'Read the caller’s Channels onboarding state',
      description:
        'A "Get started" row is done when its mark is present or its fact is true: the caller created a channel, ' +
        'saved memory in `#general`, or owns a direct message. ' +
        '`visible` is false once dismissed or all three are done.',
      ...auth,
      request: { params: projectParams },
      responses: { 200: json(ChannelsOnboardingSchema, 'The caller’s onboarding state'), ...errors(403, 404) },
    }),
    async (c) => {
      const loaded = await loadSpacesProject(c);
      if (loaded instanceof Response) return loaded;
      return c.json(await channelsOnboarding(loaded.row.projectId, loaded.userId), 200);
    },
  );

  // POST /v1/projects/:projectId/onboarding/channels/marks — record one mark for the caller. Idempotent.
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/onboarding/channels/marks',
      tags: ['spaces'],
      summary: 'Record a Channels onboarding mark for the caller',
      ...auth,
      request: {
        params: projectParams,
        body: { content: { 'application/json': { schema: ChannelsOnboardingMarkInputSchema } } },
      },
      responses: { 204: { description: 'Recorded (also when it was already there)' }, ...errors(400, 403, 404) },
    }),
    async (c) => {
      const loaded = await loadSpacesProject(c);
      if (loaded instanceof Response) return loaded;
      await addChannelsMark(loaded.row.projectId, loaded.userId, c.req.valid('json').mark);
      return c.body(null, 204);
    },
  );
}
