/**
 * Project spaces — channels (product word "Channel") and a member's DMs with an
 * agent, behind the `project_channels` flag. Spec: tests/spec/end-to-end.md
 * § 7a. Source of truth: apps/api/src/projects/routes/project-spaces.ts +
 * projects/lib/project-spaces.ts + feature-flags/toggle-effects.ts.
 */
import { randomUUID } from 'node:crypto';
import {
  SpaceLinkListSchema,
  SpaceLinkPinResultSchema,
  SpaceLinkSchema,
  SpaceListSchema,
  SpaceMemberListSchema,
  SpaceSchema,
} from '@kortix/api-contract';
import { flow } from '../core/flow';
import { waitFor } from '../core/poll';
import type { FlowContext, FlowMeta } from '../core/types';
import { AgentPrincipalsWorld } from '../fixtures/agent-principals';

const ROUTES = {
  list: 'GET /v1/projects/:projectId/spaces',
  create: 'POST /v1/projects/:projectId/spaces',
  update: 'PATCH /v1/projects/:projectId/spaces/:spaceId',
  dm: 'POST /v1/projects/:projectId/spaces/dm',
};
const TAB_ROUTES = {
  apps: 'GET /v1/projects/:projectId/spaces/:spaceId/apps',
  links: 'GET /v1/projects/:projectId/spaces/:spaceId/links',
  addLink: 'POST /v1/projects/:projectId/spaces/:spaceId/links',
  removeLink: 'DELETE /v1/projects/:projectId/spaces/:spaceId/links/:linkId',
  pinLink: 'PATCH /v1/projects/:projectId/spaces/:spaceId/links/:linkId',
};
const SPACE_APPS = '/v1/projects/:projectId/spaces/:spaceId/apps';
const SPACE_LINKS = '/v1/projects/:projectId/spaces/:spaceId/links';
const SPACE_LINK = '/v1/projects/:projectId/spaces/:spaceId/links/:linkId';
const FEATURES_ROUTE = 'PATCH /v1/projects/:projectId/features';
const SESSION_ROUTES = {
  create: 'POST /v1/projects/:projectId/sessions',
  list: 'GET /v1/projects/:projectId/sessions',
};
const SESSIONS = '/v1/projects/:projectId/sessions';
const SPACES = '/v1/projects/:projectId/spaces';
const SPACE = '/v1/projects/:projectId/spaces/:spaceId';
const DM = '/v1/projects/:projectId/spaces/dm';
const MANIFEST =
  'kortix_version: 2\nproject:\n  name: ke2e-spaces\ndefault_agent: kortix\nagents:\n  kortix:\n    kortix_permissions: all\n';

type Space = { space_id: string; kind: string; slug: string | null; name: string; is_default: boolean; archived_at: string | null; can_edit: boolean };
type Session = {
  session_id: string;
  space_id: string | null;
  visibility: string;
  first_prompt: string | null;
  reply_count?: number | null;
};

async function openWorld(ctx: FlowContext, opts: { manifest?: boolean } = {}) {
  const team = await ctx.fixtures.team();
  const project = await team.project({ managedGit: true });
  const world = await AgentPrincipalsWorld.open(ctx, { accountId: team.id, projectId: project.id });
  if (opts.manifest) await world.writeManifest(MANIFEST, 'ke2e: spaces agent');
  return { team, project, world };
}

const meta = (routes: string[]): FlowMeta => ({ domain: 'spaces', requires: ['database'], timeoutMs: 120_000, routes });

flow('SPACE-1', meta(Object.values(ROUTES)), async (ctx) => {
  const { project, world } = await openWorld(ctx);
  const params = { projectId: project.id };
  try {
    await ctx.step('with project_channels off (the default), every spaces route → 403 feature_disabled', async () => {
      for (const r of [
        await world.owner.get(SPACES, { params }),
        await world.owner.post(SPACES, { name: 'Launch Week' }, { params }),
        await world.owner.patch(SPACE, { name: 'x' }, { params: { ...params, spaceId: randomUUID() } }),
        await world.owner.post(DM, { agent_name: 'kortix' }, { params }),
      ]) {
        r.status(403).body().has('$.code', 'feature_disabled').has('$.feature', 'project_channels');
      }
    });

    await ctx.step('the refused reads created nothing: the project has no space row', async () => {
      const { rows } = await world.db.query('SELECT 1 FROM kortix.project_spaces WHERE project_id = $1', [project.id]);
      if (rows.length !== 0) throw new Error(`expected no spaces, found ${rows.length}`);
    });

    await ctx.step('an anonymous caller → 401', async () => {
      (await ctx.client.as(ctx.P.ANON).get(SPACES, { params })).status(401);
    });
  } finally {
    await world.close();
  }
});

flow('SPACE-2', meta([ROUTES.list, FEATURES_ROUTE]), async (ctx) => {
  const { project, world } = await openWorld(ctx);
  const params = { projectId: project.id };
  const sessionId = randomUUID();
  try {
    await ctx.step('a session exists before the flag is turned on, in no space', async () => {
      world.sessions.push(sessionId);
      await world.db.query(
        `INSERT INTO kortix.project_sessions
           (session_id, account_id, project_id, branch_name, agent_name, status, created_by, visibility, metadata)
         VALUES ($1, $2, $3, $1, 'kortix', 'stopped', $4, 'private', '{}'::jsonb)`,
        [sessionId, world.accountId, project.id, world.ownerUserId],
      );
    });

    let generalId = '';
    await ctx.step('turn project_channels on, then two concurrent GET /spaces → both list exactly #general (is_default) with the same space_id', async () => {
      await world.setFeature('project_channels', true);
      const [a, b] = await Promise.all([world.owner.get(SPACES, { params }), world.owner.get(SPACES, { params })]);
      for (const r of [a, b]) {
        r.status(200).body().schema(SpaceListSchema)
          .has('$.spaces.length', 1)
          .has('$.spaces[0].kind', 'channel')
          .has('$.spaces[0].slug', 'general')
          .has('$.spaces[0].name', 'general')
          .has('$.spaces[0].is_default', true)
          .has('$.spaces[0].archived_at', null);
      }
      generalId = a.json<{ spaces: Space[] }>().spaces[0]!.space_id;
      if (b.json<{ spaces: Space[] }>().spaces[0]!.space_id !== generalId) throw new Error('two reads returned two #general rows');
    });

    await ctx.step('a third GET returns the same #general', async () => {
      (await world.owner.get(SPACES, { params })).status(200).body().has('$.spaces[0].space_id', generalId);
    });

    await ctx.step('the toggle filed the earlier session into #general (within 15 s)', async () => {
      const deadline = Date.now() + 15_000;
      let spaceId: string | null = null;
      while (Date.now() < deadline) {
        const { rows } = await world.db.query<{ space_id: string | null }>(
          'SELECT space_id FROM kortix.project_sessions WHERE session_id = $1',
          [sessionId],
        );
        spaceId = rows[0]?.space_id ?? null;
        if (spaceId) break;
        await Bun.sleep(250);
      }
      if (spaceId !== generalId) throw new Error(`session space_id is ${spaceId}, expected #general ${generalId}`);
    });

    await ctx.step('turning the flag off deletes nothing: #general and the session link stay, the route → 403', async () => {
      await world.setFeature('project_channels', false);
      (await world.owner.get(SPACES, { params })).status(403).body().has('$.code', 'feature_disabled');
      const { rows } = await world.db.query<{ space_id: string | null }>(
        'SELECT s.space_id FROM kortix.project_sessions s JOIN kortix.project_spaces p ON p.space_id = s.space_id WHERE s.session_id = $1',
        [sessionId],
      );
      if (rows[0]?.space_id !== generalId) throw new Error('flag off removed #general or the session link');
    });
  } finally {
    await world.close();
  }
});

flow('SPACE-3', meta([ROUTES.list, ROUTES.create, ROUTES.update, FEATURES_ROUTE]), async (ctx) => {
  const { team, project, world } = await openWorld(ctx);
  const params = { projectId: project.id };
  try {
    await world.setFeature('project_channels', true);
    let launchId = '';
    let generalId = '';

    await ctx.step('create "Launch Week" → 201 channel with slug launch-week', async () => {
      const r = await world.owner.post(SPACES, { name: 'Launch Week', description: 'Ship it' }, { params });
      r.status(201).body().schema(SpaceSchema)
        .has('$.kind', 'channel').has('$.slug', 'launch-week').has('$.name', 'Launch Week')
        .has('$.description', 'Ship it').has('$.is_default', false).has('$.dm_agent_name', null);
      launchId = r.json<Space>().space_id;
    });

    await ctx.step('GET /spaces lists #general first, then launch-week', async () => {
      const r = await world.owner.get(SPACES, { params });
      r.status(200).body().has('$.spaces.length', 2).has('$.spaces[0].slug', 'general').has('$.spaces[1].space_id', launchId);
      generalId = r.json<{ spaces: Space[] }>().spaces[0]!.space_id;
    });

    await ctx.step('create "launch   WEEK!" again → 409 slug_taken naming the live channel', async () => {
      (await world.owner.post(SPACES, { name: 'launch   WEEK!' }, { params }))
        .status(409).body().has('$.code', 'slug_taken').has('$.space_id', launchId).has('$.archived', false);
    });

    await ctx.step('bad input → 400: a name with no letter or digit, an unknown field, a blank name', async () => {
      (await world.owner.post(SPACES, { name: '!!!' }, { params })).status(400).body().has('$.code', 'invalid_name');
      (await world.owner.post(SPACES, { name: 'ok', is_default: true }, { params })).status(400);
      (await world.owner.post(SPACES, { name: '   ' }, { params })).status(400);
    });

    await ctx.step('rename to "Growth" → 200 slug growth; renaming onto #general → 409', async () => {
      (await world.owner.patch(SPACE, { name: 'Growth' }, { params: { ...params, spaceId: launchId } }))
        .status(200).body().schema(SpaceSchema).has('$.slug', 'growth').has('$.name', 'Growth');
      (await world.owner.patch(SPACE, { name: 'General' }, { params: { ...params, spaceId: launchId } }))
        .status(409).body().has('$.code', 'slug_taken').has('$.space_id', generalId);
    });

    await ctx.step('archive growth → archived_at set, and GET /spaces no longer lists it', async () => {
      const r = await world.owner.patch(SPACE, { archived: true }, { params: { ...params, spaceId: launchId } });
      r.status(200);
      if (!r.json<Space>().archived_at) throw new Error('archived_at is not set');
      const listed = (await world.owner.get(SPACES, { params })).json<{ spaces: Space[] }>().spaces;
      if (listed.some((s) => s.space_id === launchId)) throw new Error('an archived channel is still listed');
    });

    await ctx.step('create "Growth" while it is archived → 409 slug_taken with archived: true, its space_id, and can_edit true for a manager', async () => {
      (await world.owner.post(SPACES, { name: 'Growth' }, { params }))
        .status(409).body().has('$.code', 'slug_taken').has('$.space_id', launchId).has('$.archived', true).has('$.can_edit', true);
    });

    await ctx.step('unarchive (archived: false) → archived_at null and listed again', async () => {
      (await world.owner.patch(SPACE, { archived: false }, { params: { ...params, spaceId: launchId } }))
        .status(200).body().has('$.archived_at', null);
      (await world.owner.get(SPACES, { params })).status(200).body().has('$.spaces[1].space_id', launchId);
    });

    await ctx.step('archive #general → 400 default_channel; an unknown or malformed space id → 404', async () => {
      (await world.owner.patch(SPACE, { archived: true }, { params: { ...params, spaceId: generalId } }))
        .status(400).body().has('$.code', 'default_channel');
      (await world.owner.patch(SPACE, { name: 'x' }, { params: { ...params, spaceId: randomUUID() } })).status(404);
      (await world.owner.patch(SPACE, { name: 'x' }, { params: { ...params, spaceId: 'not-a-uuid' } })).status(404);
    });

    await ctx.step('a channel is edited by its creator or a project manager: a plain member gets can_edit false and 403 forbidden on another member’s channel, and edits their own; a taken archived slug’s 409 says can_edit false', async () => {
      const ownerList = (await world.owner.get(SPACES, { params })).status(200).json<{ spaces: Space[] }>().spaces;
      if (!ownerList.every((s) => s.can_edit === true)) throw new Error('a project manager cannot edit every channel');
      const member = await team.addMember('member');
      await team.grantProjectRole(project.id, member.userId!, 'member');
      const client = ctx.client.as(member);
      const listed = (await client.get(SPACES, { params })).status(200).json<{ spaces: Space[] }>().spaces;
      if (listed.find((s) => s.space_id === launchId)?.can_edit !== false) throw new Error('a member may edit another member’s channel');
      if (listed.find((s) => s.space_id === generalId)?.can_edit !== false) throw new Error('a member may edit #general');
      (await client.patch(SPACE, { name: 'Taken Over' }, { params: { ...params, spaceId: launchId } }))
        .status(403).body().has('$.code', 'forbidden');
      (await client.patch(SPACE, { archived: true }, { params: { ...params, spaceId: launchId } }))
        .status(403).body().has('$.code', 'forbidden');
      const own = (await client.post(SPACES, { name: 'Mine' }, { params })).status(201);
      own.body().has('$.can_edit', true);
      (await client.patch(SPACE, { description: 'Edited by its creator' }, { params: { ...params, spaceId: own.json<Space>().space_id } }))
        .status(200).body().has('$.can_edit', true).has('$.description', 'Edited by its creator');
      (await world.owner.patch(SPACE, { archived: true }, { params: { ...params, spaceId: launchId } })).status(200);
      (await client.post(SPACES, { name: 'Growth' }, { params }))
        .status(409).body().has('$.code', 'slug_taken').has('$.archived', true).has('$.can_edit', false);
    });
  } finally {
    await world.close();
  }
});

