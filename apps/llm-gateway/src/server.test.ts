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

  test('a measured 28 MiB multimodal request reaches one provider and returns intact', async () => {
    const originalFetch = globalThis.fetch;
    let providerCalls = 0;
    let providerBytes = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/internal/gateway/authorize')) {
        return Response.json({ ok: true, principal: { userId: 'u', accountId: 'a' } });
      }
      if (url.endsWith('/internal/gateway/resolve-route')) {
        return Response.json({ route: { policyId: 'direct', primaryModel: 'large-model' } });
      }
      if (url.endsWith('/internal/gateway/resolve-upstream')) {
        return Response.json({
          candidates: [
            {
              provider: 'mock',
              kind: 'openai-compat',
              baseUrl: 'https://provider.test/v1',
              apiKey: 'key',
              billingMode: 'none',
              markup: 0,
            },
          ],
        });
      }
      if (url.endsWith('/internal/gateway/usage') || url.endsWith('/internal/gateway/trace')) {
        return Response.json({ ok: true });
      }
      if (url === 'https://provider.test/v1/chat/completions') {
        providerCalls += 1;
        providerBytes = typeof init?.body === 'string' ? Buffer.byteLength(init.body) : 0;
        return Response.json({
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    try {
      const image = 'a'.repeat(28 * 1024 * 1024);
      const requestBody = JSON.stringify({
        model: 'large-model',
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } }],
          },
        ],
      });
      const response = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(requestBody)),
        },
        body: requestBody,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toHaveProperty('choices.0.message.content', 'ok');
      expect(providerCalls).toBe(1);
      expect(providerBytes).toBe(Buffer.byteLength(requestBody));
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 30_000);
});

describe('cloudflareSafe', () => {
  const { cloudflareSafe, UPSTREAM_STATUS_HEADER } = require('./server') as typeof import(
    './server',
  );

  test('maps a JSON 502 to 503, keeps the original status in header and body, sets retry-after', async () => {
    const res = await cloudflareSafe(
      new Response(
        JSON.stringify({ error: { code: 'upstream_error', message: 'provider down' } }),
        {
          status: 502,
          headers: { 'content-type': 'application/json', 'x-request-id': 'req_1' },
        },
      ),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get(UPSTREAM_STATUS_HEADER)).toBe('502');
    expect(res.headers.get('retry-after')).toBe('5');
    expect(res.headers.get('x-request-id')).toBe('req_1');
    expect(await res.json()).toMatchObject({
      error: { code: 'upstream_error' },
      upstream_status: 502,
    });
  });

  test('maps 504 and leaves every other status untouched', async () => {
    expect((await cloudflareSafe(new Response('x', { status: 504 }))).status).toBe(503);
    for (const status of [200, 400, 401, 402, 413, 429, 500, 503]) {
      const res = await cloudflareSafe(new Response('x', { status }));
      expect(res.status).toBe(status);
      expect(res.headers.get(UPSTREAM_STATUS_HEADER)).toBeNull();
    }
  });
});
