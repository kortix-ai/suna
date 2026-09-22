import { flow } from '../core/flow';
import {
  configurePreviousRepositorySession,
  createDatabaseSession,
  fundDatabaseAccount,
} from '../fixtures/database-project';

flow(
  'SESS-33',
  {
    domain: 'sessions',
    requires: ['database'],
    routes: ['POST /v1/projects/:projectId/sessions/:sessionId/start'],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team({
      name: ctx.fixtures.name('previous-repository-session'),
    });
    const project = await team.project({ seed: true });
    const member = await team.addMember('member');
    const memberUserId = member.userId;
    const ownerUserId = ctx.P.OWNER.userId;
    if (!memberUserId || !ownerUserId) throw new Error('SESS-33 requires user principals');
    await team.grantProjectRole(project.id, memberUserId, 'member');
    const accountId = team.id;
    await fundDatabaseAccount(ctx.env, accountId);
    const sessionId = await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId,
      userId: ownerUserId,
      visibility: 'project',
    });
    const params = { projectId: project.id, sessionId };
    const path = '/v1/projects/:projectId/sessions/:sessionId/start';

    await configurePreviousRepositorySession(ctx.env, {
      projectId: project.id,
      sessionId,
      accountId,
      preserveRuntime: true,
    });

    await ctx.step('ordinary start opens the preserved workspace without a bypass', async () => {
      const response = await ctx.client.as(ctx.P.OWNER).post(path, {}, { params });
      response.status(200).body().has('$.stage', 'stopped');
    });

    await ctx.step(
      'the legacy previous mode parameter remains backward compatible',
      async () => {
        const response = await ctx.client.as(ctx.P.OWNER).post(
          path,
          {},
          {
            params,
            query: { repository_mode: 'previous' },
          },
        );
        response.status(200).body().has('$.stage', 'stopped');
      },
    );

    await ctx.step('ordinary agent access policy still applies to a project member', async () => {
      const response = await ctx.client.as(member).post(
        path,
        {},
        {
          params,
          query: { repository_mode: 'previous' },
        },
      );
      response
        .status(403)
        .body()
        .has(
          '$.error',
          "You don't have access to any agent in this project. Ask a manager to grant you one.",
        );
    });

    const unavailableSessionId = await createDatabaseSession(ctx.env, {
      projectId: project.id,
      accountId,
      userId: ownerUserId,
    });
    await configurePreviousRepositorySession(ctx.env, {
      projectId: project.id,
      sessionId: unavailableSessionId,
      accountId,
      preserveRuntime: false,
    });

    await ctx.step(
      'a missing previous runtime uses the ordinary stopped-session recovery path',
      async () => {
        const response = await ctx.client.as(ctx.P.OWNER).post(
          path,
          {},
          {
            params: { projectId: project.id, sessionId: unavailableSessionId },
            query: { repository_mode: 'previous' },
          },
        );
        response.status(200).body().has('$.stage', 'stopped');
      },
    );
  },
);
