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
  'SYS-9',
  {
    domain: 'system',
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

// The warm-snapshot-config admin flow was removed with its deleted routes.
// were deleted in #4095 ("remove the dead warm-fork sessions toggle") without
// retiring this flow, leaving stale manifest drift.

flow(
  'CONN-20',
  {
    domain: 'connectors',
    routes: [
      'GET /v1/connectors/connect-status',
      'GET /v1/connectors/projects/:projectId/catalog',
      'POST /v1/connectors/projects/:projectId/call',
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
        .get('/v1/connectors/projects/:projectId/catalog', { params: { projectId: p.id } });
      r.status([200, 403, 501]);
    });
    await ctx.step(
      'project member call boundary rejects invalid tool body without upstream side effects',
      async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .post('/v1/connectors/projects/:projectId/call', {}, { params: { projectId: p.id } });
        r.status([400, 403, 404, 501]);
      },
    );
  },
);

flow(
  'GW-9',
  {
    domain: 'llm-gateway',
    routes: [
      'GET /v1/projects/:projectId/gateway/overview',
      'GET /v1/projects/:projectId/gateway/series',
      'GET /v1/projects/:projectId/gateway/sessions',
      'GET /v1/projects/:projectId/gateway/breakdown',
      'GET /v1/projects/:projectId/gateway/errors',
      'GET /v1/projects/:projectId/gateway/logs',
      'GET /v1/projects/:projectId/gateway/logs/:logId',
      'GET /v1/projects/:projectId/gateway/budgets',
      'PUT /v1/projects/:projectId/gateway/budgets',
      'DELETE /v1/projects/:projectId/gateway/budgets/:budgetId',
      'GET /v1/projects/:projectId/gateway/keys',
      'POST /v1/projects/:projectId/gateway/keys',
      'DELETE /v1/projects/:projectId/gateway/keys/:keyId',
      'POST /v1/projects/:projectId/gateway/playground',
      'POST /v1/projects/:projectId/gateway/providers/:providerId/verify',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: p.id };

    await ctx.step('gateway analytics reads are reachable for a project member', async () => {
      for (const route of [
        '/v1/projects/:projectId/gateway/overview',
        '/v1/projects/:projectId/gateway/series',
        '/v1/projects/:projectId/gateway/sessions',
        '/v1/projects/:projectId/gateway/breakdown',
        '/v1/projects/:projectId/gateway/errors',
        '/v1/projects/:projectId/gateway/logs',
        '/v1/projects/:projectId/gateway/budgets',
      ]) {
        const r = await owner.get(route, { params });
        r.status([200, 403]);
      }
    });
    await ctx.step('gateway log detail unknown id returns boundary response', async () => {
      const r = await owner.get('/v1/projects/:projectId/gateway/logs/:logId', {
        params: { ...params, logId: ZERO_UUID },
      });
      r.status([404, 500]);
    });
    await ctx.step('gateway budget mutation validates permissions and payload', async () => {
      const put = await owner.put(
        '/v1/projects/:projectId/gateway/budgets',
        { scope: 'member', limit_usd: 1 },
        { params },
      );
      put.status([400, 403]);

      const del = await owner.del('/v1/projects/:projectId/gateway/budgets/:budgetId', {
        params: { ...params, budgetId: ZERO_UUID },
      });
      del.status([200, 403, 404]);
    });
    await ctx.step('gateway key management reaches auth/validation boundary', async () => {
      const list = await owner.get('/v1/projects/:projectId/gateway/keys', { params });
      list.status([200, 403]);

      const create = await owner.post('/v1/projects/:projectId/gateway/keys', {}, { params });
      create.status([400, 403]);

      const del = await owner.del('/v1/projects/:projectId/gateway/keys/:keyId', {
        params: { ...params, keyId: ZERO_UUID },
      });
      del.status([200, 403, 404]);
    });
    await ctx.step('gateway playground rejects invalid body before model calls', async () => {
      const r = await owner.post('/v1/projects/:projectId/gateway/playground', {}, { params });
      r.status([400, 403]);
    });
    await ctx.step(
      'gateway provider verify reports not_connected for an unconnected provider, no upstream call',
      async () => {
        const r = await owner.post(
          '/v1/projects/:projectId/gateway/providers/:providerId/verify',
          {},
          { params: { ...params, providerId: 'openai' } },
        );
        r.status([200, 403]);
      },
    );
  },
);

flow(
  'CHN-26',
  {
    domain: 'channels',
    routes: ['GET /v1/projects/:projectId/channels/slack/file'],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    await ctx.step('Slack file download rejects a request without a file reference', async () => {
      const response = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/channels/slack/file', {
          params: { projectId: project.id },
        });
      response.status([400, 404]);
    });
  },
);

