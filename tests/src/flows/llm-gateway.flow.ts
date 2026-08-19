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

// GW-14 — per-project OTLP trace export ("Observability" tab). The project
// points the gateway's gen_ai.* spans at its OWN OTLP backend
// (Langfuse/Datadog/Honeycomb/anything OTLP) instead of the operator env var.
// Three things this flow has to prove, because all three are security
// contracts, not conveniences:
//   1. the stored auth header is NEVER returned — the read model is
//      `has_headers: boolean`, never a value;
//   2. the endpoint is caller-supplied egress, so it goes through the SSRF
//      guard — a private/link-local/metadata target is rejected at write time,
//      not at export time;
//   3. writing is `project.gateway.otel.manage` (manager-only). A floor
//      `member` can READ the config (project.gateway.spend.read) but any
//      PUT/DELETE is 403.
flow(
  'GW-14',
  {
    domain: 'llm-gateway',
    routes: [
      'GET /v1/projects/:projectId/gateway/otel',
      'PUT /v1/projects/:projectId/gateway/otel',
      'DELETE /v1/projects/:projectId/gateway/otel',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const params = { projectId: project.id };
    const owner = ctx.client.as(ctx.P.OWNER);
    const plainMember = await team.addMember('member');

    await ctx.step('a project with no config reads as disabled, with no headers', async () => {
      const r = await owner.get('/v1/projects/:projectId/gateway/otel', { params });
      r.status(200)
        .body()
        .has('$.enabled', false)
        .has('$.endpoint', null)
        .has('$.has_headers', false)
        .has('$.updated_at', null)
        .has('$.capabilities.write', true);
    });

    await ctx.step('saving an endpoint + auth header enables export', async () => {
      const saved = await owner.put(
        '/v1/projects/:projectId/gateway/otel',
        {
          enabled: true,
          endpoint: 'https://cloud.langfuse.com/api/public/otel/v1/traces',
          headers: { Authorization: 'Bearer ke2e-otlp-token' },
        },
        { params },
      );
      saved
        .status(200)
        .body()
        .has('$.enabled', true)
        .has('$.endpoint', 'https://cloud.langfuse.com/api/public/otel/v1/traces')
        .has('$.has_headers', true);
      if (JSON.stringify(saved.json()).includes('ke2e-otlp-token')) {
        throw new Error('PUT response leaked the stored OTLP auth header value');
      }
    });

    await ctx.step('read-back reports the header EXISTS but never its value', async () => {
      const r = await owner.get('/v1/projects/:projectId/gateway/otel', { params });
      r.status(200)
        .body()
        .has('$.enabled', true)
        .has('$.endpoint', 'https://cloud.langfuse.com/api/public/otel/v1/traces')
        .has('$.has_headers', true)
        .exists('$.updated_at');
      const raw = JSON.stringify(r.json());
      if (raw.includes('ke2e-otlp-token') || raw.includes('Authorization')) {
        throw new Error('GET leaked the stored OTLP auth header');
      }
    });

    await ctx.step('omitting `headers` keeps the stored header on a toggle-only write', async () => {
      const off = await owner.put(
        '/v1/projects/:projectId/gateway/otel',
        { enabled: false, endpoint: 'https://cloud.langfuse.com/api/public/otel/v1/traces' },
        { params },
      );
      off.status(200).body().has('$.enabled', false).has('$.has_headers', true);
    });

    await ctx.step('an SSRF-unsafe endpoint is rejected at write time → 400', async () => {
      for (const endpoint of [
        'http://169.254.169.254/latest/meta-data/',
        'https://127.0.0.1:4318/v1/traces',
        'file:///etc/passwd',
      ]) {
        const r = await owner.put(
          '/v1/projects/:projectId/gateway/otel',
          { enabled: true, endpoint },
          { params },
        );
        r.status(400);
      }
    });

    await ctx.step('enabling export with no endpoint → 400', async () => {
      const r = await owner.put(
        '/v1/projects/:projectId/gateway/otel',
        { enabled: true, endpoint: null },
        { params },
      );
      r.status(400);
    });

    await ctx.step('a header name/value that could corrupt the request → 400', async () => {
      const badName = await owner.put(
        '/v1/projects/:projectId/gateway/otel',
        {
          enabled: true,
          endpoint: 'https://cloud.langfuse.com/api/public/otel/v1/traces',
          headers: { 'X-Bad Header': 'v' },
        },
        { params },
      );
      badName.status(400);

      const crlf = await owner.put(
        '/v1/projects/:projectId/gateway/otel',
        {
          enabled: true,
          endpoint: 'https://cloud.langfuse.com/api/public/otel/v1/traces',
          headers: { 'X-Bad': 'a\r\nX-Injected: b' },
        },
        { params },
      );
      crlf.status(400);
    });

    await ctx.step('a rejected write leaves the stored config untouched', async () => {
      const r = await owner.get('/v1/projects/:projectId/gateway/otel', { params });
      r.status(200)
        .body()
        .has('$.enabled', false)
        .has('$.endpoint', 'https://cloud.langfuse.com/api/public/otel/v1/traces')
        .has('$.has_headers', true);
    });

    await ctx.step('a floor project member can READ but not WRITE the config', async () => {
      await team.grantProjectRole(project.id, plainMember.userId!, 'member');
      const member = ctx.client.as(plainMember);

      const read = await member.get('/v1/projects/:projectId/gateway/otel', { params });
      read.status(200).body().has('$.capabilities.write', false);

      const write = await member.put(
        '/v1/projects/:projectId/gateway/otel',
        { enabled: true, endpoint: 'https://collector.example.com/v1/traces' },
        { params },
      );
      write.status(403);

      const remove = await member.del('/v1/projects/:projectId/gateway/otel', { params });
      remove.status(403);
    });

    await ctx.step('a project nonmember is 403/404 and ANON is 401', async () => {
      const nonmember = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/projects/:projectId/gateway/otel', { params });
      nonmember.status([403, 404]);

      const anon = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/projects/:projectId/gateway/otel', { params });
      anon.status(401);
    });

    await ctx.step('DELETE removes the config and the read returns to empty', async () => {
      const removed = await owner.del('/v1/projects/:projectId/gateway/otel', { params });
      removed.status(200).body().has('$.ok', true);

      const after = await owner.get('/v1/projects/:projectId/gateway/otel', { params });
      after
        .status(200)
        .body()
        .has('$.enabled', false)
        .has('$.endpoint', null)
        .has('$.has_headers', false)
        .has('$.updated_at', null);
    });
  },
);
