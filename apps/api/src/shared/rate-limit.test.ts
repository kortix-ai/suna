import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { Hono } from 'hono';

import { TokenBucketRateLimiter } from './rate-limit';
import { createProjectSecretWriteRateLimitMiddleware, createProjectWebhookRateLimitMiddleware, resetRateLimiters } from '../middleware/rate-limit';
import { config } from '../config';

describe('TokenBucketRateLimiter bounded buckets', () => {
  test('a flood of unique keys never grows the internal Map without bound', () => {
    const limiter = new TokenBucketRateLimiter('test');
    const policy = { limit: 60, windowMs: 60_000 };
    for (let i = 0; i < 120_000; i++) {
      limiter.check(`unique-key-${i}`, policy);
    }
    const size = (limiter as unknown as { buckets: Map<string, unknown> }).buckets.size;
    expect(size).toBeLessThanOrEqual(50_000);
  });

  test('a stable key keeps its bucket across checks (rate limiting still works)', () => {
    const limiter = new TokenBucketRateLimiter('test');
    const policy = { limit: 3, windowMs: 60_000 };
    expect(limiter.check('same', policy).allowed).toBe(true);
    expect(limiter.check('same', policy).allowed).toBe(true);
    expect(limiter.check('same', policy).allowed).toBe(true);
    expect(limiter.check('same', policy).allowed).toBe(false);
  });
});

// KRTX-3408: the headers said `X-RateLimit-Reset: 60` on every response,
// whatever the bucket held. A bucket of 600 per minute gains a token every
// 100 ms, so 599 left is full again in 100 ms, and a denied caller gets a
// token back in 100 ms, not 60 s.
describe('TokenBucketRateLimiter timing', () => {
  const T0 = new Date('2026-10-27T12:00:00.000Z').getTime();
  const at = (ms: number) => setSystemTime(new Date(T0 + ms));
  afterEach(() => setSystemTime());

  test('resetMs is the time until the bucket is full again', () => {
    const limiter = new TokenBucketRateLimiter('timing');
    const policy = { limit: 600, windowMs: 60_000 };
    at(0);
    expect(limiter.check('k', policy)).toMatchObject({ allowed: true, remaining: 599, resetMs: 100 });
    for (let i = 0; i < 8; i++) limiter.check('k', policy);
    expect(limiter.check('k', policy)).toMatchObject({ remaining: 590, resetMs: 1_000 });
    at(250);
    // Two tokens came back (2 × 100 ms); 50 ms count toward the third.
    expect(limiter.check('k', policy)).toMatchObject({ remaining: 591, resetMs: 850 });
  });

  test('a denied check retries after one token, and resets after all of them', () => {
    const limiter = new TokenBucketRateLimiter('timing');
    const policy = { limit: 2, windowMs: 60_000 };
    at(0);
    limiter.check('k', policy);
    limiter.check('k', policy);
    expect(limiter.check('k', policy)).toMatchObject({ allowed: false, remaining: 0, retryAfterMs: 30_000, resetMs: 60_000 });
    at(10_000);
    expect(limiter.check('k', policy)).toMatchObject({ allowed: false, retryAfterMs: 20_000, resetMs: 50_000 });
    at(30_000);
    expect(limiter.check('k', policy)).toMatchObject({ allowed: true, remaining: 0, resetMs: 60_000 });
  });

  test('a full bucket starts counting a token only when it is first drawn', () => {
    const limiter = new TokenBucketRateLimiter('timing');
    const policy = { limit: 600, windowMs: 60_000 };
    at(0);
    limiter.check('k', policy);
    at(10_000);
    expect(limiter.check('k', policy)).toMatchObject({ remaining: 599, resetMs: 100 });
  });

  test('a one-token bucket keeps its 60 s answers', () => {
    const limiter = new TokenBucketRateLimiter('timing');
    const policy = { limit: 1, windowMs: 60_000 };
    at(0);
    expect(limiter.check('k', policy)).toMatchObject({ allowed: true, remaining: 0, resetMs: 60_000 });
    expect(limiter.check('k', policy)).toMatchObject({ allowed: false, retryAfterMs: 60_000, resetMs: 60_000 });
  });
});

