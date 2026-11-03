import { describe, expect, test } from 'bun:test';

process.env.KORTIX_API_URL ??= 'https://api.test.invalid';
process.env.GATEWAY_INTERNAL_TOKEN ??= 'test-internal-token';

const { buildServer } = await import('./server');

const cases = [
  { path: '/health/live', method: 'GET', status: 200 },
  { path: '/missing', method: 'GET', status: 404 },
  { path: '/v1/models', method: 'GET', status: 401 },
  { path: '/v1/messages', method: 'POST', status: 401 },
  { path: '/v1/responses', method: 'POST', status: 401 },
  { path: '/v1/chat/completions', method: 'POST', status: 401 },
];

describe('standalone gateway security headers', () => {
  const { app } = buildServer();

  for (const { path, method, status } of cases) {
    test(`${method} ${path} retains its status and denies browser capabilities`, async () => {
      const response = await app.request(path, {
        method,
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('content-security-policy')).toBe("default-src 'none';frame-ancestors 'none'");
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      const policy = response.headers.get('permissions-policy');
      expect(policy).not.toBeNull();
      for (const feature of ['camera', 'microphone', 'geolocation', 'sync-xhr', 'payment', 'usb', 'fullscreen', 'display-capture', 'publickey-credentials-get']) {
        expect(policy?.split(', ').includes(`${feature}=()`)).toBe(true);
      }
      expect(policy?.split(',').every((directive) => directive.trim().endsWith('=()'))).toBe(true);
      await response.text();
    });
  }

  for (const status of [200, 403]) {
    test(`credential-bearing ${status} responses override cacheable upstream headers`, async () => {
      const { app: responseApp } = buildServer();
      responseApp.get('/test-response', () => new Response('synthetic response', {
        status,
        headers: { 'cache-control': 'public, max-age=3600' },
      }));
      const response = await responseApp.request('/test-response', {
        headers: { authorization: 'Bearer synthetic-token' },
      });
      expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.text()).toBe('synthetic response');
    });
  }

  test('streaming responses retain their body and cannot be cached', async () => {
    const { app: streamApp } = buildServer();
    streamApp.get('/test-stream', () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: synthetic\n\n'));
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } }));
    const response = await streamApp.request('/test-stream', {
      headers: { 'x-api-key': 'synthetic-token' },
    });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toBe('data: synthetic\n\n');
  });

  test('unhandled errors also carry the policy', async () => {
    const { app: errorApp } = buildServer();
    errorApp.get('/test-error', () => { throw new Error('synthetic failure'); });
    const response = await errorApp.request('/test-error');
    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none';frame-ancestors 'none'");
    expect(response.headers.get('permissions-policy')).toContain('camera=()');
    await response.text();
  });
});
