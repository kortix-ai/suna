import { flow } from '../core/flow';
import { Client } from '../core/client';

flow('GW-1', { domain: 'llm-gateway', tags: ['smoke'], routes: ['GET /health'] }, async (ctx) => {
  const gw = new Client(ctx.env.gatewayUrl);
  await ctx.step('gateway /health is public', async () => {
    const r = await gw.get('/health');
    r.status(200).body().has('$.status', 'healthy').has('$.service', 'kortix-llm-gateway');
  });
});

// GW-1b — the in-API-mounted LLM gateway health (apps/api/src/llm-gateway/wire.ts,
// mountLlmGateway: `llm.get('/health', ...)` mounted at app.route('/v1/llm', llm)).
// Distinct from GW-1's bare standalone-gateway-pod /health — this is served by
// the in-process API when LLM_GATEWAY_ENABLED, with no auth in front of it.
flow('GW-1b', { domain: 'llm-gateway', tags: ['smoke'], routes: ['GET /v1/llm/health'] }, async (ctx) => {
  await ctx.step('in-API LLM gateway health mount is public', async () => {
    const r = await ctx.client.get('/v1/llm/health');
    r.status(200)
      .body()
      .has('$.status', 'ok')
      .has('$.service', 'kortix-llm-gateway')
      .has('$.mode', 'in-process');
  });
});

// GW-8 — /internal/gateway/resolve-route (apps/api/src/llm-gateway/internal-routes.ts):
// control-plane RPC the OUT-OF-PROCESS standalone gateway pod calls to resolve a
// routing decision. Gated by a single shared `GATEWAY_INTERNAL_TOKEN` bearer
// (apps/api/src/llm-gateway/internal-auth.ts matchesInternalToken) — a
// service-to-service secret the ke2e harness intentionally has no credential
// for (KE2E_INTERNAL_SERVICE_KEY maps to the unrelated INTERNAL_SERVICE_KEY
// used by /metrics + cron, not GATEWAY_INTERNAL_TOKEN). We can only exercise
// the real auth boundary: no header, and a garbage bearer, both → 401 before
// any routing/resolution logic runs — never a real "resolve" call.
flow(
  'GW-8',
  { domain: 'llm-gateway', routes: ['POST /internal/gateway/resolve-route'] },
  async (ctx) => {
    const body = {
      principal: { accountId: '00000000-0000-4000-a000-000000000000' },
      input: { requestedModel: 'glm-5.2' },
    };
    await ctx.step('no internal token → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).post('/internal/gateway/resolve-route', body);
      r.status(401);
    });
    await ctx.step('garbage internal bearer → 401', async () => {
      const r = await ctx.client
        .withBearer('definitely-not-the-gateway-internal-token', 'BOGUS')
        .post('/internal/gateway/resolve-route', body);
      r.status(401);
    });
  },
);

flow(
  'GW-2',
  {
    domain: 'llm-gateway',
    routes: ['GET /v1/llm/models', 'GET /v1/models', 'GET /v1/openai/models'],
  },
  async (ctx) => {
    const gw = new Client(ctx.env.gatewayUrl);
    const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name('gateway-models') });
    for (const path of ['/v1/llm/models', '/v1/models', '/v1/openai/models'] as const) {
      await ctx.step(`${path} returns the authenticated model catalog`, async () => {
        const r = await gw.withBearer(pat, 'OWNER_PAT').get(path);
        r.status(200).body().exists('$.models');
        const models = r.json<any>()?.models;
        if (!models || typeof models !== 'object' || Object.keys(models).length === 0) {
          throw new Error(`${path} returned an empty model catalog`);
        }
        if ('auto' in models || 'kortix/auto' in models) {
          throw new Error(`${path} returned the removed Auto model`);
        }
      });
    }
  },
);

flow('GW-2b', { domain: 'llm-gateway', routes: ['GET /v1/llm/models'] }, async (ctx) => {
  const gw = new Client(ctx.env.gatewayUrl);
  await ctx.step('ANON cannot list models', async () => {
    const r = await gw.as(ctx.P.ANON).get('/v1/llm/models');
    r.status([401, 403]);
  });
});

