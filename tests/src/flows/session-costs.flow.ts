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

      // The series is gap-filled, one point per UTC day in the half-open
      // window [floor(from), to) — a chart that skips empty days compresses
      // time and turns a spike into a trend. The count depends on the time of
      // day the flow runs (the first bucket is the partial day `from` lands
      // in), so compute it from the window instead of hard-coding it: a fixed
      // 8 fails as 9 for any run not at exactly UTC midnight.
      const windowFrom = new Date(window.from);
      const firstBucket = Date.UTC(
        windowFrom.getUTCFullYear(),
        windowFrom.getUTCMonth(),
        windowFrom.getUTCDate(),
      );
      const expectedPoints = Math.ceil((new Date(window.to).getTime() - firstBucket) / 86_400_000);
      const series = response.json<{ series?: Array<{ day?: string }> }>()?.series;
      if (!Array.isArray(series) || series.length !== expectedPoints) {
        throw new Error(
          `expected ${expectedPoints} gap-filled series points for [${window.from}, ${window.to}), got ${series?.length}`,
        );
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

/**
 * COST-3 — a real sandbox on an account that never subscribed is metered.
 *
 * `credit_accounts.billing_model` defaults to 'legacy'. The meter read that
 * default as "legacy customer" and returned before opening a window, so every
 * free account and every admin trial ran compute for $0: one prod trial account
 * ran 16,909 sandboxes with zero `sandbox_compute_sessions` rows. Only a legacy
 * PAID plan is exempt now.
 */
flow(
  'COST-3',
  {
    domain: 'billing',
    requires: ['funded', 'daytona', 'database'],
    timeoutMs: 300_000,
    routes: ['POST /v1/projects/:projectId/sessions'],
  },
  async (ctx) => {
    const { Client } = await import('pg');
    const databaseUrl = ctx.env.databaseUrl as string;
    const local = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
    const db = new Client({
      connectionString: databaseUrl,
      ssl: local ? false : { rejectUnauthorized: false },
    });
    await db.connect();
    try {
      // Its OWN account, not the shared funded fixture: that one is a legacy
      // `pro` plan on the preview, which is exactly the exempt group. A fresh
      // team account takes the `billing_model` column default, funded at tier
      // `free` — the shape of every account the defect left unmetered.
      const team = await ctx.fixtures.team();
      await db.query(
        `INSERT INTO kortix.credit_accounts
         (account_id, balance, balance_precise, non_expiring_credits, non_expiring_credits_precise, tier)
         VALUES ($1, 1000, 1000, 1000, 1000, 'free')
         ON CONFLICT (account_id) DO UPDATE SET
           balance = 1000, balance_precise = 1000,
           non_expiring_credits = 1000, non_expiring_credits_precise = 1000,
           tier = 'free'`,
        [team.id],
      );
      // `managedGit: true` is load-bearing. With the `database` capability a
      // plain `project()` is database-only, and `session()` then writes the
      // session row directly: no session create, no sandbox, no compute window.
      // Every preview failed here with `no sandbox_compute_sessions row opened:
      // []` after 240 s — `[]` is the absent `session_sandboxes` row.
      const project = await team.project({ managedGit: true });
      const session = await ctx.fixtures.session(project);

      await ctx.step('the session account carries the legacy default on the free tier', async () => {
        const account = await db.query(
          `SELECT ca.billing_model, ca.tier FROM kortix.project_sessions ps
           JOIN kortix.credit_accounts ca ON ca.account_id = ps.account_id
           WHERE ps.session_id = $1`,
          [session.id],
        );
        const row = account.rows[0];
        if (row?.billing_model !== 'legacy' || row?.tier !== 'free') {
          throw new Error(`fixture account is not legacy/free: ${JSON.stringify(row)}`);
        }
      });

      await ctx.step('its sandbox opens a compute window once it is active', async () => {
        const deadline = Date.now() + 240_000;
        let last: unknown = null;
        while (Date.now() < deadline) {
          const result = await db.query(
            `SELECT s.status, c.id AS compute_id, c.state, c.cpu_cores, c.memory_gb
             FROM kortix.session_sandboxes s
             LEFT JOIN kortix.sandbox_compute_sessions c ON c.sandbox_id = s.sandbox_id
             WHERE s.session_id = $1`,
            [session.id],
          );
          last = result.rows;
          if (result.rows.some((r) => r.compute_id)) return;
          await new Promise((resolve) => setTimeout(resolve, 3_000));
        }
        throw new Error(`no sandbox_compute_sessions row opened: ${JSON.stringify(last)}`);
      });
    } finally {
      await db.end();
    }
  },
);
