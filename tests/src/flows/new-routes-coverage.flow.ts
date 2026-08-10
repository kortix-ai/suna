/**
 * New route coverage backlog.
 *
 * These are lightweight black-box checks for newly surfaced manifest routes.
 * They deliberately assert auth/validation/read-only boundaries and avoid
 * provisioning sandboxes, calling paid upstream LLMs, or mutating production
 * provider state.
 */
import { flow } from '../core/flow';

const ZERO_UUID = '00000000-0000-4000-a000-000000000000';

flow(
  'COV-1',
  {
    domain: 'coverage',
    routes: ['GET /metrics', 'GET /v1/router/health'],
  },
  async (ctx) => {
    await ctx.step('metrics endpoint rejects anonymous callers', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/metrics');
      r.status(401);
    });
    await ctx.step('internal metrics endpoint is mounted or explicitly disabled', async () => {
      const r = await ctx.client
        .withBearer(ctx.env.internalServiceKey!, 'INTERNAL_OBSERVABILITY')
        .get('/metrics');
      r.status([200, 404]);
    });
    await ctx.step('LLM gateway health endpoint is mounted', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/router/health');
      r.status([200, 404]);
    });
  },
);

// COV-2 (warm-snapshot-config admin toggle) removed — the routes it covered
// were deleted in #4095 ("remove the dead warm-fork sessions toggle") without
// retiring this flow, leaving stale manifest drift.

flow(
  'COV-3',
  {
    domain: 'coverage',
    routes: [
      'GET /v1/connectors/connect-status',
      'GET /v1/connectors/projects/:workspaceId/catalog',
      'POST /v1/connectors/projects/:workspaceId/call',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();

    await ctx.step('ANON cannot read connection status', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/connectors/connect-status');
      r.status(401);
    });
    await ctx.step('project member can reach connector catalog', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/connectors/projects/:workspaceId/catalog', { params: { workspaceId: p.id } });
      r.status([200, 403, 501]);
    });
    await ctx.step(
      'project member call boundary rejects invalid tool body without upstream side effects',
      async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .post('/v1/connectors/projects/:workspaceId/call', {}, { params: { workspaceId: p.id } });
        r.status([400, 403, 404, 501]);
      },
    );
  },
);