flow('SPACE-4', meta([ROUTES.list, ROUTES.dm, ROUTES.update, FEATURES_ROUTE]), async (ctx) => {
  const { team, project, world } = await openWorld(ctx, { manifest: true });
  const params = { projectId: project.id };
  try {
    await world.setFeature('project_channels', true);
    let dmId = '';

    await ctx.step('POST /spaces/dm {agent_name: kortix} twice → 200, the same DM space_id', async () => {
      const first = await world.owner.post(DM, { agent_name: 'kortix' }, { params });
      first.status(200).body().schema(SpaceSchema)
        .has('$.kind', 'dm').has('$.dm_agent_name', 'kortix').has('$.name', 'kortix').has('$.slug', null);
      dmId = first.json<Space>().space_id;
      (await world.owner.post(DM, { agent_name: 'kortix' }, { params })).status(200).body().has('$.space_id', dmId);
    });

    await ctx.step('the owner lists #general, then the DM', async () => {
      (await world.owner.get(SPACES, { params }))
        .status(200).body().has('$.spaces.length', 2).has('$.spaces[0].slug', 'general').has('$.spaces[1].space_id', dmId);
    });

    let memberDmId = '';
    await ctx.step('another project member lists #general but not the owner’s DM; their own DM is a different space', async () => {
      const member = await team.addMember('member');
      await team.grantProjectRole(project.id, member.userId!, 'member');
      await world.grantRun('kortix', member);
      const client = ctx.client.as(member);
      const listed = (await client.get(SPACES, { params })).status(200).json<{ spaces: Space[] }>().spaces;
      if (listed.some((s) => s.space_id === dmId)) throw new Error('a member sees another member’s DM');
      if (!listed.some((s) => s.slug === 'general')) throw new Error('a member does not see #general');
      const own = await client.post(DM, { agent_name: 'kortix' }, { params });
      own.status(200);
      memberDmId = own.json<Space>().space_id;
      if (memberDmId === dmId) throw new Error('two members share one DM');
    });

    await ctx.step('an agent the manifest does not declare → 404 agent_not_found', async () => {
      (await world.owner.post(DM, { agent_name: 'no-such-agent' }, { params }))
        .status(404).body().has('$.code', 'agent_not_found');
    });

    await ctx.step('a DM cannot be renamed or archived → 400 dm_not_editable', async () => {
      (await world.owner.patch(SPACE, { archived: true }, { params: { ...params, spaceId: dmId } }))
        .status(400).body().has('$.code', 'dm_not_editable');
    });

    await ctx.step('PATCH on another member’s DM → 404 space_not_found, so its existence is not disclosed', async () => {
      (await world.owner.patch(SPACE, { name: 'x' }, { params: { ...params, spaceId: memberDmId } }))
        .status(404).body().has('$.code', 'space_not_found');
    });
  } finally {
    await world.close();
  }
});

/** `#general`'s id, read through the product route. */
async function generalSpaceId(world: AgentPrincipalsWorld, projectId: string): Promise<string> {
  const spaces = (await world.owner.get(SPACES, { params: { projectId } })).status(200).json<{ spaces: Space[] }>().spaces;
  const general = spaces.find((s) => s.is_default);
  if (!general) throw new Error('no #general');
  return general.space_id;
}

/** The session ids a caller lists in one space. */
async function listedInSpace(client: FlowContext['client'], projectId: string, spaceId: string): Promise<string[]> {
  const r = await client.get(`${SESSIONS}?space_id=${spaceId}`, { params: { projectId } });
  return r.status(200).json<Session[]>().map((s) => s.session_id);
}

/** Insert a session row directly: the local profile has no sandbox, so its create route answers 503. */
async function insertSession(
  world: AgentPrincipalsWorld,
  createdBy: string,
  visibility: 'private' | 'project',
  opts: { spaceId?: string; updatedAt?: Date; metadata?: Record<string, unknown>; agentName?: string } = {},
): Promise<string> {
  const sessionId = randomUUID();
  world.sessions.push(sessionId);
  await world.db.query(
    `INSERT INTO kortix.project_sessions
       (session_id, account_id, project_id, branch_name, agent_name, status, created_by, visibility, metadata, space_id, updated_at)
     VALUES ($1, $2, $3, $1, $9, 'stopped', $4, $5, $6::jsonb, $7, coalesce($8::timestamptz, now()))`,
    [
      sessionId,
      world.accountId,
      world.projectId,
      createdBy,
      visibility,
      JSON.stringify(opts.metadata ?? {}),
      opts.spaceId ?? null,
      opts.updatedAt?.toISOString() ?? null,
      opts.agentName ?? 'kortix',
    ],
  );
  return sessionId;
}

/** The space a session is filed into, read from the row. */
async function sessionSpaceId(world: AgentPrincipalsWorld, sessionId: string): Promise<string | null> {
  const { rows } = await world.db.query<{ space_id: string | null }>(
    'SELECT space_id FROM kortix.project_sessions WHERE session_id = $1',
    [sessionId],
  );
  return rows[0]?.space_id ?? null;
}

/**
 * Turn `project_channels` on and wait for its toggle effect to finish: it
 * retires warm sessions first, then files `canary` (a session in no space)
 * into `#general`. Returns `#general`'s id.
 */
async function enableChannelsAndSettle(world: AgentPrincipalsWorld, canary: string): Promise<string> {
  await world.setFeature('project_channels', true);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await sessionSpaceId(world, canary)) break;
    await Bun.sleep(250);
  }
  const generalId = await generalSpaceId(world, world.projectId);
  if ((await sessionSpaceId(world, canary)) !== generalId) throw new Error('the toggle effect did not file the canary into #general');
  return generalId;
}

// SPACE-5, -6 and -8 need a 201 from the session create route, which needs a
// sandbox provider and a reachable KORTIX_URL; the local profile answers 503.
const createMeta = (routes: string[]): FlowMeta => ({
  domain: 'spaces',
  requires: ['database', 'sandbox'],
  timeoutMs: 300_000,
  routes,
});

flow('SPACE-5', createMeta([ROUTES.create, SESSION_ROUTES.create, SESSION_ROUTES.list, FEATURES_ROUTE]), async (ctx) => {
  const { team, project, world } = await openWorld(ctx, { manifest: true });
  const params = { projectId: project.id };
  try {
    await world.setFeature('project_channels', true);
    await world.fund();
    const channelId = (await world.owner.post(SPACES, { name: 'Launch Week' }, { params })).status(201).json<Space>().space_id;
    const text = 'ke2e: plan the launch week';
    let sessionId = '';

    await ctx.step('create a session with a channel space_id → 201, space_id is the channel, visibility project, first_prompt is the prompt', async () => {
      const r = await world.owner.post(SESSIONS, { space_id: channelId, pending_prompt: { text } }, { params });
      r.status(201).body().has('$.space_id', channelId).has('$.visibility', 'project').has('$.first_prompt', text);
      sessionId = r.json<Session>().session_id;
      ctx.track('session', sessionId, { projectId: project.id });
    });

    await ctx.step('GET /sessions?space_id=<channel> lists it with first_prompt', async () => {
      const rows = (await world.owner.get(`${SESSIONS}?space_id=${channelId}`, { params })).status(200).json<Session[]>();
      const row = rows.find((s) => s.session_id === sessionId);
      if (!row) throw new Error('the session is not in its channel list');
      if (row.first_prompt !== text) throw new Error(`list first_prompt is ${row.first_prompt}`);
      // A space list counts the replies under each thread (a number, 0 before any answer).
      if (typeof row.reply_count !== 'number') throw new Error(`list reply_count is ${row.reply_count}`);
      if (rows.some((s) => s.space_id !== channelId)) throw new Error('the space filter returned a session of another space');
    });

    await ctx.step('a second project member sees it in that channel list', async () => {
      const member = await team.addMember('member');
      await team.grantProjectRole(project.id, member.userId!, 'member');
      const ids = await listedInSpace(ctx.client.as(member), project.id, channelId);
      if (!ids.includes(sessionId)) throw new Error('a member does not see a channel thread');
    });
  } finally {
    await world.close();
  }
});

flow('SPACE-6', createMeta([ROUTES.list, SESSION_ROUTES.create, FEATURES_ROUTE]), async (ctx) => {
  const { project, world } = await openWorld(ctx, { manifest: true });
  const params = { projectId: project.id };
  try {
    await world.setFeature('project_channels', true);
    await world.fund();
    await ctx.step('create without space_id (flag on) → 201 in #general, private by default, first_prompt is the initial prompt', async () => {
      const r = await world.owner.post(SESSIONS, { initial_prompt: 'ke2e: noop' }, { params });
      r.status(201);
      ctx.track('session', r.json<Session>().session_id, { projectId: project.id });
      r.body()
        .has('$.space_id', await generalSpaceId(world, project.id))
        .has('$.visibility', 'private')
        .has('$.first_prompt', 'ke2e: noop');
    });
  } finally {
    await world.close();
  }
});

