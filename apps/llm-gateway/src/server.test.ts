import { describe, expect, test } from 'bun:test';

// `config` (imported transitively by `./server`) reads required env vars at
// module-load time — set them before the dynamic import below so this file
// can run standalone without a real Kortix API / gateway token.
process.env.KORTIX_API_URL = process.env.KORTIX_API_URL ?? 'https://api.test.invalid';
process.env.GATEWAY_INTERNAL_TOKEN = process.env.GATEWAY_INTERNAL_TOKEN ?? 'test-internal-token';

const { buildServer } = await import('./server');

// Piece B: `POST /v1/messages` (+ the `/v1/llm/messages` and `/v1/openai/messages`
// aliases, mirroring the `/v1/chat/completions` alias namespaces) must be
// mounted on the standalone gateway and dispatch through `gateway.messages()`
// — proven here by the response using the Anthropic error envelope
// (`{type:'error', error:{type,message}}`), which only `gateway.messages()`
// produces; `gateway.chatCompletions()` returns the OpenAI-compat envelope
// instead. No real upstream call is made — a missing bearer token short-circuits
// inside the shared pipeline before any network hop.
describe('standalone gateway inference routes', () => {
  const { app } = buildServer();

  const post = (path: string) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

  for (const path of ['/messages', '/v1/messages', '/v1/llm/messages', '/v1/openai/messages']) {
    test(`${path} is registered and speaks the Anthropic error envelope`, async () => {
      const res = await post(path);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { type: string; error: { type: string; message: string } };
      expect(body.type).toBe('error');
      expect(body.error.type).toBe('authentication_error');
      expect(body.error.message).toBe('Missing bearer token');
    });
  }

  test('an unregistered path 404s (sanity check against an accidental catch-all)', async () => {
    const res = await post('/v1/not-a-real-messages-route');
    expect(res.status).toBe(404);
  });

  for (const path of ['/chat/completions', '/v1/chat/completions']) {
    test(`${path} speaks the OpenAI-compat error envelope`, async () => {
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.type).toBeUndefined();
      expect(body.code).toBe('missing_token');
    });
  }

  for (const path of ['/models', '/v1/models']) {
    test(`${path} is registered`, async () => {
      const res = await app.request(path);
      expect(res.status).toBe(401);
      expect((await res.json()) as Record<string, unknown>).toHaveProperty(
        'error.message',
        'Missing bearer token',
      );
    });
  }
});

// The AI-SDK-native ingress must answer on EVERY prefix a real deployment can
// produce, because `@ai-sdk/gateway` derives its path from `KORTIX_LLM_BASE_URL`:
//
//   proxy mode  → `<origin>/v1/llm-gateway/v1`, and wire.ts strips
//                 `/v1/llm-gateway` → this server sees `/v1/language-model`
//   direct mode → `<origin>/v1/llm`          → `/v1/llm/language-model`
//
// `/v1/language-model` was missing here while the in-API mount (wire.ts) had it,
// so proxy-mode sandboxes 404'd on every turn. A Hono 404 is `text/plain`
// "404 Not Found", which fails `@ai-sdk/gateway`'s `{error:{message}}` schema —
// the client then discards it and reports the hardcoded, information-free
// `Invalid error response format: Gateway request failed`. Asserting 401-not-404
// pins the mount list; asserting the JSON envelope pins that a real failure
// stays readable instead of collapsing into that string.
describe('AI-SDK-native language-model route aliases', () => {
  const { app } = buildServer();

  const postNative = (path: string) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'ai-language-model-id': 'minimax-m3' },
      body: JSON.stringify({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
    });

  for (const path of [
    '/language-model',
    '/v1/language-model',
    '/v1/ai/language-model',
    '/v1/llm/language-model',
    '/v1/openai/language-model',
  ]) {
    test(`${path} is mounted and returns a parseable JSON error, not a bare 404`, async () => {
      const res = await postNative(path);
      expect(res.status).not.toBe(404);
      expect(res.status).toBe(401);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = (await res.json()) as { error: { message: string } };
      // An OBJECT under `error` — a boolean/string here is what makes
      // @ai-sdk/gateway emit "Invalid error response format".
      expect(typeof body.error).toBe('object');
      expect(typeof body.error.message).toBe('string');
    });
  }
});