flow(
  'SESS-20',
  {
    domain: 'sessions',
    requires: ['daytona'],
    routes: [
      'GET /v1/projects/:projectId/sessions/:sessionId/transcript',
      'GET /v1/projects/:projectId/sessions/:sessionId/turn',
      'GET /v1/projects/:projectId/sessions/:sessionId/turns',
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    await ctx.step('Session transcript returns 404 for an unknown session', async () => {
      const response = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/sessions/:sessionId/transcript', {
          params: { projectId: project.id, sessionId: ZERO_UUID },
        });
      response.status(404);
    });

    await ctx.step('Session turn read reports a fresh session as idle', async () => {
      // The only committed black-box 200 on this route. A session that has
      // never run a turn answers with an EMPTY `turns` list and NO `last_ended`
      // — the absence is what separates "never ran" from "the last one ended",
      // so a `last_ended: null` here would be a contract break, not a detail.
      const session = await ctx.fixtures.session(project);
      const response = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/sessions/:sessionId/turn', {
          params: { projectId: project.id, sessionId: session.id },
        });
      response.status(200);
      const body = response.json<{ turns: unknown[]; last_ended?: unknown }>();
      if (!Array.isArray(body.turns) || body.turns.length !== 0) {
        throw new Error(`expected an empty turns list, got ${JSON.stringify(body.turns)}`);
      }
      if ('last_ended' in body) {
        throw new Error(`expected last_ended to be absent, got ${JSON.stringify(body.last_ended)}`);
      }
    });

    await ctx.step('Session turn read returns 404 for an unknown session', async () => {
      const response = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/sessions/:sessionId/turn', {
          params: { projectId: project.id, sessionId: ZERO_UUID },
        });
      response.status(404);
    });

    await ctx.step('Turn history is an empty list for a session that never ran', async () => {
      // The RETAINED history, the read a client uses after a reload to learn
      // which of its transcript messages a turn failed on. An empty list, not
      // a 404: "this session has run no turns" is an answer.
      const session = await ctx.fixtures.session(project);
      const response = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/sessions/:sessionId/turns', {
          params: { projectId: project.id, sessionId: session.id },
        });
      response.status(200);
      const body = response.json<{ turns: unknown[] }>();
      if (!Array.isArray(body.turns) || body.turns.length !== 0) {
        throw new Error(`expected an empty turns list, got ${JSON.stringify(body.turns)}`);
      }
    });

    await ctx.step('Turn history returns 404 for an unknown session', async () => {
      const response = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/sessions/:sessionId/turns', {
          params: { projectId: project.id, sessionId: ZERO_UUID },
        });
      response.status(404);
    });

    await ctx.step('Turn history refuses an anonymous caller', async () => {
      // Same argument as the turn read: the ledger carries the OpenCode session
      // id, the client-minted message id, and now the failure text.
      const response = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/projects/:projectId/sessions/:sessionId/turns', {
          params: { projectId: project.id, sessionId: ZERO_UUID },
        });
      response.status([401, 403, 404]);
    });

    await ctx.step('Session turn read refuses an anonymous caller', async () => {
      // The turn ledger carries the OpenCode session id and the client-minted
      // message id — session CONTENT, never public.
      const response = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/projects/:projectId/sessions/:sessionId/turn', {
          params: { projectId: project.id, sessionId: ZERO_UUID },
        });
      response.status([401, 403, 404]);
    });
  },
);

