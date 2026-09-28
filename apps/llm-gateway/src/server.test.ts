import { describe, expect, test } from 'bun:test';

// `config` (imported transitively by `./server`) reads required env vars at
// module-load time — set them before the dynamic import below so this file
// can run standalone without a real Kortix API / gateway token.
process.env.KORTIX_API_URL = process.env.KORTIX_API_URL ?? 'https://api.test.invalid';
process.env.GATEWAY_INTERNAL_TOKEN = process.env.GATEWAY_INTERNAL_TOKEN ?? 'test-internal-token';

const { buildServer, cloudflareSafe, UPSTREAM_STATUS_HEADER, messagesAuthorization } = await import('./server');
const { InflightBudget } = await import('@kortix/llm-gateway');

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
      // Not the OpenAI-compat shape a chat completions 401 returns.
      expect((body as unknown as { code?: unknown }).code).toBeUndefined();
    });
  }

  // Anthropic SDKs, and Claude Code with ANTHROPIC_API_KEY, send the key as
  // `x-api-key`, not as a bearer token.
  test('messagesAuthorization accepts x-api-key when no Authorization header is set', () => {
    expect(messagesAuthorization(undefined, 'kortix_gw_abc')).toBe('Bearer kortix_gw_abc');
    expect(messagesAuthorization('Bearer kortix_gw_a', 'kortix_gw_b')).toBe('Bearer kortix_gw_a');
    expect(messagesAuthorization(undefined, undefined)).toBeUndefined();
    expect(messagesAuthorization(undefined, '  ')).toBeUndefined();
  });

  test('/v1/messages authenticates an x-api-key request instead of reporting a missing token', async () => {
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'kortix_gw_not_real' },
      body: JSON.stringify({ model: 'x', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).not.toBe('Missing bearer token');
  });

  test('an unregistered path 404s (sanity check against an accidental catch-all)', async () => {
    const res = await post('/v1/not-a-real-messages-route');
    expect(res.status).toBe(404);
  });

  // Piece: `POST /responses` (+ `/v1/responses`, `/v1/llm/responses`,
  // `/v1/openai/responses`) — Codex CLI >=0.157 only supports
  // `wire_api = "responses"` and cannot reach `/chat/completions` at all.
  // Proven here by the response using the Responses API error envelope
  // (`{error:{type,message,code,param}}`, no top-level `type`, unlike the
  // Anthropic envelope), which only `gateway.responses()` produces.
  const postResponses = (path: string) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codex/gpt-6-sol', input: 'hi' }),
    });

  for (const path of ['/responses', '/v1/responses', '/v1/llm/responses', '/v1/openai/responses']) {
    test(`${path} is registered and speaks the Responses API error envelope`, async () => {
      const res = await postResponses(path);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { type?: unknown; error: { type: string; message: string } };
      expect(body.type).toBeUndefined();
      expect(body.error.type).toBe('invalid_request_error');
      expect(body.error.message).toBe('Missing bearer token');
      expect((body as unknown as { code?: unknown }).code).toBeUndefined();
    });
  }

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

describe('standalone chat and messages admission', () => {
  const routes = [
    '/chat/completions', '/v1/chat/completions', '/v1/llm/chat/completions', '/v1/openai/chat/completions',
    '/messages', '/v1/messages', '/v1/llm/messages', '/v1/openai/messages',
  ];
  const payload = JSON.stringify({ model: 'x', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] });
  const budget = () => new InflightBudget({ maxBytes: 1024, perRequestMaxBytes: 1024, amplification: 1 });

  for (const path of routes) {
    test(`${path} rejects declared oversized bodies before dispatch`, async () => {
      const inflight = budget();
      const { app } = buildServer({ inflight });
      const res = await app.request(path, {
        method: 'POST', headers: { 'content-length': '1025' }, body: payload,
      });
      expect(res.status).toBe(413);
      expect((await res.json()) as Record<string, unknown>).toHaveProperty('code', 'request_too_large');
      expect(res.headers.get('retry-after')).toBeNull();
      expect(inflight.inflightBytes).toBe(0);
    });

    test(`${path} reports temporary overload and releases no new capacity`, async () => {
      const inflight = budget();
      const held = inflight.admit(1024);
      expect(held.ok).toBe(true);
      const { app } = buildServer({ inflight });
      try {
        const res = await app.request(path, {
          method: 'POST', headers: { 'content-length': String(Buffer.byteLength(payload)) }, body: payload,
        });
        expect(res.status).toBe(503);
        expect((await res.json()) as Record<string, unknown>).toHaveProperty('code', 'gateway_overloaded');
        expect(res.headers.get('retry-after')).toBe('1');
        expect(inflight.inflightBytes).toBe(1024);
      } finally {
        if (held.ok) held.release();
      }
      expect(inflight.inflightBytes).toBe(0);
    });
  }

  for (const path of ['/v1/chat/completions', '/v1/messages']) {
    test(`${path} releases an aborted upload without recording a health error`, async () => {
      const inflight = budget();
      const { app } = buildServer({ inflight });
      const abort = new AbortController();
      const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } });
      const pending = app.fetch(new Request(`http://localhost${path}`, {
        method: 'POST', body, duplex: 'half', signal: abort.signal,
      } as RequestInit));
      await new Promise((resolve) => setTimeout(resolve, 10));
      abort.abort();
      const res = await pending;
      expect(res.status).toBe(503);
      expect((await res.json()) as Record<string, unknown>).toHaveProperty('code', 'gateway_overloaded');
      expect(inflight.inflightBytes).toBe(0);
    });
  }

  test('chat and messages streaming aliases relay provider bytes and release admission on completion', async () => {
    const originalFetch = globalThis.fetch;
    const inflight = budget();
    const { app, inflightRequests } = buildServer({ inflight });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/internal/gateway/authorize')) return Response.json({ ok: true, principal: { userId: 'u', accountId: 'a' } });
      if (url.endsWith('/internal/gateway/resolve-route')) return Response.json({ route: { policyId: 'direct', primaryModel: 'x' } });
      if (url.endsWith('/internal/gateway/resolve-upstream')) return Response.json({ candidates: [{ provider: 'mock', kind: 'openai-compat', baseUrl: 'https://provider.test/v1', apiKey: 'key', billingMode: 'none', markup: 0 }] });
      if (url.endsWith('/internal/gateway/usage') || url.endsWith('/internal/gateway/trace')) return Response.json({ ok: true });
      if (url === 'https://provider.test/v1/chat/completions') return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    try {
      for (const path of ['/v1/llm/chat/completions', '/v1/openai/messages']) {
        const res = await app.request(path, { method: 'POST', headers: { authorization: 'Bearer token', 'content-type': 'application/json' }, body: JSON.stringify({ ...JSON.parse(payload), stream: true }) });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');
        expect(await res.text()).toContain(path.includes('/messages') ? 'event: message_stop' : 'data: [DONE]');
        expect(inflight.inflightBytes).toBe(0);
        expect(inflightRequests()).toBe(0);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
