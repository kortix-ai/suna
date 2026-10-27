/**
 * Session groups — named folders of a project's sessions that every member
 * shares, behind the `session_groups` flag. Spec: tests/spec/end-to-end.md
 * § 7b. Source of truth: apps/api/src/projects/routes/session-groups.ts +
 * projects/lib/session-groups.ts + the `group` filter of GET /sessions.
 */
import { randomUUID } from 'node:crypto';
import {
  OkResponseSchema,
  ProjectSessionSchema,
  SessionGroupAssignmentSchema,
  SessionGroupListSchema,
  SessionGroupSchema,
} from '@kortix/api-contract';
import { flow } from '../core/flow';
import type { FlowContext, FlowMeta } from '../core/types';
import { AgentPrincipalsWorld } from '../fixtures/agent-principals';

const ROUTES = {
  list: 'GET /v1/projects/:projectId/session-groups',
  create: 'POST /v1/projects/:projectId/session-groups',
  update: 'PATCH /v1/projects/:projectId/session-groups/:groupId',
  remove: 'DELETE /v1/projects/:projectId/session-groups/:groupId',
  order: 'PUT /v1/projects/:projectId/session-groups/order',
  assign: 'PUT /v1/projects/:projectId/sessions/:sessionId/group',
};
const SESSION_ROUTES = {
  list: 'GET /v1/projects/:projectId/sessions',
  read: 'GET /v1/projects/:projectId/sessions/:sessionId',
};
const GROUPS = '/v1/projects/:projectId/session-groups';
const GROUP = '/v1/projects/:projectId/session-groups/:groupId';
const ORDER = '/v1/projects/:projectId/session-groups/order';
const ASSIGN = '/v1/projects/:projectId/sessions/:sessionId/group';
const SESSIONS = '/v1/projects/:projectId/sessions';
const SESSION = '/v1/projects/:projectId/sessions/:sessionId';

type Group = { group_id: string; name: string; position: number };
type Session = { session_id: string; group_id: string | null; updated_at: string };

function fail(message: string, detail?: unknown): never {
  throw new Error(detail === undefined ? message : `${message}: ${JSON.stringify(detail)}`);
}

async function openWorld(ctx: FlowContext) {
  const team = await ctx.fixtures.team();
  const project = await team.project({ managedGit: true });
  const world = await AgentPrincipalsWorld.open(ctx, { accountId: team.id, projectId: project.id });
  return { team, project, world };
}

/** A stopped session row of the project, started by `createdBy`, cleaned up by the world. */
async function insertSession(
  world: AgentPrincipalsWorld,
  projectId: string,
  createdBy: string,
  visibility: 'private' | 'project',
): Promise<string> {
  const sessionId = randomUUID();
  world.sessions.push(sessionId);
  await world.db.query(
    `INSERT INTO kortix.project_sessions
       (session_id, account_id, project_id, branch_name, agent_name, status, created_by, visibility, metadata)
     VALUES ($1, $2, $3, $1, 'kortix', 'stopped', $4, $5, '{}'::jsonb)`,
    [sessionId, world.accountId, projectId, createdBy, visibility],
  );
  return sessionId;
}

const meta = (routes: string[]): FlowMeta => ({ domain: 'session-groups', requires: ['database'], timeoutMs: 120_000, routes });

