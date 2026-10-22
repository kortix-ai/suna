import { flow } from '../core/flow';
import { Client } from '../core/client';
import { log } from '../core/log';
import { sleep } from '../core/poll';
import { subscribe } from '../fixtures/billing';

flow('GW-1', { domain: 'llm-gateway', tags: ['deployed', 'smoke'], routes: ['GET /health'] }, async (ctx) => {
  const gw = new Client(ctx.env.gatewayUrl);
  await ctx.step('gateway /health is public', async () => {
    const r = await gw.get('/health');
    r.status(200);
    const body = r.json<{ status: string }>();
    if (!['healthy', 'degraded'].includes(body.status) || Object.keys(body).length !== 1) {
      throw new Error('gateway public health must expose only a serving status');
    }
  });
});

// GW-1b — the API's public streaming bridge to standalone gateway health.
flow('GW-1b', { domain: 'llm-gateway', tags: ['deployed', 'smoke'], routes: ['GET /v1/llm/health'] }, async (ctx) => {
  await ctx.step('the API gateway health bridge reaches the standalone service', async () => {
    const r = await ctx.client.get('/v1/llm/health');
    r.status(200)
      .body()
      .has('$.status', 'healthy')
      .has('$.service', 'kortix-llm-gateway')
      .has('$.checks.api.status', 'up');
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
      input: { requestedModel: 'morph-dsv41flash' },
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
    tags: ['deployed'],
    requires: ['funded'],
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
//                                          "provider/model", GatewayModel>).
//   GET /:projectId/llm-catalog/providers  — provider-level rows (id, name,
//                                          env, docs, models).
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

    await ctx.step('the catalog retains published rates for ChatGPT picker rows', async () => {
      const response = await ctx.client.as(ctx.P.OWNER)
        .get('/v1/projects/:projectId/llm-catalog', { params });
      response.status(200);
      const models = response.json<{ models: Record<string, { cost?: Record<string, unknown> }> }>().models;
      const subscription = models['codex/gpt-5.6-sol']?.cost;
      const api = models['openai/gpt-5.6-sol']?.cost;
      if (!(Number(api?.input) > 0) || JSON.stringify(subscription) !== JSON.stringify(api)) {
        throw new Error(`ChatGPT picker must retain published API rate context: ${JSON.stringify(subscription)}`);
      }
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
    requires: ['funded'],
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
      visionModel: 'morph-dsv41flash',
      defaultFallback: { models: ['morph-dsv41flash'], fallbackOn: 'any-error' },
      rules: [
        {
          model: 'openai/gpt-5.5',
          fallbackModels: ['morph-dsv41flash'],
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
        .has('$.effective.defaultFallback.models', ['morph-dsv41flash']);

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
        .has('$.route.fallbackModels', ['morph-dsv41flash'])
        .has('$.route.fallbackOn', 'any-error')
        .has('$.models[0].model', 'codex/gpt-5.6-sol')
        .has('$.models[1].model', 'morph-dsv41flash')
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
        .has('$.route.fallbackModels', ['morph-dsv41flash'])
        .has('$.route.fallbackOn', 'transient');
    });

    await ctx.step('the project chain covers a model that is not the default and has no override', async () => {
      const other = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          '/v1/projects/:projectId/gateway/routing-policy/preview',
          { requestedModel: 'anthropic/claude-sonnet-4-6', imageInput: false },
          { params },
        );
      other
        .status(200)
        .body()
        .has('$.route.policyId', 'project:default')
        .has('$.route.primaryModel', 'anthropic/claude-sonnet-4-6')
        .has('$.route.fallbackModels', ['morph-dsv41flash'])
        .has('$.route.fallbackOn', 'any-error');
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

flow('GW-ACCESS-1', {
  domain: 'llm-gateway',
  routes: [
    'GET /v1/projects/:projectId',
    'PATCH /v1/projects/:projectId/features',
    'PATCH /v1/projects/:projectId/experimental',
    'GET /v1/projects/:projectId/model-access',
    'PUT /v1/projects/:projectId/model-access',
    'PUT /v1/projects/:projectId/gateway/routing-policy',
    'POST /v1/projects/:projectId/gateway/keys',
    'GET /v1/projects/:projectId/gateway/keys',
    'GET /v1/projects/:projectId/model-picker',
    'POST /v1/llm/chat/completions',
  ],
}, async (ctx) => {
  const team = await ctx.fixtures.team();
  const member = await team.addMember('member');
  const project = await team.project();
  await team.grantProjectRole(project.id, member.userId!, 'user');
  const params = { projectId: project.id };
  const path = '/v1/projects/:projectId/model-access';
  const owner = ctx.client.as(ctx.P.OWNER);
  const gateway = new Client(ctx.env.gatewayUrl);
  let key = '';
  const set = (target: 'provider' | 'model', id: string, enabled: boolean) =>
    owner.put(path, { target, id, enabled }, { params });
  const request = (model: string) => gateway.withBearer(key, 'PROJECT_GATEWAY_KEY')
    .post('/v1/llm/chat/completions', { model, messages: [{ role: 'user', content: 'Reply OK' }], max_tokens: 4 });

  await ctx.step('the graduated llm_gateway key is unknown: /features and /experimental → 400, no catalog row, the wire reads true', async () => {
    for (const route of ['/v1/projects/:projectId/features', '/v1/projects/:projectId/experimental'] as const) {
      (await owner.patch(route, { feature: 'llm_gateway', enabled: false }, { params })).status(400)
        .body().has('$.error', "Unknown feature flag 'llm_gateway'");
    }
    const read = await owner.get('/v1/projects/:projectId', { params });
    // Old clients and CLIs read this value; the gateway serves every project.
    read.status(200).body().has('$.experimental.llm_gateway', true);
    const rows = read.json<{ experimental_features: Array<{ key: string }> }>().experimental_features;
    if (rows.some((f) => f.key === 'llm_gateway')) {
      throw new Error(`the catalog still lists llm_gateway: ${JSON.stringify(rows)}`);
    }
  });

  await ctx.step('new project has no explicit restrictions and uses a non-managed default', async () => {
    (await owner.put('/v1/projects/:projectId/gateway/routing-policy', {
      defaultModel: 'codex/gpt-5.6-sol', visionModel: null, defaultFallback: null, rules: [],
    }, { params })).status(200);
    (await owner.get(path, { params })).status(200).body()
      .has('$.disabledProviders', []).has('$.disabledModels', []).has('$.enforced', true);
    const minted = await owner.post('/v1/projects/:projectId/gateway/keys', { name: 'model access verification' }, { params });
    minted.status(200).body().exists('$.secret_key');
    // The mint response states the URL to use the key against (KRTX-1750) —
    // the standalone gateway's origin when one is configured, null when the
    // API serves the gateway itself (the client falls back to its own host).
    // Mint and list must agree on it, whatever the environment sets.
    const keysList = await owner.get('/v1/projects/:projectId/gateway/keys', { params });
    keysList.status(200);
    minted.status(200).body().has('$.gateway_url', keysList.json<{ gateway_url: string | null }>().gateway_url);
    key = minted.json<{ secret_key: string }>().secret_key;
  });
  await ctx.step('anonymous and nonmember requests cannot read or change access', async () => {
    for (const actor of [ctx.P.ANON, ctx.P.NONMEMBER]) {
      (await ctx.client.as(actor).get(path, { params })).status(actor === ctx.P.ANON ? 401 : [403, 404]);
      (await ctx.client.as(actor).put(path, { target: 'provider', id: 'openai', enabled: false }, { params }))
        .status(actor === ctx.P.ANON ? 401 : [403, 404]);
    }
    (await ctx.client.as(member).get(path, { params })).status(200);
    (await ctx.client.as(member).put(path, { target: 'provider', id: 'openai', enabled: false }, { params })).status(403);
  });
  await ctx.step('default model and provider are protected without writing a restriction', async () => {
    (await set('provider', 'codex', false)).status(409).body().has('$.code', 'cannot_disable_default');
    (await set('model', 'kortix/codex/gpt-5.6-sol', false)).status(409).body().has('$.code', 'cannot_disable_default');
    (await owner.get(path, { params })).status(200).body().has('$.disabledProviders', []).has('$.disabledModels', []);
  });
  await ctx.step('managed disable persists and blocks a direct managed request', async () => {
    (await set('provider', 'kortix', false)).status(200).body().has('$.disabledProviders', ['kortix']);
    (await owner.get(path, { params })).status(200).body().has('$.disabledProviders', ['kortix']);
    (await request('morph-dsv41flash')).status(400).body().has('$.error.code', 'provider_disabled');
    const picker = await owner.get('/v1/projects/:projectId/model-picker', { params });
    picker.status(200);
    for (const [id, model] of Object.entries(picker.json<any>().models)) {
      if (!id.includes('/') && (model as any).enabled !== false) throw new Error(`Disabled managed model remains enabled: ${id}`);
    }
  });
  await ctx.step('concurrent provider and model changes both persist', async () => {
    const responses = await Promise.all([set('provider', 'openai', false), set('model', 'custom-test/model', false)]);
    responses.forEach((response) => response.status(200));
    (await owner.get(path, { params })).status(200).body()
      .has('$.disabledProviders', ['kortix', 'openai']).has('$.disabledModels', ['custom-test/model']);
    (await request('openai/future-model')).status(400).body().has('$.error.code', 'provider_disabled');
    (await request('custom-test/model')).status(400).body().has('$.error.code', 'model_disabled');
  });
  await ctx.step('re-enabling a provider preserves individual model restrictions', async () => {
    (await set('provider', 'custom-test', false)).status(200);
    (await set('provider', 'custom-test', true)).status(200).body().has('$.disabledModels', ['custom-test/model']);
    (await request('custom-test/model')).status(400).body().has('$.error.code', 'model_disabled');
    (await set('model', 'kortix/custom-test/model', true)).status(200).body().has('$.disabledModels', []);
    (await request('custom-test/model')).status(400).body().has('$.error.code', 'model_not_found');
  });
  await ctx.step('invalid changes and selecting a disabled default leave policy unchanged', async () => {
    (await owner.put(path, { target: 'provider', id: 'bad/provider', enabled: false }, { params })).status(400);
    (await set('model', 'auto', false)).status(400);
    (await owner.put('/v1/projects/:projectId/gateway/routing-policy', {
      defaultModel: 'openai/gpt-5.5', visionModel: null, defaultFallback: null, rules: [],
    }, { params })).status(409).body().has('$.code', 'model_disabled');
    (await owner.get(path, { params })).status(200).body().has('$.defaultModel', 'codex/gpt-5.6-sol');
  });
  await ctx.step('re-enable clears provider restrictions and preserves the project gateway flag', async () => {
    (await set('provider', 'openai', true)).status(200);
    (await set('provider', 'kortix', true)).status(200);
    (await owner.get(path, { params })).status(200).body()
      .has('$.disabledProviders', []).has('$.disabledModels', []).has('$.enforced', true);
  });
});

// GW-BUDGET-1 — each budget carries the numbers its meter shows: the spend in
// its own period, when that period started and when it resets (KRTX-1725). A
// new project has no model traffic, so the spend is $0 here; the DB suite
// integration-gateway-budget-meters-http.test.ts seeds spend across a day and a
// month boundary and checks it against the gate.
flow('GW-BUDGET-1', {
  domain: 'llm-gateway',
  routes: [
    'GET /v1/projects/:projectId/gateway/budgets',
    'PUT /v1/projects/:projectId/gateway/budgets',
    'DELETE /v1/projects/:projectId/gateway/budgets/:budgetId',
  ],
}, async (ctx) => {
  type Period = 'day' | 'week' | 'month';
  interface Budget {
    budget_id: string;
    scope: 'project' | 'member';
    subject_user_id: string | null;
    subject_email: string | null;
    limit_usd: number;
    period: Period;
    spent_usd: number;
    period_start: string;
    resets_at: string;
  }
  const team = await ctx.fixtures.team();
  const member = await team.addMember('member');
  const memberId = member.userId!;
  const project = await team.project();
  const params = { projectId: project.id };
  const path = '/v1/projects/:projectId/gateway/budgets';
  const owner = ctx.client.as(ctx.P.OWNER);
  const DAY = 86_400_000;

  const read = async () => {
    const r = await owner.get(path, { params });
    r.status(200);
    return r.json<{ project_spend: { cost: number }; budgets: Budget[]; members: unknown[] }>();
  };
  // The period is UTC: a day from 00:00, a week from Monday, a month from the 1st.
  const expectPeriod = (b: Budget | undefined, period: Period, limit: number) => {
    if (!b) throw new Error(`no ${period} budget in the response`);
    const start = new Date(b.period_start);
    const reset = new Date(b.resets_at);
    const now = Date.now();
    const problems = [
      b.period !== period && `period ${b.period}`,
      b.limit_usd !== limit && `limit_usd ${b.limit_usd}`,
      b.spent_usd !== 0 && `spent_usd ${b.spent_usd} on a project with no traffic`,
      !b.period_start.endsWith('T00:00:00.000Z') && `period_start ${b.period_start} is not 00:00 UTC`,
      !(start.getTime() <= now && now < reset.getTime()) && `now is outside ${b.period_start}..${b.resets_at}`,
      period === 'day' && reset.getTime() - start.getTime() !== DAY && 'a day is not 24 h',
      period === 'week' && (start.getUTCDay() !== 1 || reset.getTime() - start.getTime() !== 7 * DAY) &&
        'a week does not run Monday to Monday',
      period === 'month' &&
        (start.getUTCDate() !== 1 || reset.getUTCDate() !== 1 || reset.getUTCMonth() !== (start.getUTCMonth() + 1) % 12) &&
        'a month does not run from the 1st to the next 1st',
    ].filter(Boolean);
    if (problems.length) throw new Error(`${period} budget ${JSON.stringify(b)}: ${problems.join('; ')}`);
  };

  await ctx.step('an anonymous caller cannot read the budgets', async () => {
    (await ctx.client.as(ctx.P.ANON).get(path, { params })).status(401);
  });
  await ctx.step('a daily project budget reads $0 spent, a period from 00:00 UTC today, and a reset 24 h later', async () => {
    (await owner.put(path, { scope: 'project', limit_usd: 20, period: 'day', action: 'block' }, { params })).status(200);
    const body = await read();
    expectPeriod(body.budgets.find((b) => b.scope === 'project'), 'day', 20);
    if (body.project_spend.cost !== 0 || !Array.isArray(body.members)) {
      throw new Error(`month-to-date fields changed shape: ${JSON.stringify(body)}`);
    }
  });
  await ctx.step('changing the period to a week and to a month moves the period start and the reset', async () => {
    for (const period of ['week', 'month'] as const) {
      (await owner.put(path, { scope: 'project', limit_usd: 50, period, action: 'warn' }, { params })).status(200);
      const rows = (await read()).budgets.filter((b) => b.scope === 'project');
      if (rows.length !== 1) throw new Error(`expected one project budget, got ${rows.length}`);
      expectPeriod(rows[0], period, 50);
    }
  });
  let memberBudgetId = '';
  await ctx.step('a member budget reads its own period and names its member, who has no spend this month, next to the project budget', async () => {
    (await owner.put(path, {
      scope: 'member', subject_user_id: memberId, limit_usd: 5, period: 'day', action: 'block',
    }, { params })).status(200);
    const body = await read();
    const own = body.budgets.find((b) => b.scope === 'member' && b.subject_user_id === memberId);
    expectPeriod(own, 'day', 5);
    // The month-to-date `members` list has no row for a member who spent
    // nothing, so only the budget's `subject_email` can name them.
    if (own!.subject_email?.toLowerCase() !== member.email?.toLowerCase()) {
      throw new Error(`member budget subject_email ${own!.subject_email}, expected ${member.email}`);
    }
    const projectBudget = body.budgets.find((b) => b.scope === 'project');
    expectPeriod(projectBudget, 'month', 50);
    if (projectBudget!.subject_email !== null) {
      throw new Error(`project budget subject_email ${projectBudget!.subject_email}, expected null`);
    }
    memberBudgetId = own!.budget_id;
  });
  await ctx.step('removing the member budget removes its row and keeps the project budget', async () => {
    (await owner.del('/v1/projects/:projectId/gateway/budgets/:budgetId', {
      params: { ...params, budgetId: memberBudgetId },
    })).status(200);
    const budgets = (await read()).budgets;
    if (budgets.some((b) => b.budget_id === memberBudgetId)) throw new Error('the removed member budget is still listed');
    expectPeriod(budgets.find((b) => b.scope === 'project'), 'month', 50);
  });
});

// A 64 × 64 red PNG. Every managed model reads it as "red" (verified
// 2026-09-23 on each pinned endpoint).
const RED_SQUARE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAS0lEQVR42u3PQQkAAAgAsetfWiP4FgYrsKZeS0BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEDgsqnc8OJg6Ln3AAAAAElFTkSuQmCC';

// A picker that offers a managed model its endpoint refuses is a silent
// outage: the member picks it and every turn fails. This flow sends each
// managed model the deployment serves one text-and-image request through the
// gateway, with a subscribed account and the deployment's provider key. It
// makes real model calls, so it runs on previews and the staging gate; the
// local profile has no provider key and excludes it through `stripe`.
flow('GW-MANAGED-1', {
  domain: 'llm-gateway',
  tags: ['deployed'],
  requires: ['stripe'],
  timeoutMs: 300_000,
  routes: [
    'POST /v1/projects/:projectId/gateway/keys',
    'GET /v1/projects/:projectId/model-picker',
    'POST /v1/llm/chat/completions',
  ],
}, async (ctx) => {
  const team = await ctx.fixtures.team();
  const owner = ctx.client.as(ctx.P.OWNER);
  await ctx.step('a subscribed account is entitled to the managed lineup', async () => {
    await subscribe(ctx.env, owner, team.id);
  });
  const project = await team.project();
  const params = { projectId: project.id };
  let key = '';
  await ctx.step('the project mints a gateway key', async () => {
    const minted = await owner.post('/v1/projects/:projectId/gateway/keys', { name: 'managed lineup' }, { params });
    minted.status(200).body().exists('$.secret_key');
    key = minted.json<{ secret_key: string }>().secret_key;
  });

  let managed: string[] = [];
  await ctx.step('the picker offers DeepSeek V4.1 Flash and GLM 5.3 Flash as image-capable managed models, not the retired Kimi K3, and no OpenAI or Anthropic model', async () => {
    const picker = await owner.get('/v1/projects/:projectId/model-picker', { params });
    picker.status(200);
    const models = picker.json<{ models: Record<string, { name?: string; attachment?: boolean; enabled?: boolean }> }>()
      .models;
    managed = Object.keys(models).filter((id) => !id.includes('/'));
    for (const [id, name] of [
      ['deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'],
      ['glm-5.3-flash', 'GLM 5.3 Flash'],
    ] as const) {
      const model = models[id];
      if (!model || model.name !== name || model.attachment !== true || model.enabled === false) {
        throw new Error(`picker does not offer ${id} as an enabled image-capable managed model: ${JSON.stringify(model)}`);
      }
    }
    // #10286 retired Kimi K3 (2026-10-19): `kimi-k3` is an alias of the
    // default now, never a model of its own in the picker.
    if ('kimi-k3' in models) throw new Error(`picker still offers the retired kimi-k3: ${JSON.stringify(models['kimi-k3'])}`);
    const vendor = managed.filter((id) => /^(gpt|claude|o\d)/.test(id));
    if (vendor.length > 0) throw new Error(`picker offers OpenAI or Anthropic models as managed: ${vendor.join(', ')}`);
  });

  // An upstream 429 is capacity, not configuration: the route exists and the
  // key is accepted. On the first preview run of this flow (2026-09-23),
  // glm-5.3-flash answered 429 "temporarily rate-limited upstream" from its
  // shared pool while the other managed models answered. A throttled
  // model is retried, then logged; every other outcome fails.
  await ctx.step('every managed model the picker offers answers a text-and-image request, or is throttled or unavailable upstream', async () => {
    const gateway = new Client(ctx.env.gatewayUrl).withBearer(key, 'PROJECT_GATEWAY_KEY');
    const ask = async (model: string) => {
      let status = 0;
      let detail = '';
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const res = await gateway.post('/v1/llm/chat/completions', {
          model,
          max_tokens: 400,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: 'What color is this square? Reply with one lowercase word.' },
              { type: 'image_url', image_url: { url: RED_SQUARE_PNG } },
            ],
          }],
        });
        status = res.statusCode;
        detail = status === 200
          ? String(res.json<{ choices?: Array<{ message?: { content?: unknown } }> }>().choices?.[0]?.message?.content ?? '')
          : res.text().slice(0, 200);
        if (![429, 502, 503, 504].includes(status)) break;
        if (attempt < 3) await sleep(3_000 * attempt);
      }
      return { model, status, detail };
    };
    const results = await Promise.all(managed.map(ask));
    const answered = results.filter((r) => r.status === 200 && /\bred\b/i.test(r.detail));
    // The gateway answers a model it cannot route with the documented
    // `503 model_unavailable` (llm-gateway/pipeline/public-identity.ts). The
    // gate must not depend on one upstream provider, so the answer counts
    // beside at least one model that answered, and the run logs it. Any other status (400 for an
    // image the model refuses, 401, 404, 500) fails, and so does a gateway where
    // no model answers.
    const unavailable = (r: { status: number; detail: string }) =>
      r.status === 503 && /"code":"model_unavailable"/.test(r.detail);
    const throttled = results.filter((r) => r.status === 429 || (answered.length > 0 && unavailable(r)));
    for (const r of throttled) log.warn(`GW-MANAGED-1: ${r.model} not served upstream after 3 attempts: HTTP ${r.status} ${r.detail}`);
    const failed = results.filter((r) => !answered.includes(r) && !throttled.includes(r));
    if (failed.length > 0) {
      throw new Error(`managed models that did not answer:\n${failed.map((r) => `${r.model}: HTTP ${r.status} ${r.detail}`).join('\n')}`);
    }
    if (answered.length === 0) throw new Error('no managed model answered; every model was throttled or unavailable');
  });
});

