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
