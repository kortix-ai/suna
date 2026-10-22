import { flow } from '../core/flow';
import { createDatabaseSession } from '../fixtures/database-project';
import { withDb } from '../fixtures/chat';
import { waitFor } from '../core/poll';

flow(
  'COST-1',
  {
    domain: 'billing',
    requires: ['funded', 'sandbox'],
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
    requires: ['funded', 'sandbox'],
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
    requires: ['funded', 'sandbox', 'database'],
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

// COST-4 — account-wide usage reads need `billing.read` for every credential
// class. An account-bound token alone is not authority: a service account with
// no role assignment is denied. A project-filtered read stays on the project.
flow(
  'COST-4',
  {
    domain: 'billing',
    requires: ['database'],
    routes: [
      'GET /v1/usage/cost-summary',
      'GET /v1/usage/cost-by-project',
      'GET /v1/usage/session-costs',
      'GET /v1/usage/session-costs/:sessionId',
      'GET /v1/usage',
      'POST /v1/accounts/tokens',
      'POST /v1/accounts/:accountId/iam/service-accounts',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const otherProject = await (await ctx.fixtures.team()).project();
    const member = await team.addMember('member');
    const reads = ['/v1/usage/cost-summary', '/v1/usage/cost-by-project', '/v1/usage/session-costs', '/v1/usage'] as const;

    await ctx.step('service account with zero role assignments cannot read account-wide usage → 403', async () => {
      const sa = await ctx.client.as(ctx.P.OWNER).post(
        '/v1/accounts/:accountId/iam/service-accounts',
        { name: ctx.fixtures.name('cost4-sa') },
        { params: { accountId: team.id } },
      );
      sa.status(201);
      const c = ctx.client.withBearer(sa.json<{ secret: string }>().secret, 'COST-4-SA');
      for (const path of reads) (await c.get(path)).status(403);
    });
    await ctx.step('member PAT (billing.read) still reads account usage → 200; foreign project filter → 403/404', async () => {
      const created = await ctx.client.as(member).post('/v1/accounts/tokens', {
        name: ctx.fixtures.name('cost4-pat'),
        account_id: team.id,
      });
      created.status(201);
      const c = ctx.client.withBearer(created.json<{ secret_key: string }>().secret_key, 'COST-4-PAT');
      for (const path of reads) (await c.get(path)).status(200);
      (await c.get('/v1/usage/session-costs', { query: { project_id: otherProject.id } })).status([403, 404]);
    });
    await ctx.step(
      "session costs name each owner: a plain member lists only their own sessions, another owner's costs → 403 and their session → 404; the owner sees both (MEM-8)",
      async () => {
        const project = await team.project();
        await team.grantProjectRole(project.id, member.userId!, 'member');
        const mine = await createDatabaseSession(ctx.env, { projectId: project.id, accountId: team.id, userId: member.userId! });
        const theirs = await createDatabaseSession(ctx.env, { projectId: project.id, accountId: team.id, userId: ctx.P.OWNER.userId! });
        const asMember = ctx.client.as(member);
        type Rows = { sessions: Array<{ session_id: string; owner_id: string | null }> };
        for (const scope of [{ account_id: team.id }, { project_id: project.id }]) {
          const rows = (await asMember.get('/v1/usage/session-costs', { query: { ...scope, limit: '100' } }))
            .status(200)
            .json<Rows>().sessions;
          const ids = rows.map((r) => r.session_id);
          if (!ids.includes(mine) || ids.includes(theirs) || rows.some((r) => r.owner_id !== member.userId)) {
            throw new Error(`a plain member's session costs must hold only their own sessions: ${JSON.stringify(rows)}`);
          }
        }
        (await asMember.get('/v1/usage/session-costs', { query: { account_id: team.id, owner_id: ctx.P.OWNER.userId! } })).status(403);
        const detail = '/v1/usage/session-costs/:sessionId';
        (await asMember.get(detail, { params: { sessionId: theirs }, query: { project_id: project.id } })).status(404);
        (await asMember.get(detail, { params: { sessionId: mine }, query: { project_id: project.id } })).status(200);
        const all = (await ctx.client.as(ctx.P.OWNER).get('/v1/usage/session-costs', { query: { project_id: project.id, limit: '100' } }))
          .status(200)
          .json<Rows>()
          .sessions.map((r) => r.session_id);
        if (!all.includes(mine) || !all.includes(theirs)) throw new Error(`the owner must list both sessions: ${JSON.stringify(all)}`);
      },
    );
    await ctx.step(
      'cost-by-project lists only the projects the caller can read: a plain member sees their project and not one they are not in; the owner sees both; project_id narrows the owner to that one project; a member naming a project they cannot read gets 403',
      async () => {
        const theirs = await team.project();
        const notTheirs = await team.project();
        await team.grantProjectRole(theirs.id, member.userId!, 'member');
        // One zero-cost gateway row per project: a project with no spend row is never listed.
        await withDb(ctx, (db) =>
          db.query(
            `INSERT INTO kortix.gateway_request_logs
               (request_id, account_id, project_id, requested_model, resolved_model, provider, status, ok)
             SELECT 'cost4-' || p, $1::uuid, p, 'ke2e', 'ke2e', 'ke2e', 200, true FROM unnest($2::uuid[]) AS p`,
            [team.id, [theirs.id, notTheirs.id]],
          ),
        );
        type Page = { projects: Array<{ project_id: string }>; total: number };
        const ids = async (as: ReturnType<typeof ctx.client.as>) => {
          const page = (await as.get('/v1/usage/cost-by-project', { query: { account_id: team.id, limit: '100' } }))
            .status(200)
            .json<Page>();
          if (page.total !== page.projects.length) throw new Error(`total ${page.total} must count only listed rows`);
          return page.projects.map((r) => r.project_id);
        };
        // IAM verdicts are cached for up to 15 s: the fresh project grant can read the old answer first.
        const memberIds = await waitFor(() => ids(ctx.client.as(member)), {
          until: (list) => list.includes(theirs.id),
          timeoutMs: 20_000,
          intervalMs: 1_000,
          description: "the member's own project in cost-by-project",
        });
        if (memberIds.includes(notTheirs.id)) {
          throw new Error(`a plain member must not see a project they cannot read: ${JSON.stringify(memberIds)}`);
        }
        const ownerIds = await ids(ctx.client.as(ctx.P.OWNER));
        if (!ownerIds.includes(theirs.id) || !ownerIds.includes(notTheirs.id)) {
          throw new Error(`the owner must see every project: ${JSON.stringify(ownerIds)}`);
        }
        // KRTX-2801: the declared project_id filter applies to an account-wide caller too.
        const narrowed = (await ctx.client.as(ctx.P.OWNER).get('/v1/usage/cost-by-project', {
          query: { account_id: team.id, project_id: theirs.id },
        }))
          .status(200)
          .json<Page>();
        if (narrowed.total !== 1 || narrowed.projects.map((r) => r.project_id).join() !== theirs.id) {
          throw new Error(`project_id must narrow the rollup to ${theirs.id}: ${JSON.stringify(narrowed)}`);
        }
        (await ctx.client.as(member).get('/v1/usage/cost-by-project', { query: { account_id: team.id, project_id: notTheirs.id } }))
          .status(403)
          .body()
          .has('$.code', 'no_project_membership');
      },
    );
    await ctx.step('OWNER JWT still reads account usage → 200', async () => {
      const owner = ctx.client.as(ctx.P.OWNER);
      (await owner.get('/v1/usage/cost-summary', { query: { account_id: team.id } })).status(200);
    });
  },
);