describe('createProjectSecretWriteRateLimitMiddleware — the 2026-08-21 storm breaker', () => {
  function appWithLimit(limit: number) {
    resetRateLimiters();
    (config as any).KORTIX_PROJECT_SECRET_WRITES_PER_HOUR = limit;
    const app = new Hono();
    app.use('/:projectId/secrets/*', createProjectSecretWriteRateLimitMiddleware());
    app.post('/:projectId/secrets', (c) => c.json({ ok: true }));
    app.post('/:projectId/secrets/:name/broker', (c) => c.json({ ok: true }));
    app.get('/:projectId/secrets', (c) => c.json({ ok: true }));
    return app;
  }

  test('writes past the budget 429 with the loop-explaining code', async () => {
    const app = appWithLimit(3);
    for (let i = 0; i < 3; i++) {
      const res = await app.request('/proj-a/secrets', { method: 'POST' });
      expect(res.status).toBe(200);
    }
    const blocked = await app.request('/proj-a/secrets', { method: 'POST' });
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { code?: string };
    expect(body.code).toBe('project_secret_write_limit');
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
    delete (config as any).KORTIX_PROJECT_SECRET_WRITES_PER_HOUR;
    resetRateLimiters();
  });

  test('nested write routes (broker) draw from the same project budget', async () => {
    const app = appWithLimit(2);
    expect((await app.request('/proj-b/secrets', { method: 'POST' })).status).toBe(200);
    expect(
      (await app.request('/proj-b/secrets/TELEGRAM_BOT_TOKEN/broker', { method: 'POST' })).status,
    ).toBe(200);
    expect(
      (await app.request('/proj-b/secrets/TELEGRAM_BOT_TOKEN/broker', { method: 'POST' })).status,
    ).toBe(429);
    delete (config as any).KORTIX_PROJECT_SECRET_WRITES_PER_HOUR;
    resetRateLimiters();
  });

  test('reads are never throttled and projects are independent', async () => {
    const app = appWithLimit(1);
    expect((await app.request('/proj-c/secrets', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/proj-c/secrets', { method: 'POST' })).status).toBe(429);
    for (let i = 0; i < 5; i++) {
      expect((await app.request('/proj-c/secrets', { method: 'GET' })).status).toBe(200);
    }
    expect((await app.request('/proj-d/secrets', { method: 'POST' })).status).toBe(200);
    delete (config as any).KORTIX_PROJECT_SECRET_WRITES_PER_HOUR;
    resetRateLimiters();
  });
});

describe('IP-keyed limiters read the caller through the trusted-proxy rule', () => {
  function webhookApp(limit: number) {
    resetRateLimiters();
    (config as any).KORTIX_PROJECT_WEBHOOK_REQS_PER_MIN = limit;
    const app = new Hono();
    app.use('/:projectId/hook', createProjectWebhookRateLimitMiddleware());
    app.post('/:projectId/hook', (c) => c.json({ ok: true }));
    return app;
  }

  test('a fresh forged X-Forwarded-For per request does not buy a fresh bucket', async () => {
    const app = webhookApp(3);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await app.request('/proj-ip/hook', {
        method: 'POST',
        headers: { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.7, 172.70.1.2` },
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    delete (config as any).KORTIX_PROJECT_WEBHOOK_REQS_PER_MIN;
    resetRateLimiters();
  });

  test('two real callers behind the same proxies keep separate buckets', async () => {
    const app = webhookApp(1);
    const first = await app.request('/proj-ip/hook', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.7, 172.70.1.2' },
    });
    const second = await app.request('/proj-ip/hook', {
      method: 'POST',
      headers: { 'x-forwarded-for': '198.51.100.4, 172.70.1.2' },
    });
    expect([first.status, second.status]).toEqual([200, 200]);
    delete (config as any).KORTIX_PROJECT_WEBHOOK_REQS_PER_MIN;
    resetRateLimiters();
  });
});
