/**
 * Project spaces — channels (product word "Channel") and a member's DMs with an
 * agent, behind the `project_channels` flag. Spec: tests/spec/end-to-end.md
 * § 7a. Source of truth: apps/api/src/projects/routes/project-spaces.ts +
 * projects/lib/project-spaces.ts + feature-flags/toggle-effects.ts.
 */
import { randomUUID } from 'node:crypto';
import { SpaceLinkListSchema, SpaceLinkSchema, SpaceListSchema, SpaceSchema, SpaceSummarySchema } from '@kortix/api-contract';
import { flow } from '../core/flow';
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
  summary: 'GET /v1/projects/:projectId/spaces/:spaceId/summary',
};
const SPACE_APPS = '/v1/projects/:projectId/spaces/:spaceId/apps';
const SPACE_LINKS = '/v1/projects/:projectId/spaces/:spaceId/links';
const SPACE_LINK = '/v1/projects/:projectId/spaces/:spaceId/links/:linkId';
const SPACE_SUMMARY = '/v1/projects/:projectId/spaces/:spaceId/summary';
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

type Space = { space_id: string; kind: string; slug: string | null; name: string; is_default: boolean; archived_at: string | null };
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
  const { project, world } = await openWorld(ctx);
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

    await ctx.step('create "Growth" while it is archived → 409 slug_taken with archived: true and its space_id', async () => {
      (await world.owner.post(SPACES, { name: 'Growth' }, { params }))
        .status(409).body().has('$.code', 'slug_taken').has('$.space_id', launchId).has('$.archived', true);
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
  opts: { spaceId?: string; updatedAt?: Date; metadata?: Record<string, unknown> } = {},
): Promise<string> {
  const sessionId = randomUUID();
  world.sessions.push(sessionId);
  await world.db.query(
    `INSERT INTO kortix.project_sessions
       (session_id, account_id, project_id, branch_name, agent_name, status, created_by, visibility, metadata, space_id, updated_at)
     VALUES ($1, $2, $3, $1, 'kortix', 'stopped', $4, $5, $6::jsonb, $7, coalesce($8::timestamptz, now()))`,
    [
      sessionId,
      world.accountId,
      world.projectId,
      createdBy,
      visibility,
      JSON.stringify(opts.metadata ?? {}),
      opts.spaceId ?? null,
      opts.updatedAt?.toISOString() ?? null,
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
  const { project, world } = await openWorld(ctx);
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
  } finally {
    await world.close();
  }
});

flow('SPACE-14', meta([...Object.values(TAB_ROUTES), FEATURES_ROUTE]), async (ctx) => {
  const { project, world } = await openWorld(ctx);
  const params = { projectId: project.id, spaceId: randomUUID() };
  try {
    await ctx.step('with project_channels off, the apps, links and summary routes → 403 feature_disabled', async () => {
      for (const r of [
        await world.owner.get(SPACE_APPS, { params }),
        await world.owner.get(SPACE_LINKS, { params }),
        await world.owner.post(SPACE_LINKS, { url: 'https://example.test' }, { params }),
        await world.owner.del(SPACE_LINK, { params: { ...params, linkId: randomUUID() } }),
        await world.owner.get(SPACE_SUMMARY, { params }),
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

    await ctx.step('a member adds a link → 201 with its url, title and creator; the owner adds one without a title', async () => {
      const r = await asMember.post(SPACE_LINKS, { url: 'https://example.test/spec', title: 'Launch spec' }, { params: at });
      r.status(201).body().schema(SpaceLinkSchema)
        .has('$.url', 'https://example.test/spec').has('$.title', 'Launch spec')
        .has('$.created_by', member.userId!).has('$.can_delete', true);
      memberLink = r.json<{ link_id: string }>().link_id;
      const o = await world.owner.post(SPACE_LINKS, { url: 'http://example.test/board' }, { params: at });
      o.status(201).body().has('$.title', null);
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

    await ctx.step('a channel holds at most 200 links: the 201st add → 409 link_limit', async () => {
      // 199 more rows beside the owner's one, written directly: 199 POSTs would only slow the flow.
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

flow('SPACE-17', meta([TAB_ROUTES.summary, TAB_ROUTES.apps, TAB_ROUTES.addLink, TAB_ROUTES.removeLink, ROUTES.create, FEATURES_ROUTE]), async (ctx) => {
  const { project, world } = await openWorld(ctx);
  const params = { projectId: project.id };
  try {
    await world.setFeature('project_channels', true);
    const channel = (await world.owner.post(SPACES, { name: 'Counts' }, { params })).status(201).json<Space>().space_id;
    const at = { ...params, spaceId: channel };
    let appId = '';

    await ctx.step('a new channel → { apps: 0, links: 0 }', async () => {
      (await world.owner.get(SPACE_SUMMARY, { params: at })).status(200).body().schema(SpaceSummarySchema).has('$.apps', 0).has('$.links', 0);
    });

    await ctx.step('two links and an App deployed from a channel thread → { apps: 1, links: 2 }; removing a link → links 1', async () => {
      const first = (await world.owner.post(SPACE_LINKS, { url: 'https://example.test/a' }, { params: at })).status(201).json<{ link_id: string }>();
      (await world.owner.post(SPACE_LINKS, { url: 'https://example.test/b' }, { params: at })).status(201);
      appId = await insertAppDeployedFrom(world, await insertSession(world, world.ownerUserId, 'project', { spaceId: channel }), 'ke2e-count-app');
      (await world.owner.get(SPACE_SUMMARY, { params: at })).status(200).body().has('$.apps', 1).has('$.links', 2);
      (await world.owner.del(SPACE_LINK, { params: { ...at, linkId: first.link_id } })).status(200);
      (await world.owner.get(SPACE_SUMMARY, { params: at })).status(200).body().has('$.links', 1);
    });

    let unlistedId = '';
    await ctx.step('an App the grid hides (display.listed: false) leaves apps unchanged: the count is the cards', async () => {
      unlistedId = await insertAppDeployedFrom(world, await insertSession(world, world.ownerUserId, 'project', { spaceId: channel }), 'ke2e-hidden-app');
      await world.db.query(`UPDATE kortix.apps SET display = '{"listed": false}'::jsonb WHERE app_id = $1`, [unlistedId]);
      (await world.owner.get(SPACE_APPS, { params: at })).status(200).body().has('$.apps.length', 2);
      (await world.owner.get(SPACE_SUMMARY, { params: at })).status(200).body().has('$.apps', 1);
    });

    await world.db.query('DELETE FROM kortix.apps WHERE app_id = ANY($1::uuid[])', [[appId, unlistedId].filter(Boolean)]);
  } finally {
    await world.close();
  }
});
