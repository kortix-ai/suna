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

    await ctx.step(
      'ordinary start refuses the previous repository and names the remedy',
      async () => {
        const response = await ctx.client.as(ctx.P.OWNER).post(path, {}, { params });
        response
          .status(409)
          .body()
          .has('$.code', 'session_repository_changed')
          .has(
            '$.remedy',
            'Resume the preserved workspace without Git access, or start a new session.',
          );
      },
    );

    await ctx.step(
      'explicit previous mode passes the generation gate for the preserved runtime',
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

    await ctx.step('a project member cannot bypass the session lifecycle owner gate', async () => {
      const response = await ctx.client.as(member).post(
        path,
        {},
        {
          params,
          query: { repository_mode: 'previous' },
        },
      );
      response.status(403).body().has('$.code', 'previous_repository_resume_forbidden');
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
      'explicit previous mode never provisions a replacement when the old runtime is gone',
      async () => {
        const response = await ctx.client.as(ctx.P.OWNER).post(
          path,
          {},
          {
            params: { projectId: project.id, sessionId: unavailableSessionId },
            query: { repository_mode: 'previous' },
          },
        );
        response.status(409).body().has('$.code', 'previous_repository_runtime_unavailable');
      },
    );
  },
);