flow('SPACE-7', meta([ROUTES.create, ROUTES.update, ROUTES.dm, SESSION_ROUTES.create, FEATURES_ROUTE]), async (ctx) => {
  const { team, project, world } = await openWorld(ctx, { manifest: true });
  const params = { projectId: project.id };
  try {
    await world.setFeature('project_channels', true);
    await world.fund();
    const member = await team.addMember('member');
    await team.grantProjectRole(project.id, member.userId!, 'member');
    await world.grantRun('kortix', member);
    const memberDmId = (await ctx.client.as(member).post(DM, { agent_name: 'kortix' }, { params })).status(200).json<Space>().space_id;
    const archivedId = (await world.owner.post(SPACES, { name: 'Old Channel' }, { params })).status(201).json<Space>().space_id;
    (await world.owner.patch(SPACE, { archived: true }, { params: { ...params, spaceId: archivedId } })).status(200);

    await ctx.step('create with another member’s DM, an archived channel, or an unknown space → 404 space_not_found, no session row', async () => {
      for (const spaceId of [memberDmId, archivedId, randomUUID()]) {
        (await world.owner.post(SESSIONS, { space_id: spaceId }, { params }))
          .status(404).body().has('$.code', 'space_not_found');
      }
      const { rows } = await world.db.query('SELECT 1 FROM kortix.project_sessions WHERE project_id = $1', [project.id]);
      if (rows.length !== 0) throw new Error(`a refused create stored ${rows.length} session(s)`);
    });

    await ctx.step('the caller’s own DM passes the space check and runs the DM’s agent over a different agent_name (201, or the local profile’s no-sandbox 503)', async () => {
      const ownDmId = (await world.owner.post(DM, { agent_name: 'kortix' }, { params })).status(200).json<Space>().space_id;
      // The manifest declares no such agent: without the DM override the agent gate refuses it.
      const r = await world.owner.post(SESSIONS, { space_id: ownDmId, agent_name: 'ke2e-not-the-dm-agent' }, { params });
      if (r.statusCode === 201) {
        ctx.track('session', r.json<Session>().session_id, { projectId: project.id });
        r.body().has('$.space_id', ownDmId).has('$.visibility', 'private').has('$.agent_name', 'kortix');
      } else {
        r.status(503).body().has('$.code', 'KORTIX_URL_UNREACHABLE');
      }
    });
  } finally {
    await world.close();
  }
});

flow('SPACE-8', createMeta([SESSION_ROUTES.create]), async (ctx) => {
  const { project, world } = await openWorld(ctx, { manifest: true });
  const params = { projectId: project.id };
  try {
    await world.fund();
    await ctx.step('flag off: space_id in the body is ignored → 201 with space_id null and no first_prompt', async () => {
      const r = await world.owner.post(SESSIONS, { space_id: randomUUID(), initial_prompt: 'ke2e: noop' }, { params });
      r.status(201);
      ctx.track('session', r.json<Session>().session_id, { projectId: project.id });
      r.body().has('$.space_id', null).has('$.first_prompt', null).has('$.visibility', 'private');
    });
  } finally {
    await world.close();
  }
});

flow('SPACE-9', meta([ROUTES.list, SESSION_ROUTES.list, FEATURES_ROUTE]), async (ctx) => {
  const { team, project, world } = await openWorld(ctx);
  const params = { projectId: project.id };
  try {
    const memberA = await team.addMember('member');
    await team.grantProjectRole(project.id, memberA.userId!, 'member');
    const memberB = await team.addMember('member');
    await team.grantProjectRole(project.id, memberB.userId!, 'member');
    const ownerPrivate = [await insertSession(world, world.ownerUserId, 'private'), await insertSession(world, world.ownerUserId, 'private')];
    const aPrivate = await insertSession(world, memberA.userId!, 'private');
    const aShared = await insertSession(world, memberA.userId!, 'project');
    let before = 0;

    await ctx.step('flag off: 4 sessions in no space, and ?space_id= is ignored (the owner’s normal list)', async () => {
      const { rows } = await world.db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM kortix.project_sessions WHERE project_id = $1 AND space_id IS NULL',
        [project.id],
      );
      before = rows[0]!.n;
      if (before !== 4) throw new Error(`expected 4 unassigned sessions, found ${before}`);
      const ids = await listedInSpace(world.owner, project.id, randomUUID());
      for (const id of [...ownerPrivate, aShared]) if (!ids.includes(id)) throw new Error('flag off: the space filter was applied');
    });

    await ctx.step('flag off: a space_id that is not a UUID is ignored too → 200, the owner’s normal list', async () => {
      const ids = (await world.owner.get(`${SESSIONS}?space_id=not-a-uuid`, { params })).status(200).json<Session[]>().map((s) => s.session_id);
      for (const id of [...ownerPrivate, aShared]) if (!ids.includes(id)) throw new Error('flag off: a non-UUID space filter changed the list');
    });

    let generalId = '';
    await ctx.step('turn the flag on → every one of them lands in #general (count before = count in #general after)', async () => {
      await world.setFeature('project_channels', true);
      generalId = await generalSpaceId(world, project.id);
      const deadline = Date.now() + 15_000;
      let after = 0;
      while (Date.now() < deadline) {
        const { rows } = await world.db.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM kortix.project_sessions WHERE project_id = $1 AND space_id = $2',
          [project.id, generalId],
        );
        after = rows[0]!.n;
        if (after === before) break;
        await Bun.sleep(250);
      }
      if (after !== before) throw new Error(`#general holds ${after} sessions, expected ${before}`);
    });

    await ctx.step('?space_id=<general> keeps the visibility rules: a private session stays its owner’s alone', async () => {
      const sorted = (ids: string[]) => [...ids].sort().join(',');
      const owner = await listedInSpace(world.owner, project.id, generalId);
      if (sorted(owner) !== sorted([...ownerPrivate, aShared])) throw new Error(`owner lists ${owner.join(',')}`);
      const a = await listedInSpace(ctx.client.as(memberA), project.id, generalId);
      if (sorted(a) !== sorted([aPrivate, aShared])) throw new Error(`member A lists ${a.join(',')}`);
      const b = await listedInSpace(ctx.client.as(memberB), project.id, generalId);
      if (b.includes(aPrivate)) throw new Error('member B sees member A’s private session in #general');
      if (sorted(b) !== sorted([aShared])) throw new Error(`member B lists ${b.join(',')}`);
    });

    await ctx.step('flag on: a space_id that is not a UUID → 400', async () => {
      (await world.owner.get(`${SESSIONS}?space_id=not-a-uuid`, { params })).status(400);
    });

    await ctx.step('another space lists none of them', async () => {
      const other = (await world.owner.post(SPACES, { name: 'Elsewhere' }, { params })).status(201).json<Space>().space_id;
      const ids = await listedInSpace(world.owner, project.id, other);
      if (ids.length !== 0) throw new Error(`an empty channel lists ${ids.length} session(s)`);
    });
  } finally {
    await world.close();
  }
});

flow('SPACE-10', meta([ROUTES.list, ROUTES.create, SESSION_ROUTES.list, FEATURES_ROUTE]), async (ctx) => {
  const { team, project, world } = await openWorld(ctx);
  const params = { projectId: project.id };
  try {
    await world.setFeature('project_channels', true);
    const generalId = await generalSpaceId(world, project.id);
    const channelId = (await world.owner.post(SPACES, { name: 'Paging' }, { params })).status(201).json<Space>().space_id;
    // 5 threads in the channel and 5 in #general, interleaved in time, so every
    // page boundary of the channel list has a #general row next to it.
    const now = Date.now();
    const inChannel: string[] = [];
    for (let i = 0; i < 10; i++) {
      const spaceId = i % 2 === 0 ? channelId : generalId;
      const id = await insertSession(world, world.ownerUserId, 'project', { spaceId, updatedAt: new Date(now - i * 1_000) });
      if (spaceId === channelId) inChannel.push(id);
    }

    await ctx.step('walking ?space_id=<channel>&limit=2 by X-Next-Cursor returns the 5 channel threads once each, newest first, and nothing else', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const query: string = `space_id=${channelId}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const r = await world.owner.get(`${SESSIONS}?${query}`, { params });
        const rows = r.status(200).json<Session[]>();
        for (const row of rows) {
          if (row.space_id !== channelId) throw new Error(`page ${page} returned a session of space ${row.space_id}`);
          seen.push(row.session_id);
        }
        cursor = r.header('x-next-cursor') ?? null;
        if (!cursor) break;
      }
      if (cursor) throw new Error('the cursor never ran out');
      if (seen.join(',') !== inChannel.join(',')) throw new Error(`walked ${seen.join(',')}, expected ${inChannel.join(',')}`);
    });

    await ctx.step('the Threads tab filters narrow the channel: q matches a first prompt, created_by a person, agent a slug, updated_after the activity; bad values → 400', async () => {
      const member = await team.addMember('member');
      await team.grantProjectRole(project.id, member.userId!, 'member');
      const tag = randomUUID().slice(0, 8);
      const byMember = await insertSession(world, member.userId!, 'project', {
        spaceId: channelId,
        agentName: 'researcher',
        metadata: { first_prompt: `Compare the lease offers ${tag}` },
        updatedAt: new Date(now - 3 * 86_400_000),
      });
      const recent = await insertSession(world, world.ownerUserId, 'project', { spaceId: channelId, updatedAt: new Date() });
      const listIn = async (filter: string) => {
        const r = await world.owner.get(`${SESSIONS}?space_id=${channelId}&parent=root&${filter}`, { params });
        return r.status(200).json<Session[]>().map((row) => row.session_id);
      };
      const only = (got: string[], want: string[], what: string) => {
        if (got.join(',') !== want.join(',')) throw new Error(`${what}: listed ${got.join(',')}, expected ${want.join(',')}`);
      };
      only(await listIn(`q=${encodeURIComponent(`lease offers ${tag}`)}`), [byMember], 'q on the first prompt');
      only(await listIn(`created_by=${member.userId}`), [byMember], 'created_by the member');
      if ((await listIn(`created_by=${world.ownerUserId}`)).includes(byMember)) throw new Error('created_by the owner listed the member’s thread');
      only(await listIn('agent=researcher'), [byMember], 'agent=researcher');
      const since = new Date(now - 60_000).toISOString();
      only(await listIn(`updated_after=${encodeURIComponent(since)}`), [recent, ...inChannel], 'updated_after one minute ago');
      for (const bad of ['created_by=not-a-uuid', 'updated_after=yesterday']) {
        (await world.owner.get(`${SESSIONS}?space_id=${channelId}&${bad}`, { params })).status(400);
      }
    });
  } finally {
    await world.close();
  }
});

const WARM_CLAIM_ROUTE = 'POST /v1/projects/:projectId/sessions/warm/claim';
const WARM_CLAIM = '/v1/projects/:projectId/sessions/warm/claim';

flow('SPACE-11', meta([WARM_CLAIM_ROUTE, ROUTES.list, SESSION_ROUTES.list, FEATURES_ROUTE]), async (ctx) => {
  const { project, world } = await openWorld(ctx, { manifest: true });
  const params = { projectId: project.id };
  /** An unclaimed warm session with a placed sandbox, as the warm pool leaves it. */
  const warmSession = async (): Promise<string> => {
    const sessionId = await insertSession(world, world.ownerUserId, 'private', { metadata: { warm: true } });
    await world.db.query(`UPDATE kortix.project_sessions SET status = 'running' WHERE session_id = $1`, [sessionId]);
    await world.db.query(
      `INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, provider, status, config, metadata)
       VALUES ($1::uuid, $1, $2::uuid, $3::uuid, 'platinum', 'provisioning', '{}'::jsonb, '{"platinumRegion":"eu-west"}'::jsonb)`,
      [sessionId, world.accountId, world.projectId],
    );
    return sessionId;
  };
  try {
    await world.fund();
    await world.setFeature('warm_sessions', true);

    await ctx.step('flag off: a claimed warm session stays in no space and stores no first_prompt', async () => {
      const sessionId = await warmSession();
      const r = await world.owner.post(WARM_CLAIM, { session_id: sessionId, pending_prompt: { text: 'ke2e: flag off' } }, { params });
      r.status(200).body().has('$.space_id', null).has('$.first_prompt', null);
      if ((await sessionSpaceId(world, sessionId)) !== null) throw new Error('flag off: the claim filed the session');
    });

    const canary = await insertSession(world, world.ownerUserId, 'private');
    const generalId = await enableChannelsAndSettle(world, canary);

    await ctx.step('flag on: a claimed warm session becomes a #general thread whose first_prompt is the claimed prompt', async () => {
      const sessionId = await warmSession();
      const text = 'ke2e: a thread from the mobile composer';
      const r = await world.owner.post(WARM_CLAIM, { session_id: sessionId, pending_prompt: { text } }, { params });
      r.status(200).body().has('$.space_id', generalId).has('$.first_prompt', text);
      if ((await sessionSpaceId(world, sessionId)) !== generalId) throw new Error('the claimed row is not in #general');
      const ids = await listedInSpace(world.owner, project.id, generalId);
      if (!ids.includes(sessionId)) throw new Error('the claimed thread is not listed in #general');
    });
  } finally {
    await world.close();
  }
});

flow('SPACE-12', meta([ROUTES.list, FEATURES_ROUTE]), async (ctx) => {
  const { project, world } = await openWorld(ctx);
  try {
    const canary = await insertSession(world, world.ownerUserId, 'private');
    const firstGeneral = await enableChannelsAndSettle(world, canary);

    // A toggle effect that failed before it created #general: no #general, sessions in no space.
    await world.db.query('DELETE FROM kortix.project_spaces WHERE space_id = $1', [firstGeneral]);
    const orphan = await insertSession(world, world.ownerUserId, 'project');
    let general = '';

    await ctx.step('the GET /spaces that creates #general files every session in no space into it', async () => {
      if ((await sessionSpaceId(world, canary)) !== null) throw new Error('deleting #general did not clear the canary space');
      general = await generalSpaceId(world, project.id);
      if (general === firstGeneral) throw new Error('#general was not recreated');
      for (const id of [canary, orphan]) {
        const spaceId = await sessionSpaceId(world, id);
        if (spaceId !== general) throw new Error(`session ${id} is in ${spaceId}, expected the new #general`);
      }
    });
  } finally {
    await world.close();
  }
});

