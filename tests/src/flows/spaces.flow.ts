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
const SPACES = '/v1/projects/:projectId/spaces';
const SPACE = '/v1/projects/:projectId/spaces/:spaceId';
const DM = '/v1/projects/:projectId/spaces/dm';
const MANIFEST =
  'kortix_version: 2\nproject:\n  name: ke2e-spaces\ndefault_agent: kortix\nagents:\n  kortix:\n    kortix_permissions: all\n';

type Space = { space_id: string; kind: string; slug: string | null; name: string; is_default: boolean; archived_at: string | null };

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
      if (own.json<Space>().space_id === dmId) throw new Error('two members share one DM');
    });

    await ctx.step('an agent the manifest does not declare → 404 agent_not_found', async () => {
      (await world.owner.post(DM, { agent_name: 'no-such-agent' }, { params }))
        .status(404).body().has('$.code', 'agent_not_found');
    });

    await ctx.step('a DM cannot be renamed or archived → 400 dm_not_editable', async () => {
      (await world.owner.patch(SPACE, { archived: true }, { params: { ...params, spaceId: dmId } }))
        .status(400).body().has('$.code', 'dm_not_editable');
    });
  } finally {
    await world.close();
  }
});
