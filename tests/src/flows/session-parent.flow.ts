import { ok, strictEqual } from 'node:assert';
import { flow } from '../core/flow';
import { createDatabaseSession } from '../fixtures/database-project';

flow('SESS-60', {
  domain: 'sessions',
  requires: ['sandbox', 'funded'],
  routes: ['POST /v1/projects/:projectId/sessions', 'GET /v1/projects/:projectId/sessions/:sessionId'],
}, async (ctx) => {
  const project = await ctx.fixtures.sharedSeededProject();
  const other = await ctx.fixtures.project();
  const owner = ctx.client.as(ctx.P.OWNER);
  ok(ctx.P.OWNER.accountId);
  ok(ctx.P.OWNER.userId);
  const parent = await createDatabaseSession(ctx.env, {
    projectId: project.id, accountId: ctx.P.OWNER.accountId, userId: ctx.P.OWNER.userId,
  });
  ctx.track('session', parent, { projectId: project.id });
  await ctx.step('visible parent is retained and no parent remains a root', async () => {
    for (const parentId of [parent, undefined]) {
      const response = await owner.post('/v1/projects/:projectId/sessions',
        { ...(parentId ? { parent_session_id: parentId } : {}) }, { params: { projectId: project.id } });
      response.status(201);
      const created = response.json<{ session_id: string; parent_session_id: string | null }>();
      ctx.track('session', created.session_id, { projectId: project.id });
      strictEqual(created.parent_session_id, parentId ?? null);
      const read = await owner.get('/v1/projects/:projectId/sessions/:sessionId', {
        params: { projectId: project.id, sessionId: created.session_id },
      });
      read.status(200).body().has('$.parent_session_id', parentId ?? null);
    }
  });
  await ctx.step('cross-project parent is rejected', async () => {
    const response = await owner.post('/v1/projects/:projectId/sessions', { parent_session_id: parent },
      { params: { projectId: other.id } });
    response.status(404);
  });
  await ctx.step('private parent cannot be selected by another member', async () => {
    const response = await ctx.client.as(ctx.P.MEMBER).post('/v1/projects/:projectId/sessions',
      { parent_session_id: parent }, { params: { projectId: project.id } });
    response.status(404);
  });
});
