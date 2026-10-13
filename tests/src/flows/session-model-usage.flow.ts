/**
 * SESS-46 — Session model usage: which model answered a session and what it cost.
 * Contract: tests/spec/end-to-end.md. Real-Postgres proofs of the aggregation live in
 * `apps/api/src/__tests__/integration-session-model-usage.test.ts`.
 */
import { flow } from '../core/flow';
import { createDatabaseSession } from '../fixtures/database-project';

flow(
  'SESS-46',
  {
    domain: 'sessions',
    requires: ['database'],
    routes: ['GET /v1/projects/:projectId/sessions/:sessionId/model-usage'],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const member = await team.addMember('member');
    await team.grantProjectRole(project.id, member.userId!, 'member');
    const owner = ctx.client.as(ctx.P.OWNER);
    const seed = async (visibility: 'project' | 'private') => {
      const id = await createDatabaseSession(ctx.env, {
        projectId: project.id,
        accountId: team.id,
        userId: ctx.P.OWNER.userId!,
        visibility,
      });
      ctx.track('session', id, { projectId: project.id });
      return id;
    };
    const shared = await seed('project');
    const priv = await seed('private');
    const route = '/v1/projects/:projectId/sessions/:sessionId/model-usage';

    await ctx.step('a session with no model request reports no latest model, no cost and no turns → 200', async () => {
      const r = await owner.get(route, { params: { projectId: project.id, sessionId: shared } });
      r.status(200).body().has('$.latest', null).has('$.billed_cost', 0).has('$.turns', {});
    });

    await ctx.step('a project member reads a session shared with the project → 200', async () => {
      const r = await ctx.client.as(member).get(route, { params: { projectId: project.id, sessionId: shared } });
      r.status(200).body().has('$.latest', null);
    });

    await ctx.step('a session the viewer cannot see → 404; a non-UUID id → 400; anonymous → 401', async () => {
      const as = ctx.client.as(member);
      (await as.get(route, { params: { projectId: project.id, sessionId: priv } })).status(404);
      (await as.get(route, { params: { projectId: project.id, sessionId: 'nope' } })).status(400);
      (await ctx.client.as(ctx.P.ANON).get(route, { params: { projectId: project.id, sessionId: shared } })).status(401);
    });
  },
);
