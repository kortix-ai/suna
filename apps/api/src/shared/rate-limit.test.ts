import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import {
  TokenBucketRateLimiter,
  consumeProjectSessionCreateBudget,
  createProjectSecretWriteRateLimitMiddleware,
  resetRateLimiters,
} from './rate-limit';
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

describe('consumeProjectSessionCreateBudget — hourly create ceiling', () => {
  test('the default budget admits exactly 100 creates then refuses with retry timing', () => {
    resetRateLimiters();
    for (let i = 0; i < 100; i++) {
      expect(consumeProjectSessionCreateBudget('proj-x').allowed).toBe(true);
    }
    const denied = consumeProjectSessionCreateBudget('proj-x');
    expect(denied.allowed).toBe(false);
    expect(denied.limit).toBe(100);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    resetRateLimiters();
  });

  test('projects never share a budget — one runaway cannot starve a neighbor', () => {
    resetRateLimiters();
    (config as any).KORTIX_PROJECT_SESSION_CREATES_PER_HOUR = 2;
    expect(consumeProjectSessionCreateBudget('runaway').allowed).toBe(true);
    expect(consumeProjectSessionCreateBudget('runaway').allowed).toBe(true);
    expect(consumeProjectSessionCreateBudget('runaway').allowed).toBe(false);
    expect(consumeProjectSessionCreateBudget('innocent').allowed).toBe(true);
    delete (config as any).KORTIX_PROJECT_SESSION_CREATES_PER_HOUR;
    resetRateLimiters();
  });
});