flow('SGRP-1', meta(Object.values(ROUTES)), async (ctx) => {
  const { project, world } = await openWorld(ctx);
  const params = { projectId: project.id };
  try {
    await ctx.step('with session_groups off (the default), every session-groups route → 403 feature_disabled', async () => {
      const groupParams = { ...params, groupId: randomUUID() };
      for (const r of [
        await world.owner.get(GROUPS, { params }),
        await world.owner.post(GROUPS, { name: 'Store A' }, { params }),
        await world.owner.patch(GROUP, { name: 'Store B' }, { params: groupParams }),
        await world.owner.del(GROUP, { params: groupParams }),
        await world.owner.put(ORDER, { group_ids: [] }, { params }),
        await world.owner.put(ASSIGN, { group_id: null }, { params: { ...params, sessionId: randomUUID() } }),
      ]) {
        r.status(403).body().has('$.code', 'feature_disabled').has('$.feature', 'session_groups');
      }
    });

    await ctx.step('the refused writes stored nothing: the project has no group row', async () => {
      const { rows } = await world.db.query('SELECT 1 FROM kortix.project_session_groups WHERE project_id = $1', [project.id]);
      if (rows.length !== 0) fail(`expected no groups, found ${rows.length}`);
    });

    await ctx.step('an anonymous caller → 401', async () => {
      (await ctx.client.as(ctx.P.ANON).get(GROUPS, { params })).status(401);
    });
  } finally {
    await world.close();
  }
});

flow('SGRP-2', meta([ROUTES.list, ROUTES.create, ROUTES.update, ROUTES.remove, ROUTES.order]), async (ctx) => {
  const { team, project, world } = await openWorld(ctx);
  const params = { projectId: project.id };
  const member = await team.addMember('member');
  await team.grantProjectRole(project.id, member.userId!, 'member');
  const asMember = ctx.client.as(member);
  const outsider = ctx.client.as(await team.addMember('member'));
  const ids: Record<string, string> = {};
  try {
    await world.setFeature('session_groups', true);

    await ctx.step('the owner creates Store A and Store B, a member creates Store C → 201 each, last in the order', async () => {
      for (const [client, name, position] of [
        [world.owner, '  Store A  ', 0],
        [world.owner, 'Store B', 1],
        [asMember, 'Store C', 2],
      ] as const) {
        const r = await client.post(GROUPS, { name }, { params });
        r.status(201).body().schema(SessionGroupSchema).has('$.name', name.trim()).has('$.position', position);
        ids[name.trim()] = r.json<Group>().group_id;
      }
    });

    await ctx.step('GET lists them in order for the owner and the member alike', async () => {
      for (const client of [world.owner, asMember]) {
        const r = await client.get(GROUPS, { params });
        r.status(200).body().schema(SessionGroupListSchema);
        const names = r.json<{ groups: Group[] }>().groups.map((group) => group.name);
        if (JSON.stringify(names) !== JSON.stringify(['Store A', 'Store B', 'Store C'])) fail('wrong order', names);
      }
    });

    await ctx.step('a name the project has in any case → 409 group_name_taken; a blank or 81-character name → 400', async () => {
      (await world.owner.post(GROUPS, { name: 'store a' }, { params })).status(409).body().has('$.code', 'group_name_taken');
      (await world.owner.post(GROUPS, { name: '   ' }, { params })).status(400);
      (await world.owner.post(GROUPS, { name: 'x'.repeat(81) }, { params })).status(400);
    });

    await ctx.step('an account member outside the project → 403/404 on list and create, and stores nothing', async () => {
      (await outsider.get(GROUPS, { params })).status([403, 404]);
      (await outsider.post(GROUPS, { name: 'Intruder' }, { params })).status([403, 404]);
      const { rows } = await world.db.query('SELECT 1 FROM kortix.project_session_groups WHERE project_id = $1', [project.id]);
      if (rows.length !== 3) fail(`expected 3 groups, found ${rows.length}`);
    });

    await ctx.step('PATCH renames; a taken name → 409; an unknown or malformed id → 404 group_not_found', async () => {
      (await world.owner.patch(GROUP, { name: 'Store A (EU)' }, { params: { ...params, groupId: ids['Store A']! } }))
        .status(200).body().schema(SessionGroupSchema).has('$.name', 'Store A (EU)').has('$.position', 0);
      (await asMember.patch(GROUP, { name: 'STORE B' }, { params: { ...params, groupId: ids['Store C']! } }))
        .status(409).body().has('$.code', 'group_name_taken');
      for (const groupId of [randomUUID(), 'not-a-uuid']) {
        (await world.owner.patch(GROUP, { name: 'X' }, { params: { ...params, groupId } })).status(404).body().has('$.code', 'group_not_found');
      }
    });

    await ctx.step('PUT /order with every id once → 200 in the new order; a partial or foreign list → 409 group_order_stale and nothing moves', async () => {
      const order = [ids['Store C']!, ids['Store A']!, ids['Store B']!];
      const r = await asMember.put(ORDER, { group_ids: order }, { params });
      r.status(200).body().schema(SessionGroupListSchema);
      const got = r.json<{ groups: Group[] }>().groups.map((group) => [group.group_id, group.position]);
      if (JSON.stringify(got) !== JSON.stringify(order.map((id, i) => [id, i]))) fail('order not applied', got);
      (await world.owner.put(ORDER, { group_ids: order.slice(0, 2) }, { params })).status(409).body().has('$.code', 'group_order_stale');
      (await world.owner.put(ORDER, { group_ids: [...order.slice(0, 2), randomUUID()] }, { params }))
        .status(409).body().has('$.code', 'group_order_stale');
      (await world.owner.put(ORDER, { group_ids: [order[0], order[0], order[1]] }, { params })).status(400);
      const after = (await world.owner.get(GROUPS, { params })).json<{ groups: Group[] }>().groups.map((group) => group.group_id);
      if (JSON.stringify(after) !== JSON.stringify(order)) fail('a refused reorder moved groups', after);
    });

    await ctx.step('DELETE → 200 {ok}; the rest close up; deleting it again → 404 group_not_found', async () => {
      (await asMember.del(GROUP, { params: { ...params, groupId: ids['Store A']! } })).status(200).body().schema(OkResponseSchema);
      const groups = (await world.owner.get(GROUPS, { params })).json<{ groups: Group[] }>().groups;
      const got = groups.map((group) => [group.name, group.position]);
      if (JSON.stringify(got) !== JSON.stringify([['Store C', 0], ['Store B', 1]])) fail('positions did not close up', got);
      (await world.owner.del(GROUP, { params: { ...params, groupId: ids['Store A']! } })).status(404).body().has('$.code', 'group_not_found');
    });
  } finally {
    await world.close();
  }
});

