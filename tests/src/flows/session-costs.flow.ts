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

flow(
  'COST-2',
  {
    domain: 'billing',
    requires: ['funded', 'daytona'],
    timeoutMs: 300_000,
    routes: ['GET /v1/usage/cost-by-project', 'GET /v1/usage/cost-summary'],
  },
  async (ctx) => {
    const project = await ctx.fixtures.sharedSeededProject();
    const session = await ctx.fixtures.session(project);
    const owner = ctx.client.as(ctx.P.OWNER);
    const window = {
      from: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      to: new Date(Date.now() + 86_400_000).toISOString(),
    };

    await ctx.step('anonymous caller cannot read either rollup', async () => {
      const anon = ctx.client.as(ctx.P.ANON);
      (await anon.get('/v1/usage/cost-by-project')).status(401);
      (await anon.get('/v1/usage/cost-summary')).status(401);
    });

    await ctx.step('project rollup pages and includes the seeded project', async () => {
      const response = await owner.get('/v1/usage/cost-by-project', {
        query: { ...window, sort: 'total_desc', limit: '100', offset: '0' },
      });
      response
        .status(200)
        .body()
        .has('$.limit', 100)
        .has('$.offset', 0)
        .exists('$.total')
        .exists('$.projects');

      const projects = response.json<{
        projects?: Array<{ project_id?: string; total_cost?: number }>;
      }>()?.projects;
      if (!Array.isArray(projects)) {
        throw new Error('cost-by-project returned no projects array');
      }
      if (!projects.some((row) => row.project_id === project.id)) {
        throw new Error(`cost-by-project omitted project ${project.id}`);
      }
    });

    await ctx.step('summary carries totals, a per-day series and a prior period', async () => {
      const response = await owner.get('/v1/usage/cost-summary', { query: window });
      response
        .status(200)
        .body()
        .exists('$.totals.llm_cost')
        .exists('$.totals.compute_cost')
        .exists('$.totals.total_cost')
        .exists('$.totals.session_count')
        .exists('$.totals.project_count')
        .exists('$.previous.total_cost')
        .exists('$.series')
        .exists('$.models');

      // The series is gap-filled, one point per UTC day in the window — a
      // chart that skips empty days compresses time and turns a spike into a
      // trend. Eight days inclusive across the seven-day window above.
      const series = response.json<{ series?: Array<{ day?: string }> }>()?.series;
      if (!Array.isArray(series) || series.length !== 8) {
        throw new Error(`expected 8 gap-filled series points, got ${series?.length}`);
      }
    });

    await ctx.step('summary scopes to a single project and session', async () => {
      (
        await owner.get('/v1/usage/cost-summary', {
          query: { ...window, project_id: project.id },
        })
      )
        .status(200)
        .body()
        .exists('$.totals.total_cost');

      (
        await owner.get('/v1/usage/cost-summary', {
          query: { ...window, project_id: project.id, session_id: session.id },
        })
      )
        .status(200)
        .body()
        .exists('$.totals.total_cost');
    });

    await ctx.step('an inverted window is rejected on both routes', async () => {
      const inverted = { from: window.to, to: window.from };
      (await owner.get('/v1/usage/cost-by-project', { query: inverted })).status(400);
      (await owner.get('/v1/usage/cost-summary', { query: inverted })).status(400);
    });

    await ctx.step('csv export returns a spreadsheet, not json', async () => {
      const response = await owner.get('/v1/usage/cost-by-project', {
        query: { ...window, format: 'csv' },
      });
      response.status(200);
      // `header()` reads the value; it is not an assertion helper.
      const contentType = response.header('content-type') ?? '';
      if (!contentType.includes('text/csv')) {
        throw new Error(`csv export returned content-type ${contentType || '(none)'}`);
      }
    });
  },
);
