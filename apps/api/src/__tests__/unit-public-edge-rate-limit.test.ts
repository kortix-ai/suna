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

test('a validated sandbox token spends its own budget, not its host address; a forged one does not', async () => {
  const { candidateSecretKeyHashesAsync, markTokenValidated, resetTokenHashCache } = await import('../shared/token-hash');
  resetTokenHashCache();
  setSystemTime(new Date('2026-11-03T12:00:00Z'));
  const app = new Hono();
  app.use('*', createPublicEdgeRateLimitMiddleware());
  app.all('*', (c) => c.json({ ok: true }));
  // Two boxes on one Platinum host: one egress address.
  const host = '51.158.248.121';
  const boxA = 'kortix_sb_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const boxB = 'kortix_sb_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  for (const token of [boxA, boxB]) {
    // What the auth middleware's validateSecretKey does on a live key row.
    await candidateSecretKeyHashesAsync(token);
    markTokenValidated(token);
  }
  const from = (token?: string) => ({ 'X-Forwarded-For': host, ...(token ? { Authorization: `Bearer ${token}` } : {}) });
  // Unauthenticated traffic from the host spends the address budget to zero.
  for (let i = 0; i < 300; i++) expect((await app.request('/v1/projects', { headers: from() })).status).toBe(200);
  expect((await app.request('/v1/projects', { headers: from() })).status).toBe(429);
  // A box with a validated token still gets through, on a budget of its own.
  const a = await app.request('/v1/projects/p1/turn-stream', { method: 'POST', headers: from(boxA) });
  expect(a.status).toBe(200);
  expect(a.headers.get('X-RateLimit-Remaining')).toBe('299');
  // A second box on the same host is not charged for the first.
  const b = await app.request('/v1/platform/boot-timeline', { method: 'POST', headers: from(boxB) });
  expect(b.headers.get('X-RateLimit-Remaining')).toBe('299');
  // A sandbox-shaped token this process never validated stays on the address budget.
  const forged = await app.request('/v1/projects', { headers: from('kortix_sb_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC') });
  expect(forged.status).toBe(429);
  // So does a validated key of another family: only sandbox tokens move.
  const userKey = 'kortix_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
  await candidateSecretKeyHashesAsync(userKey);
  markTokenValidated(userKey);
  expect((await app.request('/v1/projects', { headers: from(userKey) })).status).toBe(429);
  resetTokenHashCache();
});

test('a route that answers with a raw Response still carries the rate-limit headers', async () => {
  setSystemTime(new Date('2026-11-06T12:00:00Z'));
  const app = new Hono();
  app.use('*', createPublicEdgeRateLimitMiddleware());
  // Proxies and streams return a Response they built, which drops headers set before next().
  app.all('*', () => new Response('ok', { headers: { 'Content-Type': 'text/plain' } }));
  const response = await app.request('/v1/projects', { headers: { 'X-Forwarded-For': '198.51.100.7' } });
  expect(response.status).toBe(200);
  expect(response.headers.get('X-RateLimit-Limit')).toBe('300');
  expect(response.headers.get('X-RateLimit-Remaining')).toBe('299');
  expect(response.headers.get('Content-Type')).toBe('text/plain');
});

test('an inner limiter keeps its own rate-limit headers on the response', async () => {
  setSystemTime(new Date('2026-11-06T12:00:00Z'));
  const app = new Hono();
  app.use('*', createPublicEdgeRateLimitMiddleware());
  app.all('*', (c) => {
    c.header('X-RateLimit-Limit', '2');
    c.header('X-RateLimit-Remaining', '0');
    return c.json({ error: 'rate_limited' }, 429);
  });
  const response = await app.request('/v1/llm/x', { headers: { 'X-Forwarded-For': '198.51.100.9' } });
  expect(response.status).toBe(429);
  expect(response.headers.get('X-RateLimit-Limit')).toBe('2');
  expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
});

test('an upgrade response is returned untouched', async () => {
  setSystemTime(new Date('2026-11-06T12:00:00Z'));
  const app = new Hono();
  app.use('*', createPublicEdgeRateLimitMiddleware());
  const upgrade = new Response(null, { status: 200 });
  Object.defineProperty(upgrade, 'status', { value: 101 });
  app.all('*', () => upgrade);
  const response = await app.request('/v1/p/x/ws', { headers: { 'X-Forwarded-For': '198.51.100.8' } });
  expect(response).toBe(upgrade);
});
