import { describe, expect, mock, test } from 'bun:test';

// The in-process gateway (apps/api wire.ts) must SERVE
// `POST /v1/llm/language-model` so opencode's `@ai-sdk/gateway` provider
// (baseURL `${KORTIX_URL}/v1/llm`) reaches `gateway.languageModel(req)`. The
// native ingress is ALWAYS mounted — there is no enable flag (a per-service
// toggle used to let the standalone gateway drift off while sessions were baked
// native, 404-ing every turn). This drives the REAL mounted route: a request
// reaches the gateway auth/decode pipeline (401 without a token), NOT a route
// -not-found 404.
//
// The config is mocked by SPREADING the real one (it validates fine under
// scripts/test.env) and overriding only `LLM_GATEWAY_ENABLED` (so the /v1/llm
// sub-app mounts). No process.env mutation, so the result is deterministic
// under the parallel isolated runner.
const { config: realConfig } = await import('../config');

mock.module('../config', () => ({
  config: {
    ...realConfig,
    LLM_GATEWAY_ENABLED: true,
  },
}));

// Hermetic gateway hooks — no DB. `authenticate` returns null so `admit`
// answers 401 for a request with no bearer token. Spread the real module so
// internal-routes' other `./hooks` imports still resolve.
const actualHooks = await import('./hooks');
mock.module('./hooks', () => ({
  ...actualHooks,
  createInProcessGatewayHooks: () => ({
    authenticate: async () => null,
    resolveUpstream: async () => [],
    assertBillingActive: async () => {},
    recordUsage: async () => {},
    listModels: async () => ({}),
  }),
}));

const { mountLlmGateway } = await import('./wire');
const { makeOpenApiApp } = await import('../openapi');

// A request the gateway's `decodeLanguageModelRequest` accepts: model id in the
// header, valid `LanguageModelV*CallOptions.prompt` body. Mirrors the fixture in
// packages/llm-gateway's language-model-handler test.
function languageModelRequest(path: string, withToken: boolean): Request {
  return new Request(`http://test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'ai-language-model-id': 'anthropic/claude-fable-5',
      ...(withToken ? { authorization: 'Bearer some-token' } : {}),
    },
    body: JSON.stringify({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }),
  });
}

function mountedApp() {
  const app = makeOpenApiApp();
  mountLlmGateway(app);
  return app;
}

describe('wire.ts /v1/llm/language-model — always mounted', () => {
  test('the route is mounted and reaches auth — no token returns 401, not a route 404', async () => {
    const res = await mountedApp().request(
      languageModelRequest('/v1/llm/language-model', false),
    );
    // A mounted route hits auth/decode. A route-404 would mean the mount is
    // missing.
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string };
    // The gateway's own JSON error envelope — proves we hit the pipeline, not a
    // Hono not-found.
    expect(['missing_token', 'invalid_token']).toContain(body.code ?? '');
  });

  test('an unmounted /v1/llm path returns a plain 404 — the control for "404 == not found"', async () => {
    const res = await mountedApp().request(
      new Request('http://test/v1/llm/definitely-not-a-route', { method: 'POST' }),
    );
    expect(res.status).toBe(404);
  });
});
