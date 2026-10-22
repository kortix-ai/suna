import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createPublicEdgeRateLimitMiddleware } from '../middleware/public-edge-rate-limit';

test('auth budget decrements on rejections and stops before the handler', async () => {
  const app = new Hono();
  app.use('*', createPublicEdgeRateLimitMiddleware());
  let calls = 0;
  app.all('*', (c) => { calls++; return c.json({ error: 'unauthorized' }, 401); });
  for (let i = 0; i < 30; i++) {
    const response = await app.request('/v1/auth/sign-in', { method: 'POST' });
    expect(response.status).toBe(401);
    expect(response.headers.get('X-RateLimit-Limit')).toBe('30');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe(String(29 - i));
  }
  const blocked = await app.request('/v1/oauth/token', { method: 'POST' });
  expect(blocked.status).toBe(429);
  expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
  expect(calls).toBe(30);
});

test('public auth families share an address budget, unrelated routes and preflight do not', async () => {
  const app = new Hono();
  app.use('*', createPublicEdgeRateLimitMiddleware());
  app.all('*', (c) => c.json({ ok: true }));
  let remaining = 30;
  for (const path of ['/v1/auth/client-config', '/v1/oauth/token', '/v1/access/check-email', '/v1/tunnel/device-auth']) {
    const response = await app.request(path);
    expect(response.headers.get('X-RateLimit-Remaining')).toBe(String(--remaining));
  }
  for (const path of ['/v1/health', '/v1/projects', '/v1/authentication']) {
    expect((await app.request(path)).headers.get('X-RateLimit-Limit')).toBeNull();
  }
  const preflight = await app.request('/v1/auth/sign-in', { method: 'OPTIONS' });
  expect(preflight.headers.get('X-RateLimit-Limit')).toBeNull();
  const otherAddress = await app.request('/v1/auth/sign-in', { headers: { 'X-Forwarded-For': '192.0.2.5' } });
  expect(otherAddress.headers.get('X-RateLimit-Remaining')).toBe('29');
});