flow('SGRP-3', meta([ROUTES.create, ROUTES.assign, ROUTES.remove, SESSION_ROUTES.list, SESSION_ROUTES.read]), async (ctx) => {
  const { team, project, world } = await openWorld(ctx);
  const params = { projectId: project.id };
  const member = await team.addMember('member');
  await team.grantProjectRole(project.id, member.userId!, 'member');
  const asMember = ctx.client.as(member);
  const other = await team.project({ managedGit: true });
  try {
    await world.setFeature('session_groups', true);
    const store = (await world.owner.post(GROUPS, { name: 'Store A' }, { params })).status(201).json<Group>().group_id;
    const shared = await insertSession(world, project.id, world.ownerUserId, 'project');
    const loose = await insertSession(world, project.id, world.ownerUserId, 'project');
    const hidden = await insertSession(world, project.id, world.ownerUserId, 'private');
    const readSession = async (sessionId: string) =>
      (await world.owner.get(SESSION, { params: { ...params, sessionId } })).status(200).json<Session>();
    const listIds = async (query: Record<string, string>) =>
      (await world.owner.get(SESSIONS, { params, query })).status(200).json<Session[]>().map((s) => s.session_id).sort();

    await ctx.step('a member files a project session into Store A → 200 {session_id, group_id}; its updated_at stays', async () => {
      const before = await readSession(shared);
      if (before.group_id !== null) fail('a new session is already in a group', before.group_id);
      (await asMember.put(ASSIGN, { group_id: store }, { params: { ...params, sessionId: shared } }))
        .status(200).body().schema(SessionGroupAssignmentSchema).has('$.session_id', shared).has('$.group_id', store);
      const after = await readSession(shared);
      if (after.group_id !== store) fail('GET /sessions/:id does not carry the group', after.group_id);
      if (after.updated_at !== before.updated_at) fail('filing moved updated_at', [before.updated_at, after.updated_at]);
    });

    await ctx.step('GET /sessions?group=<id> lists only its sessions, each with group_id; ?group=none leaves them out', async () => {
      const grouped = (await world.owner.get(SESSIONS, { params, query: { group: store } })).status(200);
      grouped.body().schema(ProjectSessionSchema.array());
      const rows = grouped.json<Session[]>();
      if (rows.length !== 1 || rows[0]!.session_id !== shared || rows[0]!.group_id !== store) fail('group list', rows);
      const none = await listIds({ group: 'none' });
      if (none.includes(shared) || !none.includes(loose)) fail('group=none', none);
      (await world.owner.get(SESSIONS, { params, query: { group: 'store-a' } })).status(400);
    });

    await ctx.step("a session the member cannot see → 404; another project's group or an unknown one → 404 group_not_found", async () => {
      (await asMember.put(ASSIGN, { group_id: store }, { params: { ...params, sessionId: hidden } })).status(404);
      const foreign = randomUUID();
      await world.db.query(
        `INSERT INTO kortix.project_session_groups (group_id, account_id, project_id, name, position)
         VALUES ($1, $2, $3, 'Elsewhere', 0)`,
        [foreign, world.accountId, other.id],
      );
      for (const groupId of [foreign, randomUUID()]) {
        (await world.owner.put(ASSIGN, { group_id: groupId }, { params: { ...params, sessionId: loose } }))
          .status(404).body().has('$.code', 'group_not_found');
      }
      if ((await readSession(loose)).group_id !== null) fail('a refused filing changed the session');
      (await world.owner.put(ASSIGN, { group_id: store }, { params: { ...params, sessionId: randomUUID() } })).status(404);
    });

    await ctx.step('a session another session started stays with its parent: filing it → 400 group_child_session', async () => {
      const child = await insertSession(world, project.id, world.ownerUserId, 'project');
      await world.db.query('UPDATE kortix.project_sessions SET parent_session_id = $1 WHERE session_id = $2', [shared, child]);
      (await world.owner.put(ASSIGN, { group_id: store }, { params: { ...params, sessionId: child } }))
        .status(400).body().has('$.code', 'group_child_session');
      if ((await readSession(child)).group_id !== null) fail('a refused child was filed');
    });

    await ctx.step('group_id null takes the session out of its group', async () => {
      (await world.owner.put(ASSIGN, { group_id: store }, { params: { ...params, sessionId: loose } })).status(200);
      (await world.owner.put(ASSIGN, { group_id: null }, { params: { ...params, sessionId: loose } }))
        .status(200).body().has('$.group_id', null);
      if ((await readSession(loose)).group_id !== null) fail('null did not take the session out');
    });

    await ctx.step('with the flag off, ?group= is ignored (both sessions listed) and the session keeps its group_id', async () => {
      await world.setFeature('session_groups', false);
      const all = await listIds({ group: store });
      if (!all.includes(shared) || !all.includes(loose)) fail('flag off still filtered by group', all);
      const { rows } = await world.db.query<{ group_id: string | null }>('SELECT s.group_id FROM kortix.project_sessions s JOIN kortix.project_session_groups g ON g.group_id = s.group_id WHERE s.session_id = $1', [shared]);
      if (rows[0]?.group_id !== store) fail('flag off removed the filing');
      await world.setFeature('session_groups', true);
    });

    await ctx.step('deleting Store A leaves its session in no group', async () => {
      (await world.owner.del(GROUP, { params: { ...params, groupId: store } })).status(200);
      if ((await readSession(shared)).group_id !== null) fail('the session still names the deleted group');
    });
  } finally {
    await world.close();
  }
});
