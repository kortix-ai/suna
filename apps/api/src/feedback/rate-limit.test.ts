// The per-user feedback rate limiter: once the bucket is empty inside a
// minute the call answers 429 with Retry-After, and the hit is audited.
// Same mocking shape as apps/api/src/__tests__/e2e-rate-limits.test.ts.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

let auditRows: Array<Record<string, unknown>> = [];

mock.module('../config', () => ({
  config: { KORTIX_FEEDBACK_REQS_PER_MIN: 2 },
}));

mock.module('../shared/db', () => ({
  db: {
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          auditRows.push(values);
          return [];
        },
      }),
    }),
  },
}));

const { createFeedbackRateLimitMiddleware, resetRateLimiters } = await import(
  '../middleware/rate-limit'
);

function app() {
  const h = new Hono<{ Variables: { userId: string } }>();
  // Sets the identity the way supabaseAuth does before the limiter runs.
  h.use('*', async (c, next) => {
    const id = c.req.header('x-test-identity');
    if (id) c.set('userId', id);
    await next();
  });
  h.use('*', createFeedbackRateLimitMiddleware());
  h.post('/v1/feedback', (c) => c.json({ ok: true }));
  return h;
}

describe('the feedback rate limiter', () => {
  beforeEach(() => {
    auditRows = [];
    resetRateLimiters();
  });

  test('limits per user: the bucket refills for the next user', async () => {
    const h = app();
    const call = (user: string) =>
      h.request('/v1/feedback', { method: 'POST', headers: { 'x-test-identity': user } });

    expect((await call('user-a')).status).toBe(200);
    expect((await call('user-a')).status).toBe(200);
    const denied = await call('user-a');
    expect(denied.status).toBe(429);
    expect(denied.headers.get('Retry-After')).toBeTruthy();
    expect(await denied.json()).toMatchObject({ error: 'rate_limit_exceeded' });

    expect((await call('user-b')).status).toBe(200);
  });

  test('a hit writes one audit event named for the feedback limiter', async () => {
    const h = app();
    for (let i = 0; i < 3; i++) {
      await h.request('/v1/feedback', { method: 'POST', headers: { 'x-test-identity': 'user-a' } });
    }
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'api.rate_limit.exceeded',
      resourceType: 'feedback',
      resourceId: 'user-a',
      metadata: { limiter: 'feedback' },
    });
  });

  test('no identity on the context keys the bucket on the client ip', async () => {
    const h = new Hono();
    h.use('*', createFeedbackRateLimitMiddleware());
    h.post('/v1/feedback', (c) => c.json({ ok: true }));
    const call = () =>
      h.request('/v1/feedback', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '203.0.113.9', 'User-Agent': 'fb-test' },
      });

    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    const denied = await call();
    expect(denied.status).toBe(429);
    expect(auditRows[0]).toMatchObject({ resourceId: null, ip: '203.0.113.9' });
  });
});