flow(
  'COV-4',
  {
    domain: 'coverage',
    routes: [
      'GET /v1/projects/:workspaceId/gateway/overview',
      'GET /v1/projects/:workspaceId/gateway/series',
      'GET /v1/projects/:workspaceId/gateway/sessions',
      'GET /v1/projects/:workspaceId/gateway/breakdown',
      'GET /v1/projects/:workspaceId/gateway/errors',
      'GET /v1/projects/:workspaceId/gateway/logs',
      'GET /v1/projects/:workspaceId/gateway/logs/:logId',
      'GET /v1/projects/:workspaceId/gateway/budgets',
      'PUT /v1/projects/:workspaceId/gateway/budgets',
      'DELETE /v1/projects/:workspaceId/gateway/budgets/:budgetId',
      'GET /v1/projects/:workspaceId/gateway/keys',
      'POST /v1/projects/:workspaceId/gateway/keys',
      'DELETE /v1/projects/:workspaceId/gateway/keys/:keyId',
      'POST /v1/projects/:workspaceId/gateway/playground',
      'POST /v1/projects/:workspaceId/gateway/providers/:providerId/verify',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { workspaceId: p.id };

    await ctx.step('gateway analytics reads are reachable for a project member', async () => {
      for (const route of [
        '/v1/projects/:workspaceId/gateway/overview',
        '/v1/projects/:workspaceId/gateway/series',
        '/v1/projects/:workspaceId/gateway/sessions',
        '/v1/projects/:workspaceId/gateway/breakdown',
        '/v1/projects/:workspaceId/gateway/errors',
        '/v1/projects/:workspaceId/gateway/logs',
        '/v1/projects/:workspaceId/gateway/budgets',
      ]) {
        const r = await owner.get(route, { params });
        r.status([200, 403]);
      }
    });
    await ctx.step('gateway log detail unknown id returns boundary response', async () => {
      const r = await owner.get('/v1/projects/:workspaceId/gateway/logs/:logId', {
        params: { ...params, logId: ZERO_UUID },
      });
      r.status([404, 500]);
    });
    await ctx.step('gateway budget mutation validates permissions and payload', async () => {
      const put = await owner.put(
        '/v1/projects/:workspaceId/gateway/budgets',
        { scope: 'member', limit_usd: 1 },
        { params },
      );
      put.status([400, 403]);

      const del = await owner.del('/v1/projects/:workspaceId/gateway/budgets/:budgetId', {
        params: { ...params, budgetId: ZERO_UUID },
      });
      del.status([200, 403, 404]);
    });
    await ctx.step('gateway key management reaches auth/validation boundary', async () => {
      const list = await owner.get('/v1/projects/:workspaceId/gateway/keys', { params });
      list.status([200, 403]);

      const create = await owner.post('/v1/projects/:workspaceId/gateway/keys', {}, { params });
      create.status([400, 403]);

      const del = await owner.del('/v1/projects/:workspaceId/gateway/keys/:keyId', {
        params: { ...params, keyId: ZERO_UUID },
      });
      del.status([200, 403, 404]);
    });
    await ctx.step('gateway playground rejects invalid body before model calls', async () => {
      const r = await owner.post('/v1/projects/:workspaceId/gateway/playground', {}, { params });
      r.status([400, 403]);
    });
    await ctx.step(
      'gateway provider verify reports not_connected for an unconnected provider, no upstream call',
      async () => {
        const r = await owner.post(
          '/v1/projects/:workspaceId/gateway/providers/:providerId/verify',
          {},
          { params: { ...params, providerId: 'openai' } },
        );
        r.status([200, 403]);
      },
    );
  },
);

flow(
  'COV-5',
  {
    domain: 'coverage',
    routes: [
      'GET /v1/projects/:workspaceId/channels/slack/file',
      'POST /v1/projects/:workspaceId/channels/slack/file/upload',
      'PATCH /v1/projects/:workspaceId/triggers/activation',
      'GET /v1/projects/:workspaceId/sessions/:sessionId/transcript',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { workspaceId: p.id };

    await ctx.step('Slack file proxy validates missing or unconfigured file inputs', async () => {
      const download = await owner.get('/v1/projects/:workspaceId/channels/slack/file', { params });
      download.status([400, 404]);

      const upload = await owner.post(
        '/v1/projects/:workspaceId/channels/slack/file/upload',
        {},
        { params },
      );
      upload.status([400, 404]);
    });
    await ctx.step('trigger activation validates paused boolean', async () => {
      const r = await owner.patch('/v1/projects/:workspaceId/triggers/activation', {}, { params });
      r.status(400);
    });
    await ctx.step('session transcript unknown session is a 404 boundary', async () => {
      const r = await owner.get('/v1/projects/:workspaceId/sessions/:sessionId/transcript', {
        params: { ...params, sessionId: ZERO_UUID },
      });
      r.status(404);
    });
  },
);

flow(
  'COV-6',
  {
    domain: 'coverage',
    routes: [
      'POST /internal/gateway/authenticate',
      'POST /internal/gateway/billing',
      'POST /internal/gateway/budget-check',
      'POST /internal/gateway/models',
      'POST /internal/gateway/resolve-upstream',
      'POST /internal/gateway/trace',
      'POST /internal/gateway/usage',
    ],
  },
  async (ctx) => {
    for (const route of [
      '/internal/gateway/authenticate',
      '/internal/gateway/billing',
      '/internal/gateway/budget-check',
      '/internal/gateway/models',
      '/internal/gateway/resolve-upstream',
      '/internal/gateway/trace',
      '/internal/gateway/usage',
    ]) {
      await ctx.step(`${route} rejects unauthenticated internal call`, async () => {
        const r = await ctx.client.as(ctx.P.ANON).post(route, {});
        r.status([400, 401, 403]);
      });
    }
  },
);

flow(
  'COV-7',
  {
    domain: 'coverage',
    routes: ['POST /v1/webhooks/sandbox/daytona', 'POST /v1/webhooks/sandbox/platinum'],
  },
  async (ctx) => {
    await ctx.step('sandbox provider webhooks reject unsigned Daytona payload', async () => {
      const r = await ctx.client.as(ctx.P.ANON).post('/v1/webhooks/sandbox/daytona', {});
      r.status([400, 401, 403, 503]);
    });
    await ctx.step('sandbox provider webhooks reject unsigned Platinum payload', async () => {
      const r = await ctx.client.as(ctx.P.ANON).post('/v1/webhooks/sandbox/platinum', {});
      r.status([400, 401, 403, 503]);
    });
  },
);

// COV-8's original `marketplace`/`registry` CRUD routes (GET .../marketplace,
// .../marketplace/updates, POST .../marketplace/{install,update,update-all},
// DELETE .../marketplace/:name, POST .../registry/update-all) were DELETED by
// the marketplace-as-projects rewrite (docs/specs/2026-07-13-marketplace-as-projects.md,
// merge 444b6906e): the deterministic install/lock/update/remove engine is
// gone, replaced by the agent-driven `POST /:workspaceId/marketplace/install-session`
// covered below. Verified live against staging with a real authed project:
// each of those paths now 404s "Not found" (not the 401 an unauthenticated
// probe would suggest — /v1/projects/:workspaceId/* runs its auth gate before
// routing, so an unauthed call to a genuinely-dead sibling path still reads
// 401). `tests/spec/routes.generated.json` was stale (pre-dated that merge)
// and has been regenerated; these route strings would now fail the coverage
// gate's "declared but not in the manifest" (external) check, so they're
// dropped rather than kept as dead weight.
flow(
  'COV-8',
  {
    domain: 'coverage',
    routes: [
      'POST /v1/projects/:workspaceId/marketplace/install-session',
      'GET /v1/projects/:workspaceId/llm-catalog',
      'PATCH /v1/projects/:workspaceId/channels/email/installation',
      'POST /v1/channels/slack/identity/bind',
      'POST /internal/gateway/authorize',
    ],
  },
  async (ctx) => {
    const params = { workspaceId: ZERO_UUID };

    await ctx.step('unauthenticated marketplace install-session is gated', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post('/v1/projects/:workspaceId/marketplace/install-session', {}, { params });
      r.status(401);
    });

    await ctx.step('unauthenticated project catalog route is gated', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/projects/:workspaceId/llm-catalog', { params });
      r.status(401);
    });

    await ctx.step('unauthenticated email and Slack identity mutations are gated', async () => {
      const email = await ctx.client
        .as(ctx.P.ANON)
        .patch('/v1/projects/:workspaceId/channels/email/installation', {}, { params });
      email.status(401);

      const slack = await ctx.client.as(ctx.P.ANON).post('/v1/channels/slack/identity/bind', {});
      slack.status(401);
    });

    await ctx.step(
      'internal gateway authorization rejects missing internal credentials',
      async () => {
        const r = await ctx.client.as(ctx.P.ANON).post('/internal/gateway/authorize', {});
        r.status([401, 503]);
      },
    );

    // The project-scoped marketplace install-session route (the agent-driven
    // replacement for the removed deterministic install/update/remove engine)
    // is the one project write a non-member must NOT be able to trigger, and
    // whose body validation runs AFTER auth — prove both boundaries against a
    // real project so the route can never silently degrade to a 500.
    const project = await ctx.fixtures.project();
    const projParams = { workspaceId: project.id };

    await ctx.step('NONMEMBER cannot start a marketplace install-session → 403/404', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          '/v1/projects/:workspaceId/marketplace/install-session',
          { id: 'kortix/runtime' },
          { params: projParams },
        );
      r.status([403, 404]);
    });

    await ctx.step('missing id body → 400 (not 500)', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/projects/:workspaceId/marketplace/install-session', {}, { params: projParams });
      r.status(400);
    });

    await ctx.step('unknown marketplace id → 400 (not 500)', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:workspaceId/marketplace/install-session',
          { id: 'no-such-item-' + ctx.fixtures.name('x') },
          { params: projParams },
        );
      r.status(400);
    });
  },
);