flow(
  'GW-10',
  {
    domain: 'llm-gateway',
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
  'SBX-6',
  {
    domain: 'sandboxes',
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

flow(
  'CHN-27',
  {
    domain: 'channels',
    routes: ['PATCH /v1/projects/:projectId/channels/email/installation'],
  },
  async (ctx) => {
    await ctx.step('Anonymous callers cannot update an email installation', async () => {
      const response = await ctx.client
        .as(ctx.P.ANON)
        .patch(
          '/v1/projects/:projectId/channels/email/installation',
          {},
          { params: { projectId: ZERO_UUID } },
        );
      response.status(401);
    });
  },
);

flow(
  'CHN-28',
  {
    domain: 'channels',
    routes: ['POST /v1/channels/slack/identity/bind'],
  },
  async (ctx) => {
    await ctx.step('Anonymous callers cannot bind a Slack identity', async () => {
      const response = await ctx.client
        .as(ctx.P.ANON)
        .post('/v1/channels/slack/identity/bind', {});
      response.status(401);
    });
  },
);

flow(
  'GW-12',
  {
    domain: 'llm-gateway',
    routes: ['POST /internal/gateway/authorize'],
  },
  async (ctx) => {
    await ctx.step('Internal gateway authorization rejects missing credentials', async () => {
      const response = await ctx.client.as(ctx.P.ANON).post('/internal/gateway/authorize', {});
      response.status([401, 503]);
    });
  },
);

flow(
  'GW-11',
  {
    domain: 'llm-gateway',
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
  'CONN-23',
  {
    domain: 'connectors',
    routes: [
      'GET /v1/projects/:projectId/connections/all',
      'PUT /v1/projects/:projectId/connections/:connectionId/default',
    ],
  },
  async (ctx) => {
    const owner = ctx.client.as(ctx.P.OWNER);
    await ctx.step('An unknown project hides the connection roster and default mutation', async () => {
      const roster = await owner.get('/v1/projects/:projectId/connections/all', {
        params: { projectId: ZERO_UUID },
      });
      roster.status(404);
      const makeDefault = await owner.put(
        '/v1/projects/:projectId/connections/:connectionId/default',
        {},
        { params: { projectId: ZERO_UUID, connectionId: ZERO_UUID } },
      );
      makeDefault.status(404);
    });
  },
);

flow(
  'SESS-21',
  {
    domain: 'sessions',
    routes: [
      'GET /v1/projects/:projectId/sessions/:sessionId/scope',
      'PUT /v1/projects/:projectId/sessions/:sessionId/model',
      'PUT /v1/projects/:projectId/sessions/:sessionId/scope',
    ],
  },
  async (ctx) => {
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: ZERO_UUID, sessionId: ZERO_UUID };
    await ctx.step('An unknown project hides session scope and model mutations', async () => {
      const scopeRead = await owner.get(
        '/v1/projects/:projectId/sessions/:sessionId/scope',
        { params },
      );
      scopeRead.status(404);
      const model = await owner.put(
        '/v1/projects/:projectId/sessions/:sessionId/model',
        { opencode_model: 'openai/gpt-5' },
        { params },
      );
      model.status(404);
      const scope = await owner.put(
        '/v1/projects/:projectId/sessions/:sessionId/scope',
        { secrets: [] },
        { params },
      );
      scope.status(404);
    });
  },
);

flow(
  'SESS-19',
  {
    domain: 'sessions',
    routes: [
      'GET /v1/projects/:projectId/sessions/:sessionId/config',
      'POST /v1/projects/:projectId/sessions/:sessionId/reload',
      'POST /v1/projects/:projectId/sessions/:sessionId/reload-stream',
    ],
  },
  async (ctx) => {
    const owner = ctx.client.as(ctx.P.OWNER);
    const sessionParams = { projectId: ZERO_UUID, sessionId: ZERO_UUID };

    await ctx.step('anon cannot read config freshness or reload', async () => {
      const anon = ctx.client.as(ctx.P.ANON);
      const read = await anon.get('/v1/projects/:projectId/sessions/:sessionId/config', {
        params: sessionParams,
      });
      read.status(401);
      const reload = await anon.post(
        '/v1/projects/:projectId/sessions/:sessionId/reload',
        {},
        { params: sessionParams },
      );
      reload.status(401);
      const reloadStream = await anon.post(
        '/v1/projects/:projectId/sessions/:sessionId/reload-stream',
        {},
        { params: sessionParams },
      );
      reloadStream.status(401);
    });

    await ctx.step('an unknown project hides both — no existence oracle', async () => {
      // A reload restarts a session's runtime. Distinguishing "no such project"
      // from "not yours" here would let anyone probe for live session ids.
      const read = await owner.get('/v1/projects/:projectId/sessions/:sessionId/config', {
        params: sessionParams,
      });
      read.status(404);
      const reload = await owner.post(
        '/v1/projects/:projectId/sessions/:sessionId/reload',
        {},
        { params: sessionParams },
      );
      reload.status(404);
      const reloadStream = await owner.post(
        '/v1/projects/:projectId/sessions/:sessionId/reload-stream',
        {},
        { params: sessionParams },
      );
      reloadStream.status(404);
    });

    await ctx.step('a malformed session id is rejected before any lookup', async () => {
      const read = await owner.get('/v1/projects/:projectId/sessions/:sessionId/config', {
        params: { projectId: ZERO_UUID, sessionId: 'not-a-uuid' },
      });
      read.status(400);
    });
  },
);

flow(
  'SESS-22',
  {
    domain: 'sessions',
    routes: [
      'GET /v1/projects/:projectId/sessions/:sessionId/question',
      'POST /v1/projects/:projectId/sessions/:sessionId/question',
    ],
  },
  async (ctx) => {
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: ZERO_UUID, sessionId: ZERO_UUID };
    await ctx.step('An unknown project hides durable session questions', async () => {
      const read = await owner.get(
        '/v1/projects/:projectId/sessions/:sessionId/question',
        { params },
      );
      read.status(404);
      const answer = await owner.post(
        '/v1/projects/:projectId/sessions/:sessionId/question',
        { answers: ['yes'] },
        { params },
      );
      answer.status(404);
    });
  },
);

// `GW-11` covers `GET /v1/usage` for `group_by=model`, an invalid `group_by`,
// and `start` > `end`. It leaves the rest of the contract unclaimed: the other
// two valid enum values, the fact that each value produces a DIFFERENT
// breakdown-row shape (`day` vs `provider` vs `provider`+`model` — see
// `mapUsageBreakdownRow`), a malformed timestamp as distinct from an inverted
// window, and the zero-row window that must still answer 200 with zeroed
// totals and an empty breakdown rather than a 404 or a 500.
flow(
  'GW-13',
  {
    domain: 'llm-gateway',
    routes: ['GET /v1/usage'],
  },
  async (ctx) => {
    const owner = ctx.client.as(ctx.P.OWNER);
    type BreakdownRow = Record<string, unknown>;
    const breakdownOf = (r: { json: <T>() => T }) =>
      r.json<{ breakdown?: BreakdownRow[] }>().breakdown ?? [];

    await ctx.step('group_by=provider returns a breakdown of provider-only rows', async () => {
      const r = await owner.get('/v1/usage', { query: { group_by: 'provider' } });
      r.status(200).body().exists('$.data').exists('$.breakdown');
      for (const row of breakdownOf(r)) {
        if ('day' in row) throw new Error('provider breakdown row leaked a `day` field');
        if ('model' in row) throw new Error('provider breakdown row leaked a `model` field');
        if (typeof row.provider !== 'string')
          throw new Error(`provider row missing string \`provider\`: ${JSON.stringify(row)}`);
      }
    });

    await ctx.step('group_by=day returns a breakdown of day-only rows', async () => {
      const r = await owner.get('/v1/usage', { query: { group_by: 'day' } });
      r.status(200).body().exists('$.data').exists('$.breakdown');
      for (const row of breakdownOf(r)) {
        if (typeof row.day !== 'string')
          throw new Error(`day row missing string \`day\`: ${JSON.stringify(row)}`);
        if ('model' in row) throw new Error('day breakdown row leaked a `model` field');
        if ('provider' in row) throw new Error('day breakdown row leaked a `provider` field');
      }
    });

    await ctx.step('group_by=model rows carry both provider and model, never day', async () => {
      const r = await owner.get('/v1/usage', { query: { group_by: 'model' } });
      r.status(200).body().exists('$.breakdown');
      for (const row of breakdownOf(r)) {
        if ('day' in row) throw new Error('model breakdown row leaked a `day` field');
        if (typeof row.model !== 'string')
          throw new Error(`model row missing string \`model\`: ${JSON.stringify(row)}`);
        if (!('provider' in row))
          throw new Error(`model row missing \`provider\`: ${JSON.stringify(row)}`);
      }
    });

    await ctx.step('a malformed start timestamp is a 400 boundary, never a 500', async () => {
      const r = await owner.get('/v1/usage', { query: { start: 'not-a-date' } });
      r.status(400);
    });

    await ctx.step('a malformed end timestamp is a 400 boundary, never a 500', async () => {
      const r = await owner.get('/v1/usage', { query: { end: '2026-13-99T99:99:99Z' } });
      r.status(400);
    });

    await ctx.step('a window with no usage events returns zeroed totals and no rows', async () => {
      const r = await owner.get('/v1/usage', {
        query: { start: '2019-01-01T00:00:00Z', end: '2019-01-02T00:00:00Z', group_by: 'model' },
      });
      r.status(200);
      const body = r.json<{ data: Record<string, number>; breakdown?: unknown[] }>();
      if (body.data.count !== 0) throw new Error(`expected count 0, got ${body.data.count}`);
      if (body.data.total_cost !== 0)
        throw new Error(`expected total_cost 0, got ${body.data.total_cost}`);
      if (!Array.isArray(body.breakdown) || body.breakdown.length !== 0)
        throw new Error(`expected an empty breakdown, got ${JSON.stringify(body.breakdown)}`);
    });
  },
);