/** A stored, journaled session log with a root thread: what a fork copies. */
async function seedSessionLog(world: AgentPrincipalsWorld, sessionId: string): Promise<void> {
  await world.db.query(
    `INSERT INTO kortix.session_logs (session_id, project_id, account_id, v, harness_current, restore_grade, record, journal_seen_at)
     VALUES ($1, $2, $3, 1, 'pi', 'full', '{}'::jsonb, now())`,
    [sessionId, world.projectId, world.accountId],
  );
  await world.db.query(
    `INSERT INTO kortix.session_log_threads (session_id, thread_id, parent_thread_id, v, record) VALUES ($1, 'root', NULL, 1, '{}'::jsonb)`,
    [sessionId],
  );
}

flow('SPACE-13', createMeta([ROUTES.list, SESSION_ROUTES.create, SESSION_ROUTES.list, 'GET /v1/projects/:projectId/sessions/:sessionId', FEATURES_ROUTE]), async (ctx) => {
  const { team, project, world } = await openWorld(ctx, { manifest: true });
  const params = { projectId: project.id };
  try {
    await world.setFeature('project_channels', true);
    await world.fund();
    const general = await generalSpaceId(world, project.id);
    const member = await team.addMember('member');
    await team.grantProjectRole(project.id, member.userId!, 'member');
    const fork = async (sourceId: string) => {
      const r = await world.owner.post(SESSIONS, { fork_from_session_id: sourceId }, { params });
      r.status(201);
      const forked = r.json<Session>();
      world.sessions.push(forked.session_id);
      return forked;
    };

    await ctx.step('a fork of a private #general session is private and in #general; another member cannot read it', async () => {
      const source = await insertSession(world, world.ownerUserId, 'private', { spaceId: general });
      await seedSessionLog(world, source);
      const forked = await fork(source);
      if (forked.space_id !== general) throw new Error(`the fork is in ${forked.space_id}, expected #general`);
      if (forked.visibility !== 'private') throw new Error(`the fork is ${forked.visibility}, expected private`);
      const asMember = ctx.client.as(member);
      (await asMember.get(`${SESSIONS}/:sessionId`, { params: { ...params, sessionId: forked.session_id } })).status(404);
      if ((await listedInSpace(asMember, project.id, general)).includes(forked.session_id)) {
        throw new Error('another member lists the private fork in #general');
      }
    });

    await ctx.step('a fork of a project-visible channel thread is project-visible in that channel', async () => {
      const channel = (await world.owner.post(SPACES, { name: 'Forks' }, { params })).status(201).json<Space>().space_id;
      const source = await insertSession(world, world.ownerUserId, 'project', { spaceId: channel });
      await seedSessionLog(world, source);
      const forked = await fork(source);
      if (forked.space_id !== channel || forked.visibility !== 'project') {
        throw new Error(`the fork is ${forked.visibility} in ${forked.space_id}, expected project in the channel`);
      }
    });

    await ctx.step('a fork of a private session that names a channel lands there private; another member cannot read it', async () => {
      const channel = (await world.owner.post(SPACES, { name: 'Fork target' }, { params })).status(201).json<Space>().space_id;
      const source = await insertSession(world, world.ownerUserId, 'private', { spaceId: general });
      await seedSessionLog(world, source);
      const r = await world.owner.post(SESSIONS, { fork_from_session_id: source, space_id: channel }, { params });
      r.status(201);
      const forked = r.json<Session>();
      world.sessions.push(forked.session_id);
      if (forked.space_id !== channel || forked.visibility !== 'private') {
        throw new Error(`the fork is ${forked.visibility} in ${forked.space_id}, expected private in the channel`);
      }
      (await ctx.client.as(member).get(`${SESSIONS}/:sessionId`, { params: { ...params, sessionId: forked.session_id } })).status(404);
    });
  } finally {
    await world.close();
  }
});

flow('SPACE-14', meta([...Object.values(TAB_ROUTES), FEATURES_ROUTE]), async (ctx) => {
  const { project, world } = await openWorld(ctx);
  const params = { projectId: project.id, spaceId: randomUUID() };
  try {
    await ctx.step('with project_channels off, the apps, links and pin routes → 403 feature_disabled', async () => {
      for (const r of [
        await world.owner.get(SPACE_APPS, { params }),
        await world.owner.get(SPACE_LINKS, { params }),
        await world.owner.post(SPACE_LINKS, { url: 'https://example.test' }, { params }),
        await world.owner.del(SPACE_LINK, { params: { ...params, linkId: randomUUID() } }),
        await world.owner.patch(SPACE_LINK, { pinned: true }, { params: { ...params, linkId: randomUUID() } }),
      ]) {
        r.status(403).body().has('$.code', 'feature_disabled').has('$.feature', 'project_channels');
      }
    });
  } finally {
    await world.close();
  }
});

/** One App of the project with one deployment made from `sourceSessionId`. */
async function insertAppDeployedFrom(world: AgentPrincipalsWorld, sourceSessionId: string, slug: string): Promise<string> {
  const { rows } = await world.db.query<{ app_id: string }>(
    `INSERT INTO kortix.apps (account_id, project_id, slug, name, route_key, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING app_id`,
    [world.accountId, world.projectId, slug, slug, randomUUID().replace(/-/g, '').slice(0, 20), world.ownerUserId],
  );
  const appId = rows[0]!.app_id;
  await world.db.query(
    `INSERT INTO kortix.app_deployments (app_id, version, source_kind, runtime_version, created_by, source_session_id)
     VALUES ($1, 1, 'static', 'ke2e', $2, $3)`,
    [appId, world.ownerUserId, sourceSessionId],
  );
  return appId;
}

flow('SPACE-15', meta([TAB_ROUTES.apps, ROUTES.create, ROUTES.dm, FEATURES_ROUTE]), async (ctx) => {
  const { project, world } = await openWorld(ctx, { manifest: true });
  const params = { projectId: project.id };
  try {
    await world.setFeature('project_channels', true);
    const general = await generalSpaceId(world, project.id);
    const channel = (await world.owner.post(SPACES, { name: 'Builds' }, { params })).status(201).json<Space>().space_id;
    const appIds: string[] = [];

    await ctx.step('a channel with no App deployed from its threads lists none', async () => {
      (await world.owner.get(SPACE_APPS, { params: { ...params, spaceId: channel } })).status(200).body().has('$.apps.length', 0);
    });

    await ctx.step('an App deployed from a channel thread lists in that channel only; one from #general does not', async () => {
      const inChannel = await insertAppDeployedFrom(world, await insertSession(world, world.ownerUserId, 'project', { spaceId: channel }), 'ke2e-channel-app');
      const inGeneral = await insertAppDeployedFrom(world, await insertSession(world, world.ownerUserId, 'project', { spaceId: general }), 'ke2e-general-app');
      appIds.push(inChannel, inGeneral);
      (await world.owner.get(SPACE_APPS, { params: { ...params, spaceId: channel } }))
        .status(200).body().has('$.apps.length', 1).has('$.apps[0].app_id', inChannel);
      (await world.owner.get(SPACE_APPS, { params: { ...params, spaceId: general } }))
        .status(200).body().has('$.apps.length', 1).has('$.apps[0].app_id', inGeneral);
    });

    await ctx.step('a DM, an unknown id and a malformed id → 404 space_not_found', async () => {
      const dm = (await world.owner.post(DM, { agent_name: 'kortix' }, { params })).status(200).json<Space>().space_id;
      for (const spaceId of [dm, randomUUID(), 'not-a-uuid']) {
        (await world.owner.get(SPACE_APPS, { params: { ...params, spaceId } })).status(404).body().has('$.code', 'space_not_found');
      }
    });

    await world.db.query('DELETE FROM kortix.apps WHERE app_id = ANY($1::uuid[])', [appIds]);
  } finally {
    await world.close();
  }
});

