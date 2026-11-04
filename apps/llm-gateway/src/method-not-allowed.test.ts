import { describe, expect, test } from 'bun:test';

process.env.KORTIX_API_URL ??= 'https://api.test.invalid';
process.env.GATEWAY_INTERNAL_TOKEN ??= 'test-internal-token';
const { buildServer } = await import('./server');
const { app } = buildServer();

describe('gateway method negotiation', () => {
  for (const prefix of ['/', '/v1/', '/v1/llm/', '/v1/openai/']) {
    for (const route of ['models', 'audio/voices', 'chat/completions', 'messages', 'responses', 'images/generations', 'images/edits', 'audio/transcriptions', 'audio/speech']) {
      const allow = ['models', 'audio/voices'].includes(route) ? 'GET, HEAD' : 'POST';
      for (const authorization of [undefined, 'Bearer synthetic-invalid-token']) {
        test(`PUT ${prefix}${route} advertises ${allow}, authorization=${!!authorization}`, async () => {
          const response = await app.request(`${prefix}${route}?scope=managed`, {
            method: 'PUT', headers: authorization ? { authorization } : {},
          });
          expect(response.status).toBe(405);
          expect(response.headers.get('allow')).toBe(allow);
          expect(response.headers.get('cache-control')).toBe('private, no-store');
        });
      }
    }
  }

  for (const path of ['/health/live', '/health', '/robots.txt', '/sitemap.xml', '/.well-known/security.txt']) {
    test(`DELETE ${path} advertises GET and implicit HEAD`, async () => {
      const response = await app.request(path, { method: 'DELETE' });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET, HEAD');
    });
  }

  for (const method of ['GET', 'POST', 'HEAD', 'OPTIONS', 'DELETE']) {
    test(`${method} on an unknown path remains 404`, async () => {
      const response = await app.request('/v1/not-a-route', { method });
      expect(response.status).toBe(404);
      expect(response.headers.has('allow')).toBe(false);
    });
  }

  for (const method of ['OPTIONS', 'DELETE', 'PATCH', 'POST']) {
    test(`${method} on models returns 405`, async () => {
      const response = await app.request('/v1/models', { method });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET, HEAD');
    });
  }

  test('HEAD on a POST-only route returns a bodyless 405', async () => {
    const response = await app.request('/v1/messages', { method: 'HEAD' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(await response.text()).toBe('');
  });

  test('Claude Code wildcard dispatch remains method-agnostic', async () => {
    const response = await app.request('/v1/claude-code/api/hello', { method: 'GET' });
    expect(response.status).toBe(200);
    expect(response.headers.has('allow')).toBe(false);
  });

  test('GET and implicit HEAD still reach model authentication', async () => {
    for (const method of ['GET', 'HEAD']) {
      const response = await app.request('/v1/models', { method });
      expect(response.status).toBe(401);
      expect(response.headers.has('allow')).toBe(false);
      if (method === 'HEAD') expect(await response.text()).toBe('');
    }
  });

  test('POST still reaches inference authentication', async () => {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'synthetic-model', messages: [] }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.has('allow')).toBe(false);
  });
});