flow(
  'GW-2c',
  {
    domain: 'llm-gateway',
    // The in-process mount also serves the `/v1/...`-prefixed aliases so a
    // self-host whose public URL points at the API directly (tunnel/local
    // mode, no Caddy /v1/llm* split) doesn't 404 every OpenAI-compat call.
    routes: ['GET /v1/llm/v1/models'],
  },
  async (ctx) => {
    await ctx.step('ANON cannot call the /v1/llm/v1/models alias', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/llm/v1/models');
      r.status([401, 403]);
    });
  },
);

flow(
  'GW-3b',
  {
    domain: 'llm-gateway',
    routes: ['POST /v1/llm/v1/chat/completions'],
  },
  async (ctx) => {
    const body = { model: 'gpt-5.5', messages: [{ role: 'user', content: 'ping' }] };
    await ctx.step('ANON cannot call the /v1/llm/v1/chat/completions alias', async () => {
      const r = await ctx.client.as(ctx.P.ANON).post('/v1/llm/v1/chat/completions', body);
      r.status([401, 403]);
    });
  },
);

// GW-5 — project-scoped LLM catalog surfaces read by the connect modal.
//   GET /:projectId/llm-catalog           — model-level entries (Record<
//                                          "provider/model", GatewayModel>),
//                                          gated by the project's llm_gateway
//                                          flag.
//   GET /:projectId/llm-catalog/providers  — provider-level rows (id, name,
//                                          env, docs, models), NOT gated by
//                                          llm_gateway (BYOK connect modal
//                                          applies to native projects too).
// Both read the same 24h-refreshed runtimeModelCatalog; both enforce
// project-read authz. Cover both in one flow so the gate can't drift between
// the two shapes.
flow(
  'GW-5',
  {
    domain: 'llm-gateway',
    routes: [
      'GET /v1/projects/:projectId/llm-catalog',
      'GET /v1/projects/:projectId/llm-catalog/providers',
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const params = { projectId: project.id };

    for (const path of [
      '/v1/projects/:projectId/llm-catalog',
      '/v1/projects/:projectId/llm-catalog/providers',
    ] as const) {
      await ctx.step(`ANON → 401 on ${path}`, async () => {
        const r = await ctx.client.as(ctx.P.ANON).get(path, { params });
        r.status(401);
      });

      await ctx.step(`NONMEMBER → 403/404 on ${path}`, async () => {
        const r = await ctx.client.as(ctx.P.NONMEMBER).get(path, { params });
        r.status([403, 404]);
      });

      await ctx.step(`unknown project id → 404 (not 500) on ${path}`, async () => {
        const r = await ctx.client.as(ctx.P.OWNER).get(path, {
          params: { projectId: '00000000-0000-0000-0000-000000000000' },
        });
        r.status(404);
      });
    }

    await ctx.step('OWNER → 200 on the model-level catalog', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/llm-catalog', { params });
      // /llm-catalog is gated by the project's llm_gateway flag. On a fresh
      // fixture project the flag may be off → 404 (catalog disabled), or on
      // → 200 with a `{models:...}` body. Either is a valid boundary; a 500
      // is the only real failure.
      r.status([200, 404]);
    });

    await ctx.step('OWNER → 200 with a provider catalog on /providers', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/llm-catalog/providers', { params });
      r.status(200);
      // The runtime catalog snapshot is an object (provider-keyed); assert it
      // parsed to a non-null object so a future regression that returns
      // `null`/`undefined`/an empty 200 body is caught.
      const body = r.json<any>();
      if (body === null || body === undefined || typeof body !== 'object') {
        throw new Error(`expected a provider catalog object, got: ${JSON.stringify(body)}`);
      }
    });
  },
);

