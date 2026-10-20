/**
 * Project spaces — channels (product word "Channel") and a member's DMs with an
 * agent, behind the `project_channels` flag. Spec: tests/spec/end-to-end.md
 * § 7a. Source of truth: apps/api/src/projects/routes/project-spaces.ts +
 * projects/lib/project-spaces.ts + feature-flags/toggle-effects.ts.
 */
import { randomUUID } from 'node:crypto';
import { SpaceListSchema, SpaceSchema } from '@kortix/api-contract';
import { flow } from '../core/flow';
import type { FlowContext, FlowMeta } from '../core/types';
import { AgentPrincipalsWorld } from '../fixtures/agent-principals';

const ROUTES = {
  list: 'GET /v1/projects/:projectId/spaces',
  create: 'POST /v1/projects/:projectId/spaces',
  update: 'PATCH /v1/projects/:projectId/spaces/:spaceId',
  dm: 'POST /v1/projects/:projectId/spaces/dm',
};
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
): Promise<string> {
  const sessionId = randomUUID();
  world.sessions.push(sessionId);
  await world.db.query(
    `INSERT INTO kortix.project_sessions
       (session_id, account_id, project_id, branch_name, agent_name, status, created_by, visibility, metadata)
     VALUES ($1, $2, $3, $1, 'kortix', 'stopped', $4, $5, '{}'::jsonb)`,
    [sessionId, world.accountId, world.projectId, createdBy, visibility],
  );
  return sessionId;
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

    await ctx.step('the caller’s own DM passes the space check (201, or the local profile’s no-sandbox 503)', async () => {
      const ownDmId = (await world.owner.post(DM, { agent_name: 'kortix' }, { params })).status(200).json<Space>().space_id;
      const r = await world.owner.post(SESSIONS, { space_id: ownDmId }, { params });
      if (r.statusCode === 201) {
        ctx.track('session', r.json<Session>().session_id, { projectId: project.id });
        r.body().has('$.space_id', ownDmId).has('$.visibility', 'private');
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

    await ctx.step('another space lists none of them', async () => {
      const other = (await world.owner.post(SPACES, { name: 'Elsewhere' }, { params })).status(201).json<Space>().space_id;
      const ids = await listedInSpace(world.owner, project.id, other);
      if (ids.length !== 0) throw new Error(`an empty channel lists ${ids.length} session(s)`);
    });
  } finally {
    await world.close();
  }
});
