import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { Hono } from 'hono';
import { createPublicEdgeRateLimitMiddleware } from '../middleware/public-edge-rate-limit';

afterEach(() => setSystemTime());

test('auth budget decrements on rejections and stops before the handler', async () => {
  setSystemTime(new Date('2026-11-02T12:00:00Z'));
  const app = new Hono();
  app.use('*', createPublicEdgeRateLimitMiddleware());
  let calls = 0;
  app.all('*', (c) => { calls++; return c.json({ error: 'unauthorized' }, 401); });
  const from = { 'X-Forwarded-For': '203.0.113.9' };
  for (let i = 0; i < 30; i++) {
    const response = await app.request('/v1/auth/sign-in', { method: 'POST', headers: from });
    expect(response.status).toBe(401);
    expect(response.headers.get('X-RateLimit-Limit')).toBe('30');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe(String(29 - i));
  }
  const blocked = await app.request('/v1/oauth/token', { method: 'POST', headers: from });
  expect(blocked.status).toBe(429);
  expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
  expect(calls).toBe(30);
});

test('public auth families share an address budget independent of general API traffic', async () => {
  setSystemTime(new Date('2026-11-02T12:00:00Z'));
  const app = new Hono();
  app.use('*', createPublicEdgeRateLimitMiddleware());
  app.all('*', (c) => c.json({ ok: true }));
  let remaining = 30;
  const from = { 'X-Forwarded-For': '203.0.113.9' };
  for (const path of ['/v1/auth/client-config', '/v1/oauth/token', '/v1/access/check-email', '/v1/tunnel/device-auth']) {
    const response = await app.request(path, { headers: from });
    expect(response.headers.get('X-RateLimit-Remaining')).toBe(String(--remaining));
  }
  expect((await app.request('/v1/health', { headers: from })).headers.get('X-RateLimit-Limit')).toBeNull();
  for (const path of ['/v1/projects', '/v1/authentication']) {
    expect((await app.request(path, { headers: from })).headers.get('X-RateLimit-Limit')).toBe('300');
  }
  const preflight = await app.request('/v1/auth/sign-in', { method: 'OPTIONS' });
  expect(preflight.headers.get('X-RateLimit-Limit')).toBeNull();
  const otherAddress = await app.request('/v1/auth/sign-in', { headers: { 'X-Forwarded-For': '192.0.2.5' } });
  expect(otherAddress.headers.get('X-RateLimit-Remaining')).toBe('29');
  // No forwarding header at all: no address, so no budget is spent.
  expect((await app.request('/v1/auth/sign-in')).headers.get('X-RateLimit-Limit')).toBeNull();
});

test('API rejections share a general budget across routes and return retry headers', async () => {
  setSystemTime(new Date('2026-11-02T12:00:00Z'));
  const app = new Hono();
  app.use('*', createPublicEdgeRateLimitMiddleware());
  let calls = 0;
  app.all('*', (c) => { calls++; return c.json({ error: 'unauthorized' }, 401); });
  const headers = { 'X-Forwarded-For': '192.0.2.10' };
  for (let i = 0; i < 300; i++) {
    const response = await app.request(i % 2 ? '/v1/projects' : '/v1/missing', { headers });
    expect(response.status).toBe(401);
    expect(response.headers.get('X-RateLimit-Limit')).toBe('300');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe(String(299 - i));
  }
  const blocked = await app.request('/v1/accounts', { headers });
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get('X-RateLimit-Remaining')).toBe('0');
  expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
  expect(Number(blocked.headers.get('X-RateLimit-Reset'))).toBeGreaterThan(0);
  expect(blocked.headers.get('Cache-Control')).toBe('no-store');
  expect(await blocked.json()).toMatchObject({ error: 'rate_limit_exceeded' });
  expect(calls).toBe(300);
  setSystemTime(new Date('2026-11-02T12:00:00.200Z'));
  const recovered = await app.request('/v1/accounts', { headers });
  expect(recovered.status).toBe(401);
  expect(recovered.headers.get('X-RateLimit-Remaining')).toBe('0');
  expect((await app.request('/v1/accounts', { headers })).status).toBe(429);
  expect((await app.request('/v1/projects', { headers: { 'X-Forwarded-For': '192.0.2.11' } })).status).toBe(401);
  for (const path of ['/v1/health', '/v1/health/live', '/v1/health/ready']) {
    expect((await app.request(path, { headers })).status).toBe(401);
  }
  expect((await app.request('/v1/projects', { method: 'OPTIONS', headers })).status).toBe(401);
});