flow(
  'GW-3',
  {
    domain: 'llm-gateway',
    routes: [
      'POST /v1/chat/completions',
      'POST /v1/llm/chat/completions',
      'POST /v1/openai/chat/completions',
    ],
  },
  async (ctx) => {
    const gw = new Client(ctx.env.gatewayUrl);
    const body = { model: 'gpt-5.5', messages: [{ role: 'user', content: 'ping' }] };
    await ctx.step('ANON cannot call /v1/llm/chat/completions', async () => {
      const r = await gw.as(ctx.P.ANON).post('/v1/llm/chat/completions', body);
      r.status([401, 403]);
    });
    await ctx.step('ANON cannot call /v1/chat/completions alias', async () => {
      const r = await gw.as(ctx.P.ANON).post('/v1/chat/completions', body);
      r.status([401, 403]);
    });
    await ctx.step('ANON cannot call /v1/openai/chat/completions alias', async () => {
      const r = await gw.as(ctx.P.ANON).post('/v1/openai/chat/completions', body);
      r.status([401, 403]);
    });
  },
);

flow(
  'GW-6',
  {
    domain: 'llm-gateway',
    routes: ['POST /v1/llm/messages', 'POST /v1/llm/v1/messages'],
  },
  async (ctx) => {
    const body = {
      model: 'claude-sonnet-4-6',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'ping' }],
    };
    await ctx.step('ANON cannot call the Anthropic-Messages ingress /v1/llm/messages', async () => {
      const r = await ctx.client.as(ctx.P.ANON).post('/v1/llm/messages', body);
      r.status([401, 403]);
    });
    await ctx.step('ANON cannot call the /v1/... prefixed variant', async () => {
      const r = await ctx.client.as(ctx.P.ANON).post('/v1/llm/v1/messages', body);
      r.status([401, 403]);
    });
  },
);

flow(
  'GW-7',
  {
    domain: 'llm-gateway',
    routes: ['POST /v1/messages', 'POST /v1/llm/messages', 'POST /v1/openai/messages'],
  },
  async (ctx) => {
    // Standalone gateway pod: the same Anthropic-Messages ingress as GW-6,
    // mounted under the chat.completions alias namespaces (bare /v1, /v1/llm,
    // /v1/openai) instead of the in-process API's /v1/llm/* mount.
    const gw = new Client(ctx.env.gatewayUrl);
    const body = {
      model: 'claude-sonnet-4-6',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'ping' }],
    };
    await ctx.step('ANON cannot call /v1/messages', async () => {
      const r = await gw.as(ctx.P.ANON).post('/v1/messages', body);
      r.status([401, 403]);
    });
    await ctx.step('ANON cannot call /v1/llm/messages alias', async () => {
      const r = await gw.as(ctx.P.ANON).post('/v1/llm/messages', body);
      r.status([401, 403]);
    });
    await ctx.step('ANON cannot call /v1/openai/messages alias', async () => {
      const r = await gw.as(ctx.P.ANON).post('/v1/openai/messages', body);
      r.status([401, 403]);
    });
  },
);