flow('SPACE-16', meta([TAB_ROUTES.links, TAB_ROUTES.addLink, TAB_ROUTES.removeLink, ROUTES.create, ROUTES.update, FEATURES_ROUTE]), async (ctx) => {
  const { team, project, world } = await openWorld(ctx);
  const params = { projectId: project.id };
  try {
    await world.setFeature('project_channels', true);
    const channel = (await world.owner.post(SPACES, { name: 'Research' }, { params })).status(201).json<Space>().space_id;
    const at = { ...params, spaceId: channel };
    const member = await team.addMember('member');
    await team.grantProjectRole(project.id, member.userId!, 'member');
    const asMember = ctx.client.as(member);
    let ownerLink = '';
    let memberLink = '';

    await ctx.step('a member adds a link → 201 unpinned, with its url, title and creator; the owner adds one without a title', async () => {
      const r = await asMember.post(SPACE_LINKS, { url: 'https://example.test/spec', title: 'Launch spec' }, { params: at });
      r.status(201).body().schema(SpaceLinkSchema)
        .has('$.url', 'https://example.test/spec').has('$.title', 'Launch spec')
        .has('$.created_by', member.userId!).has('$.can_delete', true)
        .has('$.pinned', false).has('$.pinned_at', null);
      memberLink = r.json<{ link_id: string }>().link_id;
      const o = await world.owner.post(SPACE_LINKS, { url: 'http://example.test/board' }, { params: at });
      o.status(201).body().has('$.title', null).has('$.pinned', false);
      ownerLink = o.json<{ link_id: string }>().link_id;
    });

    await ctx.step('the list is newest first; can_delete is true for the creator and for a project manager only', async () => {
      (await world.owner.get(SPACE_LINKS, { params: at })).status(200).body().schema(SpaceLinkListSchema)
        .has('$.links.length', 2).has('$.links[0].link_id', ownerLink).has('$.links[1].link_id', memberLink)
        .has('$.links[0].can_delete', true).has('$.links[1].can_delete', true);
      (await asMember.get(SPACE_LINKS, { params: at })).status(200).body()
        .has('$.links[0].link_id', ownerLink).has('$.links[0].can_delete', false).has('$.links[1].can_delete', true);
    });

    await ctx.step('bad input → 400: not http(s), not a URL, over 2,048 characters, a title over 200, an unknown field', async () => {
      for (const body of [
        { url: 'javascript:alert(1)' },
        { url: 'ftp://example.test/file' },
        { url: 'not a url' },
        { url: `https://example.test/${'a'.repeat(2048)}` },
        { url: 'https://example.test', title: 'x'.repeat(201) },
        { url: 'https://example.test', pinned: true },
      ]) {
        (await world.owner.post(SPACE_LINKS, body, { params: at })).status(400);
      }
    });

    await ctx.step('a member who did not add the link → 403 forbidden; the link stays', async () => {
      (await asMember.del(SPACE_LINK, { params: { ...at, linkId: ownerLink } })).status(403).body().has('$.code', 'forbidden');
      (await world.owner.get(SPACE_LINKS, { params: at })).status(200).body().has('$.links.length', 2);
    });

    await ctx.step('the creator removes their link → 200; a second delete → 404 link_not_found', async () => {
      (await asMember.del(SPACE_LINK, { params: { ...at, linkId: memberLink } })).status(200).body().has('$.ok', true);
      (await asMember.del(SPACE_LINK, { params: { ...at, linkId: memberLink } })).status(404).body().has('$.code', 'link_not_found');
    });

    await ctx.step('a project manager removes another member’s link → 200', async () => {
      const r = await asMember.post(SPACE_LINKS, { url: 'https://example.test/notes' }, { params: at });
      const id = r.status(201).json<{ link_id: string }>().link_id;
      (await world.owner.del(SPACE_LINK, { params: { ...at, linkId: id } })).status(200);
      (await world.owner.get(SPACE_LINKS, { params: at })).status(200).body().has('$.links.length', 1).has('$.links[0].link_id', ownerLink);
    });

    await ctx.step('the stored url is the parsed form: a space in the path is percent-encoded', async () => {
      const r = await world.owner.post(SPACE_LINKS, { url: 'https://example.test/a b' }, { params: at });
      r.status(201).body().has('$.url', 'https://example.test/a%20b');
      (await world.owner.del(SPACE_LINK, { params: { ...at, linkId: r.json<{ link_id: string }>().link_id } })).status(200);
    });

    await ctx.step('a channel holds at most 200 added links: the 201st add → 409 link_limit', async () => {
      // 199 more added rows (source defaults to manual) beside the owner's one, written directly: 199 POSTs would only slow the flow.
      await world.db.query(
        `INSERT INTO kortix.project_space_links (space_id, project_id, url, created_by)
         SELECT $1, $2, 'https://example.test/' || n, $3 FROM generate_series(1, 199) AS n`,
        [channel, project.id, world.ownerUserId],
      );
      (await asMember.post(SPACE_LINKS, { url: 'https://example.test/one-more' }, { params: at }))
        .status(409).body().has('$.code', 'link_limit');
      await world.db.query(`DELETE FROM kortix.project_space_links WHERE space_id = $1 AND link_id <> $2`, [channel, ownerLink]);
      (await asMember.post(SPACE_LINKS, { url: 'https://example.test/after' }, { params: at })).status(201);
    });

    await ctx.step('an archived channel → 404 space_not_found on list and add', async () => {
      (await world.owner.patch(SPACE, { archived: true }, { params: at })).status(200);
      (await world.owner.get(SPACE_LINKS, { params: at })).status(404).body().has('$.code', 'space_not_found');
      (await world.owner.post(SPACE_LINKS, { url: 'https://example.test' }, { params: at })).status(404);
    });
  } finally {
    await world.close();
  }
});

// ── Triggers that post to a channel or DM (Task 10) ─────────────────────────
const TRIGGER_ROUTES = {
  list: 'GET /v1/projects/:projectId/triggers',
  create: 'POST /v1/projects/:projectId/triggers',
  update: 'PATCH /v1/projects/:projectId/triggers/:slug',
  fire: 'POST /v1/projects/:projectId/triggers/:slug/fire',
};
const TRIGGERS = '/v1/projects/:projectId/triggers';
const TRIGGER = '/v1/projects/:projectId/triggers/:slug';
type ListedTrigger = { slug: string; space_id?: string | null; session_access: { mode: string; memberIds: string[] } };

/** A daily cron trigger body; `extra` adds `space_id` or `session_access`. */
const cronTrigger = (slug: string, extra: Record<string, unknown> = {}) => ({
  name: slug,
  slug,
  type: 'cron',
  cron: '0 0 9 * * *',
  timezone: 'UTC',
  agent: 'kortix',
  prompt_template: `Post the ${slug} digest`,
  ...extra,
});

async function listedTrigger(world: AgentPrincipalsWorld, slug: string): Promise<ListedTrigger> {
  const r = await world.owner.get(TRIGGERS, { params: { projectId: world.projectId } });
  const found = r.status(200).json<{ triggers: ListedTrigger[] }>().triggers.find((t) => t.slug === slug);
  if (!found) throw new Error(`trigger ${slug} is not listed`);
  return found;
}

async function storedTriggerSpace(world: AgentPrincipalsWorld, slug: string): Promise<string | null> {
  const { rows } = await world.db.query<{ space_id: string | null }>(
    'SELECT space_id FROM kortix.project_trigger_runtime WHERE project_id = $1 AND slug = $2',
    [world.projectId, slug],
  );
  return rows[0]?.space_id ?? null;
}

