import { describe, expect, spyOn, test } from 'bun:test';

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
      // An API that serves the one-call admission.
      if (url.endsWith('/internal/gateway/admit')) {
        return Response.json({
          admission: { ok: true, principal: { userId: 'u', accountId: 'a' } },
          route: { policyId: 'direct', primaryModel: 'large-model' },
          candidates: [
            { provider: 'mock', kind: 'openai-compat', baseUrl: 'https://provider.test/v1', apiKey: 'key', billingMode: 'none', markup: 0 },
          ],
        });
      }
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

// KRTX-4427: an OpenAI-compatible client picks its model from `GET /v1/models`.
// Unscoped, that route served the whole discovery catalog as a `{models:{}}`
// map, so a key with no plan and no provider got thousands of ids that all
// answer 400. Unscoped now lists only what the key's project offers (the
// `scope=picker` set) in the OpenAI list shape; `scope=all` keeps the catalog.
describe('standalone model listing', () => {
  const { app } = buildServer();
  const PICKER = {
    'kortix/callable': { name: 'Callable', provider: 'kortix', enabled: true },
    'openai/turned-off': { name: 'Turned off', provider: 'openai', enabled: false },
    'anthropic/not-connected': { name: 'Not connected', provider: 'anthropic', enabled: true, available: false },
  };
  const ALL = { ...PICKER, 'acme/needs-a-key': { name: 'Needs a key', availability: 'provider' } };

  // Only the API's internal endpoints are faked; routes, gateway and API client run for real.
  async function list(path: string) {
    const asked: unknown[] = [];
    const api = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/internal/gateway/authenticate')) {
        return Response.json({ principal: { userId: 'u', accountId: 'a', projectId: 'p' } });
      }
      if (url.endsWith('/internal/gateway/models')) {
        const body = JSON.parse(String(init?.body)) as { managedOnly: boolean; scope?: string };
        asked.push({ managedOnly: body.managedOnly, scope: body.scope });
        return Response.json({ models: body.scope === 'picker' ? PICKER : ALL });
      }
      throw new Error(`unexpected fetch ${url}`);
    }, { preconnect: globalThis.fetch.preconnect }));
    try {
      const res = await app.request(path, { headers: { authorization: 'Bearer kortix_gw_test' } });
      return { status: res.status, body: (await res.json()) as Record<string, unknown>, asked };
    } finally {
      api.mockRestore();
    }
  }

  for (const path of ['/models', '/v1/models', '/v1/llm/models', '/v1/openai/models', '/v1/models?scope=unknown']) {
    test(`${path} lists only the models the key can call, in the OpenAI list shape`, async () => {
      const { status, body, asked } = await list(path);
      expect(status).toBe(200);
      expect(asked).toEqual([{ managedOnly: false, scope: 'picker' }]);
      expect(body).toEqual({
        object: 'list',
        data: [{ id: 'kortix/callable', object: 'model', created: 0, owned_by: 'kortix', name: 'Callable', provider: 'kortix', enabled: true }],
      });
    });
  }

  test('scope=all keeps the full discovery catalog as the keyed map', async () => {
    const { body, asked } = await list('/v1/models?scope=all');
    expect(asked).toEqual([{ managedOnly: false, scope: undefined }]);
    expect(body).toEqual({ models: ALL });
  });

  test('scope=picker and scope=managed keep the keyed map sandboxes read at boot', async () => {
    const picker = await list('/v1/models?scope=picker');
    expect(picker.asked).toEqual([{ managedOnly: false, scope: 'picker' }]);
    expect(picker.body).toEqual({ models: PICKER });
    const managed = await list('/v1/models?scope=managed');
    expect(managed.asked).toEqual([{ managedOnly: true, scope: undefined }]);
    expect(managed.body).toEqual({ models: ALL });
  });
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
      // An older API without the one-call admission: the gateway uses the separate calls.
      if (url.endsWith('/internal/gateway/admit')) return Response.json({ error: 'not found' }, { status: 404 });
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