flow(
  'GW-4',
  {
    domain: 'llm-gateway',
    routes: [
      'GET /v1/projects/:projectId/gateway/routing-policy',
      'PUT /v1/projects/:projectId/gateway/routing-policy',
      'DELETE /v1/projects/:projectId/gateway/routing-policy',
      'POST /v1/projects/:projectId/gateway/routing-policy/preview',
      'GET /v1/projects/:projectId/model-picker',
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const params = { projectId: project.id };
    const policy = {
      defaultModel: 'codex/gpt-5.6-sol',
      visionModel: 'glm-5.2',
      defaultFallback: { models: ['glm-5.2'], fallbackOn: 'any-error' },
      rules: [
        {
          model: 'openai/gpt-5.5',
          fallbackModels: ['glm-5.2'],
          fallbackOn: 'transient',
        },
      ],
    };
    // The stored/read-back project policy always carries the per-model
    // generation-config map (defaults to {} when unset), so the round-trip
    // assertions compare against the policy plus that field.
    const savedProject = { ...policy, modelGenerationConfig: {} };

    await ctx.step('inherited routing policy is readable', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/gateway/routing-policy', { params });
      r.status(200)
        .body()
        .has('$.version', 1)
        .has('$.project.defaultModel', null)
        .has('$.project.defaultFallback', null)
        .has('$.project.rules', [])
        .exists('$.effective.defaultModel')
        .has('$.capabilities.write', true);
    });

    await ctx.step(
      'compact project model picker is available without the full runtime catalog',
      async () => {
        const enabled = await ctx.client
          .as(ctx.P.OWNER)
          .patch(
            '/v1/projects/:projectId/experimental',
            { feature: 'llm_gateway', enabled: true },
            { params },
          );
        enabled.status(200);

        const picker = await ctx.client
          .as(ctx.P.OWNER)
          .get('/v1/projects/:projectId/model-picker', { params });
        picker.status(200).body().exists('$.models');
        const pickerModels = picker.json<{ models?: Record<string, unknown> }>().models ?? {};
        const pickerCount = Object.keys(pickerModels).length;
        if (pickerCount === 0 || pickerCount >= 100) {
          throw new Error(`expected a compact non-empty picker catalog, got ${pickerCount} models`);
        }
      },
    );

    await ctx.step('save and read back the complete project policy', async () => {
      const saved = await ctx.client
        .as(ctx.P.OWNER)
        .put('/v1/projects/:projectId/gateway/routing-policy', policy, { params });
      saved
        .status(200)
        .body()
        .has('$.project', savedProject)
        .has('$.effective.defaultModel', 'codex/gpt-5.6-sol')
        .has('$.effective.defaultFallback.models', ['glm-5.2']);

      const read = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/gateway/routing-policy', { params });
      read.status(200).body().has('$.project', savedProject);
    });

    await ctx.step('preview resolves ordered default and exact-model routes', async () => {
      const defaultRoute = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/gateway/routing-policy/preview',
          { requestedModel: 'codex/gpt-5.6-sol', imageInput: false },
          { params },
        );
      defaultRoute
        .status(200)
        .body()
        .has('$.route.policyId', 'project:default')
        .has('$.route.primaryModel', 'codex/gpt-5.6-sol')
        .has('$.route.fallbackModels', ['glm-5.2'])
        .has('$.route.fallbackOn', 'any-error')
        .has('$.models[0].model', 'codex/gpt-5.6-sol')
        .has('$.models[1].model', 'glm-5.2')
        .exists('$.models[0].available')
        .exists('$.models[1].available');

      const exact = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/gateway/routing-policy/preview',
          { requestedModel: 'openai/gpt-5.5', imageInput: false },
          { params },
        );
      exact
        .status(200)
        .body()
        .has('$.route.policyId', 'project:exact:openai/gpt-5.5')
        .has('$.route.primaryModel', 'openai/gpt-5.5')
        .has('$.route.fallbackModels', ['glm-5.2'])
        .has('$.route.fallbackOn', 'transient');
    });

    await ctx.step('invalid self-loop is rejected without replacing the saved policy', async () => {
      const invalid = await ctx.client.as(ctx.P.OWNER).put(
        '/v1/projects/:projectId/gateway/routing-policy',
        {
          ...policy,
          defaultFallback: { models: ['codex/gpt-5.6-sol'], fallbackOn: 'any-error' },
        },
        { params },
      );
      invalid.status(400).body().has('$.code', 'invalid_routing_policy');

      const read = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/gateway/routing-policy', { params });
      read.status(200).body().has('$.project', savedProject);
    });

    await ctx.step('project access boundaries are enforced', async () => {
      const nonmember = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/projects/:projectId/gateway/routing-policy', { params });
      nonmember.status([403, 404]);
      const anonymous = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/projects/:projectId/gateway/routing-policy', { params });
      anonymous.status(401);
      const anonymousPicker = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/projects/:projectId/model-picker', { params });
      anonymousPicker.status(401);
    });

    await ctx.step('reset removes every project override', async () => {
      const reset = await ctx.client
        .as(ctx.P.OWNER)
        .del('/v1/projects/:projectId/gateway/routing-policy', { params });
      reset
        .status(200)
        .body()
        .has('$.project.defaultModel', null)
        .has('$.project.visionModel', null)
        .has('$.project.defaultFallback', null)
        .has('$.project.rules', []);
    });
  },
);
