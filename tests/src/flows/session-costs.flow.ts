import { flow } from '../core/flow';

flow(
  'COST-1',
  {
    domain: 'billing',
    requires: ['funded', 'daytona'],
    timeoutMs: 300_000,
    routes: ['GET /v1/usage/session-costs', 'GET /v1/usage/session-costs/:sessionId'],
  },
  async (ctx) => {
    const project = await ctx.fixtures.sharedSeededProject();
    const session = await ctx.fixtures.session(project);
    const owner = ctx.client.as(ctx.P.OWNER);

    await ctx.step('anonymous caller cannot list session costs', async () => {
      const response = await ctx.client.as(ctx.P.ANON).get('/v1/usage/session-costs');
      response.status(401);
    });

    await ctx.step('project-filtered list contains the new session', async () => {
      const response = await owner.get('/v1/usage/session-costs', {
        query: { project_id: project.id, limit: '100', offset: '0' },
      });
      response
        .status(200)
        .body()
        .has('$.limit', 100)
        .has('$.offset', 0)
        .exists('$.total')
        .exists('$.sessions')
        .exists('$.reconciliation.llm_cost')
        .exists('$.reconciliation.compute_cost')
        .exists('$.reconciliation.total_cost');
      const sessions = response.json<{
        sessions?: Array<{ session_id?: string }>;
      }>()?.sessions;
      if (!Array.isArray(sessions) || !sessions.some((row) => row.session_id === session.id)) {
        throw new Error(`session-cost list omitted session ${session.id}`);
      }
    });

    await ctx.step('detail returns unified cost and ledger fields', async () => {
      const response = await owner.get('/v1/usage/session-costs/:sessionId', {
        params: { sessionId: session.id },
        query: { project_id: project.id },
      });
      response
        .status(200)
        .body()
        .has('$.session_id', session.id)
        .has('$.project_id', project.id)
        .exists('$.llm_cost')
        .exists('$.compute_cost')
        .exists('$.total_cost')
        .exists('$.request_count')
        .exists('$.compute_seconds')
        .exists('$.model_usage')
        .exists('$.ledger_entries');
    });

    await ctx.step('project mismatch hides the session cost record', async () => {
      const response = await owner.get('/v1/usage/session-costs/:sessionId', {
        params: { sessionId: session.id },
        query: { project_id: crypto.randomUUID() },
      });
      response.status(404);
    });

    await ctx.step('invalid pagination is rejected', async () => {
      const response = await owner.get('/v1/usage/session-costs', {
        query: { limit: '0' },
      });
      response.status(400);
    });
  },
);