flow(
  'SPACE-18',
  meta([TRIGGER_ROUTES.list, TRIGGER_ROUTES.create, TRIGGER_ROUTES.update, ROUTES.create, ROUTES.update, ROUTES.dm, FEATURES_ROUTE]),
  async (ctx) => {
    const { team, project, world } = await openWorld(ctx, { manifest: true });
    const params = { projectId: project.id };
    try {
      await ctx.step('flag off: a create with space_id → 201; space_id is not stored and not listed', async () => {
        (await world.owner.post(TRIGGERS, cronTrigger('off-digest', { space_id: randomUUID() }), { params })).status(201);
        const listed = await listedTrigger(world, 'off-digest');
        if ('space_id' in listed) throw new Error(`space_id listed with the flag off: ${JSON.stringify(listed)}`);
        if ((await storedTriggerSpace(world, 'off-digest')) !== null) throw new Error('space_id stored with the flag off');
      });

      await world.setFeature('project_channels', true);
      await generalSpaceId(world, project.id); // creates #general
      const channel = (await world.owner.post(SPACES, { name: 'Ops' }, { params })).status(201).json<Space>().space_id;

      await ctx.step('a trigger posted to a channel → 201; the list names the channel; its session_access defaults to project', async () => {
        (await world.owner.post(TRIGGERS, cronTrigger('ops-digest', { space_id: channel }), { params })).status(201);
        const listed = await listedTrigger(world, 'ops-digest');
        if (listed.space_id !== channel) throw new Error(`space_id is ${listed.space_id}, expected the channel`);
        if (listed.session_access.mode !== 'project') throw new Error(`session_access is ${listed.session_access.mode}, expected project`);
        if ((await listedTrigger(world, 'off-digest')).space_id !== null) throw new Error('a trigger with no space lists a space_id');
      });

      await ctx.step('PATCH space_id null clears it: the list says null and nothing is stored', async () => {
        (await world.owner.patch(TRIGGER, { space_id: null }, { params: { ...params, slug: 'ops-digest' } })).status(200);
        if ((await listedTrigger(world, 'ops-digest')).space_id !== null) throw new Error('space_id was not cleared');
        if ((await storedTriggerSpace(world, 'ops-digest')) !== null) throw new Error('space_id is still stored');
      });

      await ctx.step('an unknown id, a malformed id and an archived channel → 404 space_not_found; a non-string → 400', async () => {
        const archived = (await world.owner.post(SPACES, { name: 'Old ops' }, { params })).status(201).json<Space>().space_id;
        (await world.owner.patch(SPACE, { archived: true }, { params: { ...params, spaceId: archived } })).status(200);
        for (const spaceId of [randomUUID(), 'not-a-uuid', archived]) {
          (await world.owner.post(TRIGGERS, cronTrigger('bad-space', { space_id: spaceId }), { params }))
            .status(404).body().has('$.code', 'space_not_found');
          (await world.owner.patch(TRIGGER, { space_id: spaceId }, { params: { ...params, slug: 'ops-digest' } }))
            .status(404).body().has('$.code', 'space_not_found');
        }
        (await world.owner.post(TRIGGERS, cronTrigger('bad-space', { space_id: 5 }), { params })).status(400);
        if ((await storedTriggerSpace(world, 'ops-digest')) !== null) throw new Error('a refused PATCH stored a space');
      });

      const dm = (await world.owner.post(DM, { agent_name: 'kortix' }, { params })).status(200).json<Space>().space_id;
      await ctx.step('a trigger posted to the caller’s own DM → 201; its runs are shared with that member only, whatever was asked', async () => {
        (await world.owner.post(TRIGGERS, cronTrigger('dm-digest', { space_id: dm, session_access: { mode: 'project' } }), { params })).status(201);
        const listed = await listedTrigger(world, 'dm-digest');
        if (listed.space_id !== dm) throw new Error(`space_id is ${listed.space_id}, expected the DM`);
        if (listed.session_access.mode !== 'members' || listed.session_access.memberIds.join() !== world.ownerUserId) {
          throw new Error(`DM session_access is ${JSON.stringify(listed.session_access)}`);
        }
        (await world.owner.patch(TRIGGER, { session_access: { mode: 'project' } }, { params: { ...params, slug: 'dm-digest' } })).status(200);
        if ((await listedTrigger(world, 'dm-digest')).session_access.mode !== 'members') throw new Error('a PATCH widened a DM trigger');
      });

      await ctx.step('another member (a manager) points a trigger at the owner’s DM → 403 space_forbidden', async () => {
        const manager = await team.addMember('member');
        await team.grantProjectRole(project.id, manager.userId!, 'manager');
        const asManager = ctx.client.as(manager);
        (await asManager.post(TRIGGERS, cronTrigger('foreign-dm', { space_id: dm }), { params }))
          .status(403).body().has('$.code', 'space_forbidden');
        (await asManager.patch(TRIGGER, { space_id: dm }, { params: { ...params, slug: 'ops-digest' } }))
          .status(403).body().has('$.code', 'space_forbidden');
        if ((await storedTriggerSpace(world, 'ops-digest')) !== null) throw new Error('a refused PATCH stored the DM');
      });

      await ctx.step('a DM trigger runs the DM’s agent: another agent → 400 agent_mismatch on create and PATCH', async () => {
        (await world.owner.post(TRIGGERS, cronTrigger('dm-other', { space_id: dm, agent: 'researcher' }), { params }))
          .status(400).body().has('$.code', 'agent_mismatch');
        (await world.owner.patch(TRIGGER, { agent: 'researcher' }, { params: { ...params, slug: 'dm-digest' } }))
          .status(400).body().has('$.code', 'agent_mismatch');
      });

      await ctx.step('a manager who is not the DM’s member: an edit → 403 space_forbidden, on/off → 200; the list hides the DM id', async () => {
        const manager = await team.addMember('member');
        await team.grantProjectRole(project.id, manager.userId!, 'manager');
        const asManager = ctx.client.as(manager);
        (await asManager.patch(TRIGGER, { prompt_template: 'Post elsewhere' }, { params: { ...params, slug: 'dm-digest' } }))
          .status(403).body().has('$.code', 'space_forbidden');
        (await asManager.patch(TRIGGER, { enabled: false }, { params: { ...params, slug: 'dm-digest' } })).status(200);
        const seen = (await asManager.get(TRIGGERS, { params })).status(200).json<{ triggers: ListedTrigger[] }>().triggers;
        if (seen.find((t) => t.slug === 'dm-digest')?.space_id !== null) throw new Error('another member sees the DM id');
        if ((await listedTrigger(world, 'dm-digest')).space_id !== dm) throw new Error('the DM member lost the DM id');
      });

      await ctx.step('flag off: a PATCH asking a DM trigger for project sharing keeps it DM-only', async () => {
        await world.setFeature('project_channels', false);
        (await world.owner.patch(TRIGGER, { session_access: { mode: 'project' } }, { params: { ...params, slug: 'dm-digest' } })).status(200);
        await world.setFeature('project_channels', true);
        const listed = await listedTrigger(world, 'dm-digest');
        if (listed.session_access.mode !== 'members') throw new Error(`flag-off PATCH stored ${listed.session_access.mode}`);
      });

      await ctx.step('a PATCH that moves the trigger to a channel without session_access makes its later threads project-visible', async () => {
        (await world.owner.patch(TRIGGER, { space_id: channel }, { params: { ...params, slug: 'off-digest' } })).status(200);
        const listed = await listedTrigger(world, 'off-digest');
        if (listed.space_id !== channel || listed.session_access.mode !== 'project') throw new Error(JSON.stringify(listed));
      });

      await ctx.step('a space change keeps earlier threads’ sharing: channel → DM hides no channel thread; DM → channel exposes no DM thread', async () => {
        const visibilityOf = async (sessionId: string) => {
          const row = await world.db.query<{ visibility: string }>('SELECT visibility FROM kortix.project_sessions WHERE session_id = $1', [sessionId]);
          const grants = await world.db.query('SELECT 1 FROM kortix.project_session_grants WHERE session_id = $1', [sessionId]);
          return `${row.rows[0]?.visibility}/${grants.rows.length}`;
        };
        const channelRun = await insertSession(world, world.ownerUserId, 'project', {
          spaceId: channel,
          metadata: { trigger_kind: 'git', trigger_slug: 'off-digest' },
        });
        (await world.owner.patch(TRIGGER, { space_id: dm }, { params: { ...params, slug: 'off-digest' } })).status(200);
        if ((await visibilityOf(channelRun)) !== 'project/0') throw new Error(`the old channel thread is ${await visibilityOf(channelRun)}`);

        const dmRun = await insertSession(world, world.ownerUserId, 'private', {
          spaceId: dm,
          metadata: { trigger_kind: 'git', trigger_slug: 'dm-digest' },
        });
        (await world.owner.patch(TRIGGER, { space_id: channel }, { params: { ...params, slug: 'dm-digest' } })).status(200);
        (await world.owner.patch(TRIGGER, { session_access: { mode: 'project' } }, { params: { ...params, slug: 'dm-digest' } })).status(200);
        if ((await visibilityOf(dmRun)) !== 'private/0') throw new Error(`the old DM thread is ${await visibilityOf(dmRun)}`);
      });
    } finally {
      await world.close();
    }
  },
);

/** The space, visibility and grants of the session a fire created. */
async function firedSession(world: AgentPrincipalsWorld, sessionId: string) {
  const { rows } = await world.db.query<{ space_id: string | null; visibility: string; metadata: Record<string, unknown> }>(
    'SELECT space_id, visibility, metadata FROM kortix.project_sessions WHERE session_id = $1',
    [sessionId],
  );
  const grants = await world.db.query<{ principal_id: string }>(
    'SELECT principal_id FROM kortix.project_session_grants WHERE session_id = $1',
    [sessionId],
  );
  return { ...rows[0]!, grants: grants.rows.map((g) => g.principal_id) };
}

// A fire creates a real session row, which needs the session create to reach
// its insert: a sandbox provider and a reachable KORTIX_URL.
flow(
  'SPACE-19',
  createMeta([TRIGGER_ROUTES.create, TRIGGER_ROUTES.fire, ROUTES.create, ROUTES.update, ROUTES.dm, FEATURES_ROUTE, 'POST /v1/projects/:projectId/secrets']),
  async (ctx) => {
    const { project, world } = await openWorld(ctx, { manifest: true });
    const params = { projectId: project.id };
    const fire = async (slug: string) => {
      const r = await world.owner.post(`${TRIGGER}/fire`, {}, { params: { ...params, slug } });
      const body = r.json<{ status: string; session_id?: string | null; error?: string }>();
      if (body.status !== 'fired' || !body.session_id) throw new Error(`fire of ${slug}: ${r.text()}`);
      world.sessions.push(body.session_id);
      return firedSession(world, body.session_id);
    };
    try {
      await world.setFeature('project_channels', true);
      await world.fund();
      // A BYOK key gives the account a usable model, so the fire passes the no-usable-model gate.
      (await world.owner.post(
        '/v1/projects/:projectId/secrets',
        { name: 'ANTHROPIC_API_KEY', value: 'sk-ant-ke2e-spaces', strategy: 'broker', consumer: 'llm_gateway' },
        { params },
      )).status(200);
      const general = await generalSpaceId(world, project.id);
      const channel = (await world.owner.post(SPACES, { name: 'Standups' }, { params })).status(201).json<Space>().space_id;
      const model = { model: 'anthropic/claude-sonnet-4-6' };
      (await world.owner.post(TRIGGERS, cronTrigger('standup', { space_id: channel, ...model }), { params })).status(201);

      await ctx.step('a manual fire lands its session in the channel: project-visible, the prompt as its top message, the trigger name stamped', async () => {
        const s = await fire('standup');
        if (s.space_id !== channel) throw new Error(`the run is in ${s.space_id}, expected the channel`);
        if (s.visibility !== 'project') throw new Error(`the run is ${s.visibility}, expected project`);
        if (s.metadata.first_prompt !== 'Post the standup digest') throw new Error(`first_prompt is ${String(s.metadata.first_prompt)}`);
        if (s.metadata.trigger_name !== 'standup') throw new Error(`trigger_name is ${String(s.metadata.trigger_name)}`);
      });

      await ctx.step('the channel archived → the next run lands in #general', async () => {
        (await world.owner.patch(SPACE, { archived: true }, { params: { ...params, spaceId: channel } })).status(200);
        const s = await fire('standup');
        if (s.space_id !== general) throw new Error(`the run is in ${s.space_id}, expected #general`);
      });

      await ctx.step('a DM trigger’s run lands in the DM, shared with the DM’s member only', async () => {
        const dm = (await world.owner.post(DM, { agent_name: 'kortix' }, { params })).status(200).json<Space>().space_id;
        (await world.owner.post(TRIGGERS, cronTrigger('dm-standup', { space_id: dm, ...model }), { params })).status(201);
        const s = await fire('dm-standup');
        if (s.space_id !== dm) throw new Error(`the run is in ${s.space_id}, expected the DM`);
        if (s.visibility !== 'restricted' || s.grants.join() !== world.ownerUserId) {
          throw new Error(`the DM run is ${s.visibility} with grants ${s.grants.join()}`);
        }
        // A stored `project` policy (a flag-off write) still gives a DM run DM-only sharing.
        await world.db.query(
          `UPDATE kortix.project_trigger_runtime SET session_access_mode = 'project' WHERE project_id = $1 AND slug = 'dm-standup'`,
          [project.id],
        );
        const again = await fire('dm-standup');
        if (again.visibility !== 'restricted' || again.grants.join() !== world.ownerUserId) {
          throw new Error(`a DM run under a stored project policy is ${again.visibility} with grants ${again.grants.join()}`);
        }
      });
    } finally {
      await world.close();
    }
  },
);

const PROMPTS = '/v1/projects/:projectId/sessions/:sessionId/prompts';
type Link = {
  link_id: string;
  url: string;
  source: string;
  pinned: boolean;
  pinned_by_name: string | null;
  session_id: string | null;
  created_by: string | null;
};