describe('public discovery without credentials', () => {
  const { app } = buildServer();
  for (const path of ['/.well-known/security.txt', '/robots.txt', '/sitemap.xml']) {
    test(path, async () => {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain('/admin');
      if (path.endsWith('security.txt')) expect(text).toContain('Contact: mailto:security@kortix.com');
      if (path === '/sitemap.xml') expect(text).not.toContain('<loc>');
    });
  }
});

const { registerRoutes } = await import('./routes');
const { Hono } = await import('hono');

describe('standalone image routes', () => {
  function imageApp(inflight = new InflightBudget({ maxBytes: 1024 * 1024, perRequestMaxBytes: 1024 * 1024, amplification: 1 })) {
    const calls: { authorization: string | undefined; rawBody: string; operation: string }[] = [];
    const unused = async (): Promise<Response> => { throw new Error('not an image route'); };
    const app = new Hono();
    registerRoutes(app, {
      chatCompletions: unused, messages: unused, responses: unused, listModels: unused, claudeCode: unused,
      audio: unused, voices: unused,
      images: async (request) => {
        calls.push({ authorization: request.authorization, rawBody: request.rawBody, operation: request.operation });
        return Response.json({ data: [{ b64_json: 'AAAA' }] });
      },
    }, inflight, () => {}, () => null);
    return { app, calls, inflight };
  }

  test('POST /v1/images/generations reaches gateway.images with operation generations', async () => {
    const { app, calls, inflight } = imageApp();
    const body = JSON.stringify({ model: 'codex/gpt-image-2', prompt: 'a red cube' });
    const res = await app.request('/v1/images/generations', {
      method: 'POST', headers: { authorization: 'Bearer token', 'content-type': 'application/json' }, body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('data.0.b64_json', 'AAAA');
    expect(calls).toEqual([{ authorization: 'Bearer token', rawBody: body, operation: 'generations' }]);
    expect(inflight.inflightBytes).toBe(0);
    for (const path of ['/images/edits', '/v1/llm/images/edits', '/v1/openai/images/generations']) {
      expect((await app.request(path, { method: 'POST', body })).status).toBe(200);
    }
    expect(calls.map((call) => call.operation)).toEqual(['generations', 'edits', 'edits', 'generations']);
  });

  test('an oversized image body is 413 before gateway.images runs', async () => {
    const { app, calls, inflight } = imageApp(new InflightBudget({ maxBytes: 1024, perRequestMaxBytes: 1024, amplification: 1 }));
    const res = await app.request('/v1/images/edits', {
      method: 'POST', headers: { 'content-length': '1025' }, body: 'x'.repeat(1025),
    });
    expect(res.status).toBe(413);
    expect((await res.json()) as Record<string, unknown>).toHaveProperty('code', 'request_too_large');
    expect(calls).toHaveLength(0);
    expect(inflight.inflightBytes).toBe(0);
  });
});

describe('standalone audio routes', () => {
  function audioApp(inflight = new InflightBudget({ maxBytes: 1024 * 1024, perRequestMaxBytes: 1024 * 1024, amplification: 1 })) {
    const calls: { operation: string; authorization: string | undefined; contentType: string; body: Uint8Array<ArrayBuffer> }[] = [];
    const voices: { authorization: string | undefined; model: string }[] = [];
    const unused = async (): Promise<Response> => { throw new Error('not an audio route'); };
    const app = new Hono();
    registerRoutes(app, {
      chatCompletions: unused, messages: unused, responses: unused, listModels: unused, images: unused, claudeCode: unused,
      audio: async (request) => {
        calls.push({ operation: request.operation, authorization: request.authorization, contentType: request.contentType, body: request.body });
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/pcm' } });
      },
      voices: async (request) => {
        voices.push({ authorization: request.authorization, model: request.model });
        return Response.json({ object: 'list', data: [] });
      },
    }, inflight, () => {}, () => null);
    return { app, calls, voices, inflight };
  }

  test('a multipart upload reaches gateway.audio byte for byte, on every alias prefix', async () => {
    const { app, calls, inflight } = audioApp();
    // Bytes that are not valid UTF-8: a text decode would replace them.
    const audioBytes = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0xc3]);
    const form = new FormData();
    form.append('model', 'whisper-large-v3-turbo');
    form.append('file', new File([audioBytes], 'clip.wav', { type: 'audio/wav' }));
    const upload = new Request('http://gateway/v1/audio/transcriptions', { method: 'POST', body: form });
    const contentType = upload.headers.get('content-type')!;
    const bytes = new Uint8Array(await upload.arrayBuffer());
    for (const path of ['/audio/transcriptions', '/v1/audio/transcriptions', '/v1/llm/audio/transcriptions', '/v1/openai/audio/transcriptions']) {
      const res = await app.request(path, { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': contentType }, body: bytes });
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    }
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call).toMatchObject({ operation: 'transcriptions', authorization: 'Bearer t', contentType });
      expect(call.body).toEqual(bytes);
    }
    const parsed = await new Response(calls[0]!.body, { headers: { 'content-type': contentType } }).formData();
    expect(new Uint8Array(await (parsed.get('file') as File).arrayBuffer())).toEqual(audioBytes);
    expect(inflight.inflightBytes).toBe(0);
  });

  test('speech reaches gateway.audio with operation speech; voices reads ?model=', async () => {
    const { app, calls, voices } = audioApp();
    const body = JSON.stringify({ model: 'tts-x', input: 'hello', voice: 'v1' });
    expect((await app.request('/v1/audio/speech', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(200);
    expect(calls.map((call) => [call.operation, new TextDecoder().decode(call.body)])).toEqual([['speech', body]]);
    expect((await app.request('/v1/llm/audio/voices?model=tts-x', { headers: { authorization: 'Bearer t' } })).status).toBe(200);
    expect(voices).toEqual([{ authorization: 'Bearer t', model: 'tts-x' }]);
  });

  test('an oversized upload is 413 before gateway.audio runs', async () => {
    const { app, calls, inflight } = audioApp(new InflightBudget({ maxBytes: 1024, perRequestMaxBytes: 1024, amplification: 1 }));
    const res = await app.request('/v1/audio/transcriptions', {
      method: 'POST', headers: { 'content-length': '1025' }, body: 'x'.repeat(1025),
    });
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
    expect(inflight.inflightBytes).toBe(0);
  });
});

describe('standalone Claude Code passthrough routes', () => {
  function claudeApp() {
    const calls: Array<{ method: string; path: string; search: string; body: string | null; auth: string | null }> = [];
    const unused = async (): Promise<Response> => { throw new Error('not a Claude Code route'); };
    const app = new Hono();
    registerRoutes(app, {
      chatCompletions: unused, messages: unused, responses: unused, listModels: unused, images: unused,
      audio: unused, voices: unused,
      claudeCode: async (request) => {
        calls.push({ method: request.method, path: request.path, search: request.search,
          body: request.body ? new TextDecoder().decode(request.body) : null, auth: request.headers.get('authorization') });
        return new Response('data: ok\n\n', { headers: { 'content-type': 'text/event-stream' } });
      },
    }, new InflightBudget({ maxBytes: 1024 * 1024, perRequestMaxBytes: 1024 * 1024, amplification: 1 }), () => {}, () => null);
    return { app, calls };
  }

  test('every alias prefix reaches the passthrough with the path after claude-code, the query and the exact body', async () => {
    const { app, calls } = claudeApp();
    const body = '{"model":"claude-haiku-5-5","messages":[{"role":"user","content":"é"}]}';
    for (const prefix of ['', '/v1', '/v1/llm']) {
      const res = await app.request(`${prefix}/claude-code/v1/messages?beta=true`, {
        method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body,
      });
      expect(res.status).toBe(200);
    }
    expect(calls).toEqual([0, 1, 2].map(() => ({ method: 'POST', path: '/v1/messages', search: '?beta=true', body, auth: 'Bearer t' })));
  });

  test('the connectivity check reaches the passthrough without a body', async () => {
    const { app, calls } = claudeApp();
    expect((await app.request('/claude-code/api/hello', { method: 'HEAD' })).status).toBe(200);
    expect(calls).toEqual([{ method: 'HEAD', path: '/api/hello', search: '', body: null, auth: null }]);
  });
});