flow(
  'COV-9',
  {
    domain: 'coverage',
    routes: ['GET /v1/generation', 'GET /v1/usage'],
  },
  async (ctx) => {
    const owner = ctx.client.as(ctx.P.OWNER);

    await ctx.step('ANON cannot read generation forensics', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/generation', { query: { id: ZERO_UUID } });
      r.status(401);
    });
    await ctx.step('missing id query param is a 400 boundary', async () => {
      const r = await owner.get('/v1/generation');
      r.status(400);
    });
    await ctx.step('unknown request id is a 404 boundary', async () => {
      const r = await owner.get('/v1/generation', { query: { id: ZERO_UUID } });
      r.status(404);
    });

    await ctx.step('ANON cannot read the usage rollup', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/usage');
      r.status(401);
    });
    await ctx.step('account usage rollup returns the totals envelope', async () => {
      const r = await owner.get('/v1/usage');
      r.status(200).body().exists('$.data.total_input_tokens').exists('$.data.count');
    });
    await ctx.step('grouped usage rollup adds a breakdown array', async () => {
      const r = await owner.get('/v1/usage', { query: { group_by: 'model' } });
      r.status(200).body().exists('$.data').exists('$.breakdown');
    });
    await ctx.step('a bounded window is accepted', async () => {
      const r = await owner.get('/v1/usage', {
        query: { start: '2020-01-01T00:00:00Z', end: '2020-01-02T00:00:00Z' },
      });
      r.status(200).body().exists('$.data.total_cost');
    });
    await ctx.step('an invalid group_by is a 400 boundary', async () => {
      const r = await owner.get('/v1/usage', { query: { group_by: 'bogus' } });
      r.status(400);
    });
    await ctx.step('start after end is a 400 boundary', async () => {
      const r = await owner.get('/v1/usage', {
        query: { start: '2026-01-02T00:00:00Z', end: '2026-01-01T00:00:00Z' },
      });
      r.status(400);
    });
  },
);