flow(
  'SPACE-20',
  meta([TAB_ROUTES.links, TAB_ROUTES.addLink, TAB_ROUTES.pinLink, ROUTES.create, ROUTES.dm, FEATURES_ROUTE, `POST ${PROMPTS}`]),
  async (ctx) => {
    const { team, project, world } = await openWorld(ctx, { manifest: true });
    const params = { projectId: project.id };
    try {
      await world.setFeature('project_channels', true);
      const channel = (await world.owner.post(SPACES, { name: 'Shared links' }, { params })).status(201).json<Space>().space_id;
      const at = { ...params, spaceId: channel };
      const thread = await insertSession(world, world.ownerUserId, 'project', { spaceId: channel });
      const secondThread = await insertSession(world, world.ownerUserId, 'project', { spaceId: channel });
      const member = await team.addMember('member');
      await team.grantProjectRole(project.id, member.userId!, 'member');
      const asMember = ctx.client.as(member);

      const prompt = async (sessionId: string, text: string) =>
        (
          await world.owner.post(
            PROMPTS,
            { client_message_id: randomUUID(), parts: [{ type: 'text', text }] },
            { params: { ...params, sessionId } },
          )
        ).status([200, 202]);
      const links = async () => (await world.owner.get(SPACE_LINKS, { params: at })).status(200).json<{ links: Link[] }>().links;
      /** Collection runs after the prompt is accepted: wait (at most 15 s) until `ready` holds. */
      const waitFor = async (ready: (rows: Link[]) => boolean): Promise<Link[]> => {
        const deadline = Date.now() + 15_000;
        for (;;) {
          const rows = await links();
          if (ready(rows)) return rows;
          if (Date.now() > deadline) throw new Error(`links never settled: ${JSON.stringify(rows)}`);
          await Bun.sleep(200);
        }
      };
      const byUrl = (rows: Link[], url: string) => rows.find((l) => l.url === url);
      const PLAN = 'https://example.test/launch-plan';
      const DOC = 'https://example.test/doc';

      await ctx.step('a person’s prompt in a channel thread → its links listed as source message, unpinned, pointing at the thread', async () => {
        await prompt(thread, `See ${PLAN}. And [the doc](${DOC}), and javascript:alert(1)`);
        const rows = await waitFor((r) => r.length === 2);
        const r = (await world.owner.get(SPACE_LINKS, { params: at })).status(200);
        r.body().schema(SpaceLinkListSchema);
        for (const url of [PLAN, DOC]) {
          const link = byUrl(rows, url);
          if (!link) throw new Error(`${url} was not collected`);
          if (link.source !== 'message' || link.pinned || link.session_id !== thread || link.created_by !== world.ownerUserId) {
            throw new Error(`unexpected collected link ${JSON.stringify(link)}`);
          }
        }
      });

      await ctx.step('the same address in another thread → still one row, now pointing at that thread, first sharer kept', async () => {
        await prompt(secondThread, `again: ${PLAN}`);
        const rows = await waitFor((r) => byUrl(r, PLAN)?.session_id === secondThread);
        const link = byUrl(rows, PLAN)!;
        if (rows.length !== 2 || link.session_id !== secondThread || link.created_by !== world.ownerUserId) {
          throw new Error(`unexpected after a second share ${JSON.stringify(rows)}`);
        }
      });

      await ctx.step('a member pins it → 200 { link } pinned with pinned_by_name; unpinning returns it to the shared links', async () => {
        const id = byUrl(await links(), PLAN)!.link_id;
        const pinned = await asMember.patch(SPACE_LINK, { pinned: true }, { params: { ...at, linkId: id } });
        pinned.status(200).body().schema(SpaceLinkPinResultSchema).has('$.link.pinned', true).has('$.link.source', 'message');
        if (!pinned.json<{ link: Link }>().link.pinned_by_name) throw new Error('a pinned link names no pinner');
        if (!byUrl(await links(), PLAN)!.pinned) throw new Error('the pin did not persist');
        (await asMember.patch(SPACE_LINK, { pinned: false }, { params: { ...at, linkId: id } }))
          .status(200).body().has('$.link.pinned', false).has('$.link.pinned_by_name', null);
        const after = byUrl(await links(), PLAN);
        if (!after || after.pinned) throw new Error('an unpinned collected link left the list or stayed pinned');
      });

      await ctx.step('an added link is unpinned, manual and listed; any member pins it, and unpinning it keeps it listed', async () => {
        const added = (await world.owner.post(SPACE_LINKS, { url: 'https://example.test/brand' }, { params: at })).status(201);
        added.body().has('$.pinned', false).has('$.source', 'manual').has('$.session_id', null).has('$.created_by', world.ownerUserId);
        const id = added.json<Link>().link_id;
        const listed = (await links()).find((l) => l.link_id === id);
        if (!listed || listed.pinned) throw new Error(`an added link is not listed unpinned: ${JSON.stringify(listed)}`);
        (await asMember.patch(SPACE_LINK, { pinned: true }, { params: { ...at, linkId: id } })).status(200).body().has('$.link.pinned', true);
        (await asMember.patch(SPACE_LINK, { pinned: false }, { params: { ...at, linkId: id } }))
          .status(200).body().has('$.link.pinned', false).has('$.link.link_id', id);
        const after = (await links()).find((l) => l.link_id === id);
        if (!after || after.pinned) throw new Error('an unpinned added link left the list or stayed pinned');
      });

      await ctx.step('adding an address the channel already collected takes the new title on that row, unpinned, not a second one', async () => {
        const r = await world.owner.post(SPACE_LINKS, { url: DOC, title: 'The doc' }, { params: at });
        r.status(201).body().has('$.pinned', false).has('$.source', 'message').has('$.title', 'The doc');
        if ((await links()).filter((l) => l.url === DOC).length !== 1) throw new Error('the add duplicated a collected link');
      });

      await ctx.step('bad pin input → 400; an unknown or malformed link id → 404 link_not_found', async () => {
        const id = byUrl(await links(), PLAN)!.link_id;
        (await world.owner.patch(SPACE_LINK, { pinned: 'yes' }, { params: { ...at, linkId: id } })).status(400);
        (await world.owner.patch(SPACE_LINK, {}, { params: { ...at, linkId: id } })).status(400);
        for (const linkId of [randomUUID(), 'not-a-uuid']) {
          (await world.owner.patch(SPACE_LINK, { pinned: true }, { params: { ...at, linkId } })).status(404).body().has('$.code', 'link_not_found');
        }
      });

      await ctx.step('with 200 pinned links, pinning one more → 409 link_limit', async () => {
        const id = byUrl(await links(), PLAN)!.link_id;
        // Nothing else is pinned here: 200 pinned rows, written directly.
        await world.db.query(
          `INSERT INTO kortix.project_space_links (space_id, project_id, url, created_by, pinned)
           SELECT $1, $2, 'https://example.test/pinned-' || n, $3, true FROM generate_series(1, 200) AS n`,
          [channel, project.id, world.ownerUserId],
        );
        (await world.owner.patch(SPACE_LINK, { pinned: true }, { params: { ...at, linkId: id } })).status(409).body().has('$.code', 'link_limit');
        await world.db.query(`DELETE FROM kortix.project_space_links WHERE space_id = $1 AND url LIKE 'https://example.test/pinned-%'`, [channel]);
      });

      await ctx.step('a DM thread, a private channel thread and a prompt while the flag is off collect nothing', async () => {
        const dm = (await world.owner.post(DM, { agent_name: 'kortix' }, { params })).status(200).json<Space>().space_id;
        const dmThread = await insertSession(world, world.ownerUserId, 'private', { spaceId: dm });
        const privateThread = await insertSession(world, world.ownerUserId, 'private', { spaceId: channel });
        await prompt(dmThread, 'https://example.test/from-dm');
        await prompt(privateThread, 'https://example.test/from-private');
        await world.setFeature('project_channels', false);
        await prompt(thread, 'https://example.test/flag-off');
        await world.setFeature('project_channels', true);
        // A positive control after the three: once it is listed, the three were decided.
        await prompt(thread, 'https://example.test/control');
        const rows = await waitFor((r) => !!byUrl(r, 'https://example.test/control'));
        for (const url of ['https://example.test/from-private', 'https://example.test/flag-off']) {
          if (byUrl(rows, url)) throw new Error(`${url} was collected`);
        }
        const { rows: dmRows } = await world.db.query('SELECT 1 FROM kortix.project_space_links WHERE space_id = $1', [dm]);
        if (dmRows.length !== 0) throw new Error('a DM thread collected a link');
      });
    } finally {
      await world.close();
    }
  },
);

/**
 * Link titles fetched in the background (job `link-unfurl`). Every fetch goes
 * through the egress guard, which refuses loopback, private, link-local and
 * metadata addresses after DNS. A local fixture page is therefore never
 * fetchable, so this flow proves only the refused path. The titled path
 * (`og:title` → `display_title`) would need a public page and the open
 * internet, which no flow capability declares: `parseLinkMeta` and
 * `fetchLinkMeta` are pinned by apps/api/src/projects/lib/link-unfurl.test.ts.
 */
flow('SPACE-21', meta([TAB_ROUTES.links, TAB_ROUTES.addLink, ROUTES.create, FEATURES_ROUTE]), async (ctx) => {
  const { project, world } = await openWorld(ctx);
  const params = { projectId: project.id };
  try {
    await world.setFeature('project_channels', true);
    const channel = (await world.owner.post(SPACES, { name: 'Unfurl' }, { params })).status(201).json<Space>().space_id;
    const at = { ...params, spaceId: channel };
    type Row = { link_id: string; fetched_title: string | null; site_name: string | null; icon_url: string | null; fetched_at: Date | null; fetch_failed_at: Date | null };
    const PRIVATE = [
      { url: 'http://localhost/launch-notes', display: 'launch-notes' },
      { url: 'http://10.0.0.5/board', title: 'Ops board', display: 'Ops board' },
      { url: 'http://169.254.169.254/latest/meta-data/', display: 'latest/meta-data' },
    ];
    const ids: string[] = [];

    await ctx.step('the owner adds 3 links on private addresses (localhost, 10.0.0.5, the metadata address) → 201 each, with no fetched title yet', async () => {
      for (const link of PRIVATE) {
        const r = await world.owner.post(SPACE_LINKS, link.title ? { url: link.url, title: link.title } : { url: link.url }, { params: at });
        r.status(201).body().schema(SpaceLinkSchema).has('$.site_name', null).has('$.icon_url', null);
        ids.push(r.json<{ link_id: string }>().link_id);
      }
    });

    await ctx.step('the background job refuses each address: fetch_failed_at is set, and no title, site name, icon or fetched_at is stored (bounded wait, 30 s)', async () => {
      const rows = await waitFor(
        async () =>
          (
            await world.db.query<Row>(
              'SELECT link_id, fetched_title, site_name, icon_url, fetched_at, fetch_failed_at FROM kortix.project_space_links WHERE link_id = ANY($1::uuid[])',
              [ids],
            )
          ).rows,
        {
          until: (found) => found.length === ids.length && found.every((row) => row.fetch_failed_at !== null),
          timeoutMs: 30_000,
          intervalMs: 250,
          description: 'the link-unfurl job to record a refused fetch for every link',
        },
      );
      for (const row of rows) {
        if (row.fetched_title !== null || row.site_name !== null || row.icon_url !== null || row.fetched_at !== null) {
          throw new Error(`a refused address stored fetched values: ${JSON.stringify(row)}`);
        }
      }
    });

    await ctx.step('GET links → display_title is the member title, else the decoded path; site_name and icon_url stay null', async () => {
      const links = (await world.owner.get(SPACE_LINKS, { params: at })).status(200).json<{ links: { link_id: string; display_title: string; site_name: string | null; icon_url: string | null }[] }>().links;
      PRIVATE.forEach((link, i) => {
        const row = links.find((l) => l.link_id === ids[i]);
        if (!row || row.display_title !== link.display || row.site_name !== null || row.icon_url !== null) {
          throw new Error(`${link.url}: expected display_title ${link.display}, got ${JSON.stringify(row)}`);
        }
      });
    });
  } finally {
    await world.close();
  }
});

const TWO_AGENT_MANIFEST =
  'kortix_version: 2\nproject:\n  name: ke2e-spaces\ndefault_agent: kortix\nagents:\n  kortix:\n    kortix_permissions: all\n  writer:\n    kortix_permissions: all\n';

flow('SPACE-22', meta([ROUTES.list, ROUTES.create, ROUTES.update, ROUTES.dm, FEATURES_ROUTE]), async (ctx) => {
  const { team, project, world } = await openWorld(ctx);
  const params = { projectId: project.id };
  try {
    await world.writeManifest(TWO_AGENT_MANIFEST, 'ke2e: two agents');
    await world.setFeature('project_channels', true);
    let channelId = '';

    await ctx.step('a new channel and #general have no agent list: agents []', async () => {
      const r = await world.owner.post(SPACES, { name: 'Marketing' }, { params });
      r.status(201).body().schema(SpaceSchema).has('$.agents', []);
      channelId = r.json<Space>().space_id;
      (await world.owner.get(SPACES, { params })).status(200).body().has('$.spaces[0].slug', 'general').has('$.spaces[0].agents', []);
    });

    await ctx.step('PATCH {agents: [writer, kortix]} → 200 in that order (writer is the default), and GET /spaces reads it back', async () => {
      (await world.owner.patch(SPACE, { agents: ['writer', 'kortix'] }, { params: { ...params, spaceId: channelId } }))
        .status(200).body().schema(SpaceSchema).has('$.agents', ['writer', 'kortix']);
      const listed = (await world.owner.get(SPACES, { params })).json<{ spaces: (Space & { agents: string[] })[] }>().spaces;
      const agents = listed.find((s) => s.space_id === channelId)?.agents;
      if (JSON.stringify(agents) !== JSON.stringify(['writer', 'kortix'])) throw new Error(`listed agents ${JSON.stringify(agents)}`);
    });

    await ctx.step('make kortix the default (move it first), then remove writer → [kortix]; a rename keeps the list', async () => {
      (await world.owner.patch(SPACE, { agents: ['kortix', 'writer'] }, { params: { ...params, spaceId: channelId } }))
        .status(200).body().has('$.agents', ['kortix', 'writer']);
      (await world.owner.patch(SPACE, { agents: ['kortix'] }, { params: { ...params, spaceId: channelId } }))
        .status(200).body().has('$.agents', ['kortix']);
      (await world.owner.patch(SPACE, { name: 'Marketing Team' }, { params: { ...params, spaceId: channelId } }))
        .status(200).body().has('$.agents', ['kortix']);
    });

    await ctx.step('an agent the project does not have, the `default` placeholder or a repeated name → 400 invalid_agents, list unchanged', async () => {
      for (const agents of [['no-such-agent'], ['default'], ['kortix', 'kortix']]) {
        (await world.owner.patch(SPACE, { agents }, { params: { ...params, spaceId: channelId } }))
          .status(400).body().has('$.code', 'invalid_agents');
      }
      (await world.owner.patch(SPACE, { agents: [''] }, { params: { ...params, spaceId: channelId } })).status(400);
      const { rows } = await world.db.query<{ agents: string[] }>('SELECT agents FROM kortix.project_spaces WHERE space_id = $1', [channelId]);
      if (JSON.stringify(rows[0]?.agents) !== JSON.stringify(['kortix'])) throw new Error(`stored agents ${JSON.stringify(rows[0]?.agents)}`);
    });

    await ctx.step('a member who did not create the channel → 403 forbidden and the list stays; agents [] clears it', async () => {
      const member = await team.addMember('member');
      await team.grantProjectRole(project.id, member.userId!, 'member');
      (await ctx.client.as(member).patch(SPACE, { agents: ['writer'] }, { params: { ...params, spaceId: channelId } }))
        .status(403).body().has('$.code', 'forbidden');
      (await world.owner.patch(SPACE, { agents: [] }, { params: { ...params, spaceId: channelId } }))
        .status(200).body().has('$.agents', []);
    });

    await ctx.step('a DM takes no agent list → 400 dm_not_editable', async () => {
      const dm = (await world.owner.post(DM, { agent_name: 'kortix' }, { params })).status(200).json<Space>();
      (await world.owner.patch(SPACE, { agents: ['kortix'] }, { params: { ...params, spaceId: dm.space_id } }))
        .status(400).body().has('$.code', 'dm_not_editable');
    });
  } finally {
    await world.close();
  }
});

const MEMBER_ROUTES = {
  list: 'GET /v1/projects/:projectId/spaces/:spaceId/members',
  add: 'POST /v1/projects/:projectId/spaces/:spaceId/members',
  remove: 'DELETE /v1/projects/:projectId/spaces/:spaceId/members/:userId',
  join: 'POST /v1/projects/:projectId/spaces/:spaceId/join',
};
const SPACE_MEMBERS = '/v1/projects/:projectId/spaces/:spaceId/members';
const SPACE_MEMBER = '/v1/projects/:projectId/spaces/:spaceId/members/:userId';
const SPACE_JOIN = '/v1/projects/:projectId/spaces/:spaceId/join';
type MemberList = { members: { user_id: string; name: string; can_remove: boolean }[]; implicit: boolean; can_add: boolean };
const memberIds = (list: MemberList) => list.members.map((m) => m.user_id).sort();

flow('SPACE-23', meta([...Object.values(MEMBER_ROUTES), ROUTES.list, ROUTES.create, FEATURES_ROUTE]), async (ctx) => {
  const { team, project, world } = await openWorld(ctx);
  const params = { projectId: project.id };
  try {
    await world.setFeature('project_channels', true);
    const priya = await team.addMember('member');
    const sam = await team.addMember('member');
    const outsider = await team.addMember('member');
    await team.grantProjectRole(project.id, priya.userId!, 'member');
    await team.grantProjectRole(project.id, sam.userId!, 'member');
    const owner = world.ownerUserId;
    let channelId = '';

    await ctx.step('the owner creates #launch: the creator is its only member, is_member true', async () => {
      const r = await world.owner.post(SPACES, { name: 'Launch' }, { params });
      r.status(201).body().schema(SpaceSchema).has('$.is_member', true);
      channelId = r.json<Space>().space_id;
      (await world.owner.get(SPACE_MEMBERS, { params: { ...params, spaceId: channelId } }))
        .status(200).body().schema(SpaceMemberListSchema).has('$.members.length', 1).has('$.implicit', false).has('$.can_add', true);
    });

    await ctx.step('the owner adds two project members in one POST {user_ids} → 200 listing all three', async () => {
      const r = await world.owner.post(SPACE_MEMBERS, { user_ids: [priya.userId, sam.userId] }, { params: { ...params, spaceId: channelId } });
      r.status(200).body().schema(SpaceMemberListSchema);
      const ids = memberIds(r.json<MemberList>());
      if (JSON.stringify(ids) !== JSON.stringify([owner, priya.userId, sam.userId].sort())) throw new Error(`members ${JSON.stringify(ids)}`);
      if (r.json<MemberList>().members.some((m) => m.name.includes('@'))) throw new Error('a member name carries an email');
    });

    await ctx.step('the owner and a member read the same people', async () => {
      const a = (await world.owner.get(SPACE_MEMBERS, { params: { ...params, spaceId: channelId } })).status(200).json<MemberList>();
      const b = (await ctx.client.as(priya).get(SPACE_MEMBERS, { params: { ...params, spaceId: channelId } })).status(200).json<MemberList>();
      if (JSON.stringify(memberIds(a)) !== JSON.stringify(memberIds(b))) throw new Error('two viewers read different members');
    });

    await ctx.step('an account member without project access and an unknown id → 400 not_project_member; nobody is added', async () => {
      for (const id of [outsider.userId, randomUUID()]) {
        (await world.owner.post(SPACE_MEMBERS, { user_ids: [id] }, { params: { ...params, spaceId: channelId } }))
          .status(400).body().has('$.code', 'not_project_member');
      }
      const { rows } = await world.db.query('SELECT user_id FROM kortix.project_space_members WHERE space_id = $1', [channelId]);
      if (rows.length !== 3) throw new Error(`expected 3 member rows, found ${rows.length}`);
    });

    await ctx.step('a member leaves (DELETE /members/me) → 200 without them; GET /spaces then says is_member false for them', async () => {
      const r = await ctx.client.as(sam).del(SPACE_MEMBER, { params: { ...params, spaceId: channelId, userId: 'me' } });
      r.status(200).body().schema(SpaceMemberListSchema).has('$.can_add', false);
      if (memberIds(r.json<MemberList>()).includes(sam.userId!)) throw new Error('the member who left is still listed');
      const listed = (await ctx.client.as(sam).get(SPACES, { params })).status(200).json<{ spaces: (Space & { is_member: boolean })[] }>().spaces;
      if (listed.find((s) => s.space_id === channelId)?.is_member !== false) throw new Error('is_member is not false after leaving');
    });

    await ctx.step('a non-member may not add people → 403 forbidden; they join (POST /join, twice) → 200 listing them', async () => {
      (await ctx.client.as(sam).post(SPACE_MEMBERS, { user_ids: [sam.userId] }, { params: { ...params, spaceId: channelId } }))
        .status(403).body().has('$.code', 'forbidden');
      for (let i = 0; i < 2; i++) {
        const r = await ctx.client.as(sam).post(SPACE_JOIN, undefined, { params: { ...params, spaceId: channelId } });
        r.status(200).body().schema(SpaceMemberListSchema);
        if (!memberIds(r.json<MemberList>()).includes(sam.userId!)) throw new Error('the joiner is not listed');
      }
    });

    await ctx.step('a member may not remove another member (403 forbidden) nor the creator (403 creator_not_removable)', async () => {
      (await ctx.client.as(priya).del(SPACE_MEMBER, { params: { ...params, spaceId: channelId, userId: sam.userId! } }))
        .status(403).body().has('$.code', 'forbidden');
      (await ctx.client.as(priya).del(SPACE_MEMBER, { params: { ...params, spaceId: channelId, userId: owner } }))
        .status(403).body().has('$.code', 'creator_not_removable');
    });

    await ctx.step('#general lists every project member implicitly; add, join and leave → 400 default_channel', async () => {
      const general = (await world.owner.get(SPACES, { params })).json<{ spaces: Space[] }>().spaces.find((s) => s.is_default)!;
      const spaceParams = { ...params, spaceId: general.space_id };
      const list = (await ctx.client.as(sam).get(SPACE_MEMBERS, { params: spaceParams })).status(200).json<MemberList>();
      if (!list.implicit || list.can_add) throw new Error('#general is not implicit or offers add');
      if (memberIds(list).includes(outsider.userId!)) throw new Error('#general lists an account member without project access');
      (await world.owner.post(SPACE_MEMBERS, { user_ids: [sam.userId] }, { params: spaceParams })).status(400).body().has('$.code', 'default_channel');
      (await ctx.client.as(sam).post(SPACE_JOIN, undefined, { params: spaceParams })).status(400).body().has('$.code', 'default_channel');
      (await ctx.client.as(sam).del(SPACE_MEMBER, { params: { ...spaceParams, userId: 'me' } })).status(400).body().has('$.code', 'default_channel');
    });

    await ctx.step('a channel create with member_ids adds them; an outsider in member_ids → 400 not_project_member and no channel', async () => {
      const r = await world.owner.post(SPACES, { name: 'Design', member_ids: [priya.userId] }, { params });
      r.status(201);
      const designId = r.json<Space>().space_id;
      const list = (await world.owner.get(SPACE_MEMBERS, { params: { ...params, spaceId: designId } })).status(200).json<MemberList>();
      if (JSON.stringify(memberIds(list)) !== JSON.stringify([owner, priya.userId].sort())) throw new Error(`design members ${JSON.stringify(memberIds(list))}`);
      (await world.owner.post(SPACES, { name: 'Leaky', member_ids: [outsider.userId] }, { params }))
        .status(400).body().has('$.code', 'not_project_member');
      const { rows } = await world.db.query(`SELECT 1 FROM kortix.project_spaces WHERE project_id = $1 AND slug = 'leaky'`, [project.id]);
      if (rows.length !== 0) throw new Error('a refused create made a channel');
    });
  } finally {
    await world.close();
  }
});