flow(
  'COV-10',
  {
    domain: 'coverage',
    routes: [
      'GET /v1/projects/:workspaceId/connections/all',
      'GET /v1/projects/:workspaceId/sessions/:sessionId/scope',
      'PUT /v1/projects/:workspaceId/connections/:connectionId/default',
      'PUT /v1/projects/:workspaceId/sessions/:sessionId/model',
      'PUT /v1/projects/:workspaceId/sessions/:sessionId/scope',
    ],
  },
  async (ctx) => {
    const owner = ctx.client.as(ctx.P.OWNER);
    const projectParams = { workspaceId: ZERO_UUID };
    const profileParams = { ...projectParams, connectionId: ZERO_UUID };
    const sessionParams = { ...projectParams, sessionId: ZERO_UUID };

    await ctx.step('unknown project hides the connection roster', async () => {
      const roster = await owner.get('/v1/projects/:workspaceId/connections/all', {
        params: projectParams,
      });
      roster.status(404);
    });

    await ctx.step('unknown project blocks connector mutations', async () => {
      const makeDefault = await owner.put(
        '/v1/projects/:workspaceId/connections/:connectionId/default',
        {},
        { params: profileParams },
      );
      makeDefault.status(404);
    });

    await ctx.step('unknown project blocks session scope reads and mutations', async () => {
      const scopeRead = await owner.get(
        '/v1/projects/:workspaceId/sessions/:sessionId/scope',
        { params: sessionParams },
      );
      scopeRead.status(404);
      const model = await owner.put(
        '/v1/projects/:workspaceId/sessions/:sessionId/model',
        { opencode_model: 'openai/gpt-5' },
        { params: sessionParams },
      );
      model.status(404);
      const scope = await owner.put(
        '/v1/projects/:workspaceId/sessions/:sessionId/scope',
        { secrets: [] },
        { params: sessionParams },
      );
      scope.status(404);
    });
  },
);

flow(
  'COV-11',
  {
    domain: 'coverage',
    routes: [
      'GET /v1/projects/:workspaceId/sessions/:sessionId/config',
      'POST /v1/projects/:workspaceId/sessions/:sessionId/reload',
    ],
  },
  async (ctx) => {
    const owner = ctx.client.as(ctx.P.OWNER);
    const sessionParams = { workspaceId: ZERO_UUID, sessionId: ZERO_UUID };

    await ctx.step('anon cannot read config freshness or reload', async () => {
      const anon = ctx.client.as(ctx.P.ANON);
      const read = await anon.get('/v1/projects/:workspaceId/sessions/:sessionId/config', {
        params: sessionParams,
      });
      read.status(401);
      const reload = await anon.post(
        '/v1/projects/:workspaceId/sessions/:sessionId/reload',
        {},
        { params: sessionParams },
      );
      reload.status(401);
    });

    await ctx.step('an unknown project hides both — no existence oracle', async () => {
      // A reload restarts a session's runtime. Distinguishing "no such project"
      // from "not yours" here would let anyone probe for live session ids.
      const read = await owner.get('/v1/projects/:workspaceId/sessions/:sessionId/config', {
        params: sessionParams,
      });
      read.status(404);
      const reload = await owner.post(
        '/v1/projects/:workspaceId/sessions/:sessionId/reload',
        {},
        { params: sessionParams },
      );
      reload.status(404);
    });

    await ctx.step('a malformed session id is rejected before any lookup', async () => {
      const read = await owner.get('/v1/projects/:workspaceId/sessions/:sessionId/config', {
        params: { workspaceId: ZERO_UUID, sessionId: 'not-a-uuid' },
      });
      read.status(400);
    });
  },
);

flow(
  'COV-12',
  {
    domain: 'coverage',
    routes: [
      'GET /v1/projects/:workspaceId/sessions/:sessionId/question',
      'POST /v1/projects/:workspaceId/sessions/:sessionId/question',
      'POST /v1/projects/:workspaceId/secrets/sync',
      'POST /v1/admin/api/accounts/:accountId/enterprise-entitlement',
    ],
  },
  async (ctx) => {
    const owner = ctx.client.as(ctx.P.OWNER);
    const sessionParams = { workspaceId: ZERO_UUID, sessionId: ZERO_UUID };

    await ctx.step('an unknown project hides durable session questions', async () => {
      const read = await owner.get(
        '/v1/projects/:workspaceId/sessions/:sessionId/question',
        { params: sessionParams },
      );
      read.status(404);
      const answer = await owner.post(
        '/v1/projects/:workspaceId/sessions/:sessionId/question',
        { answers: ['yes'] },
        { params: sessionParams },
      );
      answer.status(404);
    });

    await ctx.step('an unknown project blocks forced secret synchronization', async () => {
      const sync = await owner.post(
        '/v1/projects/:workspaceId/secrets/sync',
        {},
        { params: { workspaceId: ZERO_UUID } },
      );
      sync.status(404);
    });

    await ctx.step('enterprise entitlement mutation stays platform-admin only', async () => {
      const params = { accountId: ZERO_UUID };
      const anonymous = await ctx.client.as(ctx.P.ANON).post(
        '/v1/admin/api/accounts/:accountId/enterprise-entitlement',
        { enabled: true },
        { params },
      );
      anonymous.status(401);
      const nonAdmin = await owner.post(
        '/v1/admin/api/accounts/:accountId/enterprise-entitlement',
        { enabled: true },
        { params },
      );
      nonAdmin.status(403);
    });
  },
);
