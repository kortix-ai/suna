import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

let auditRows: Array<Record<string, unknown>> = [];

mock.module('../config', () => ({
  config: {
    KORTIX_CHECK_EMAIL_REQS_PER_MIN: 1,
    KORTIX_INVITE_ACCEPT_REQS_PER_MIN: 1,
    KORTIX_LLM_ROUTER_REQS_PER_MIN_FREE: 1,
    KORTIX_LLM_ROUTER_REQS_PER_MIN_PAID: 2,
    KORTIX_PROXY_REQS_PER_MIN: 1,
    KORTIX_PROJECT_WEBHOOK_REQS_PER_MIN: 1,
    KORTIX_PUBLIC_RESPONSE_REQS_PER_MIN: 1,
  },
}));

mock.module('../shared/db', () => ({
  db: {
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        auditRows.push(values);
      },
    }),
  },
}));

const {
  createCheckEmailRateLimitMiddleware,
  createInviteAcceptRateLimitMiddleware,
  createSandboxProxyRateLimitMiddleware,
  createPublicResponseRateLimitMiddleware,
  createProjectWebhookRateLimitMiddleware,
  resetRateLimiters,
} = await import('../middleware/rate-limit');
/** Stands in for the share lookup: a share id for a known token, null otherwise
 *  (undefined rejects, the store's error path). */
const resolverFor =
  (known: Record<string, string | undefined> = {}) => async (token: string) => {
    const shareId = known[token];
    if (shareId) return shareId;
    if (shareId === undefined) throw new Error('store unavailable');
    return null;
  };

const { sessionLlmPolicyForTier } = await import('../shared/account-limits');

describe('audited rate limits', () => {
  beforeEach(() => {
    auditRows = [];
    resetRateLimiters();
  });

  test('limits invite acceptance by IP and writes an audit event on hit', async () => {
    const app = new Hono();
    app.use('/v1/account-invites/:inviteId/accept', createInviteAcceptRateLimitMiddleware());
    app.post('/v1/account-invites/:inviteId/accept', (c) => c.json({ ok: true }));

    const first = await app.request('/v1/account-invites/invite-1/accept', {
      method: 'POST',
      headers: { 'X-Forwarded-For': '203.0.113.10', 'User-Agent': 'limit-test' },
    });
    expect(first.status).toBe(200);
    expect(first.headers.get('X-RateLimit-Remaining')).toBe('0');

    const second = await app.request('/v1/account-invites/invite-1/accept', {
      method: 'POST',
      headers: { 'X-Forwarded-For': '203.0.113.10', 'User-Agent': 'limit-test' },
    });
    expect(second.status).toBe(429);
    expect(second.headers.get('Retry-After')).toBeTruthy();
    expect(await second.json()).toMatchObject({ error: 'rate_limit_exceeded' });

    expect(auditRows).toHaveLength(1);
    // A fixed action and no path: a path segment can be a bearer capability
    // (setup links, approval links), and the request's own row already names
    // the route.
    expect(JSON.stringify(auditRows[0])).not.toContain('/v1/account-invites/');
    expect(auditRows[0]).toMatchObject({
      action: 'api.rate_limit.exceeded',
      resourceType: 'account_invite',
      resourceId: 'invite-1',
      ip: '203.0.113.10',
      userAgent: 'limit-test',
      metadata: { limiter: 'invite_accept' },
    });
  });

  test('limits sandbox proxy requests per sandbox after auth context is set', async () => {
    const app = new Hono();
    app.use('/v1/p/:sandboxId/:port/*', async (c, next) => {
      (c as any).set('userId', '00000000-0000-4000-a000-000000000001');
      await next();
    });
    app.use('/v1/p/:sandboxId/:port/*', createSandboxProxyRateLimitMiddleware());
    app.get('/v1/p/:sandboxId/:port/*', (c) => c.json({ ok: true }));

    const first = await app.request('/v1/p/sandbox-1/8080/global/health');
    expect(first.status).toBe(200);

    const second = await app.request('/v1/p/sandbox-1/8080/global/health');
    expect(second.status).toBe(429);
    expect(second.headers.get('X-RateLimit-Limit')).toBe('1');

    expect(auditRows).toHaveLength(1);
    expect(JSON.stringify(auditRows[0])).not.toContain('/global/health');
    expect(auditRows[0]).toMatchObject({
      action: 'api.rate_limit.exceeded',
      actorUserId: '00000000-0000-4000-a000-000000000001',
      resourceType: 'sandbox_proxy',
      resourceId: 'sandbox-1',
      metadata: { limiter: 'sandbox_proxy' },
    });
  });

  test('limits shared-response reads per share, with Retry-After and no audit row', async () => {
    const app = new Hono();
    const tokenA = 'kps_11111111111141118111111111111111';
    const tokenB = 'kps_22222222222242228222222222222222';
    const shares: Record<string, string> = {
      [tokenA]: '11111111-1111-4111-8111-111111111111',
      [tokenB]: '22222222-2222-4222-8222-222222222222',
    };
    app.use('/v1/public/responses/:token', createPublicResponseRateLimitMiddleware(async (token) => shares[token] ?? null));
    app.get('/v1/public/responses/:token', (c) => c.json({ ok: true }));

    const headers = { 'X-Forwarded-For': '203.0.113.21' };
    resetRateLimiters();

    expect((await app.request(`/v1/public/responses/${tokenA}`, { headers })).status).toBe(200);
    const denied = await app.request(`/v1/public/responses/${tokenA}`, { headers });
    expect(denied.status).toBe(429);
    expect(denied.headers.get('Retry-After')).toBe('60');
    // Another share from the same IP is its own bucket.
    expect((await app.request(`/v1/public/responses/${tokenB}`, { headers })).status).toBe(200);
    // A flood must not become a write amplifier, and the token is a bearer secret.
    expect(auditRows).toEqual([]);
  });


  test('a flood of unique shape-valid tokens is capped by the client IP bucket', async () => {
    const { config } = await import('../config');
    const configured = Reflect.get(config, 'KORTIX_PUBLIC_RESPONSE_REQS_PER_MIN');
    // Two requests per minute, so `allowed` then `denied` is exact and the test
    // costs three requests whatever the production cap is.
    Reflect.set(config, 'KORTIX_PUBLIC_RESPONSE_REQS_PER_MIN', 1);
    try {
      await floodAssertions();
    } finally {
      Reflect.set(config, 'KORTIX_PUBLIC_RESPONSE_REQS_PER_MIN', configured);
    }
  });

  async function floodAssertions() {
    const headers = { 'X-Forwarded-For': '203.0.113.41' };
    // Every token is a shape-valid `kps_` name of a different, invented share:
    // none names a row, so none may key its own bucket.
    const token = (n: number) => `kps_${String(n).padStart(8, '0')}00004000a000000000000000`;
    const resolvers = [resolverFor({}), resolverFor(undefined)];
    let floodApp = new Hono();
    for (const resolveShareId of resolvers) {
      resetRateLimiters();
      const app = new Hono();
      app.use('/v1/public/responses/:token', createPublicResponseRateLimitMiddleware(resolveShareId));
      app.get('/v1/public/responses/:token', (c) => c.json({ ok: true }));
      expect((await app.request(`/v1/public/responses/${token(1)}`, { headers })).status).toBe(200);
      // KRTX-4105: the shape alone cannot key the bucket; the client IP takes over.
      const denied = await app.request(`/v1/public/responses/${token(2)}`, { headers });
      expect(denied.status).toBe(429);
      expect(denied.headers.get('Retry-After')).toBe('60');
      // The bucket belongs to the address, not the token.
      expect((await app.request(`/v1/public/responses/${token(3)}`, { headers })).status).toBe(429);
      floodApp = app;
    }
    // A different address has its own bucket.
    expect(
      (await floodApp.request(`/v1/public/responses/${token(4)}`, { headers: { 'X-Forwarded-For': '203.0.113.42' } }))
        .status,
    ).toBe(200);
    expect(auditRows).toEqual([]);

    // An unparseable token names no share either: the client IP takes over.
    resetRateLimiters();
    const garbage = new Hono();
    garbage.use('/v1/public/responses/:token', createPublicResponseRateLimitMiddleware(resolverFor({})));
    garbage.get('/v1/public/responses/:token', (c) => c.json({ ok: true }));
    expect((await garbage.request('/v1/public/responses/not-a-token', { headers })).status).toBe(200);
    expect((await garbage.request('/v1/public/responses/also-not-a-token', { headers })).status).toBe(429);
  }

  test('a fixed valid share token keeps its own cap', async () => {
    const { config } = await import('../config');
    const configured = Reflect.get(config, 'KORTIX_PUBLIC_RESPONSE_REQS_PER_MIN');
    Reflect.set(config, 'KORTIX_PUBLIC_RESPONSE_REQS_PER_MIN', 2);
    try {
      const token = 'kps_55555555555545558555555555555555';
      const app = new Hono();
      app.use('/v1/public/responses/:token', createPublicResponseRateLimitMiddleware(resolverFor({ [token]: '55555555-5555-4555-8555-555555555555' })));
      app.get('/v1/public/responses/:token', (c) => c.json({ ok: true }));
      // The share's own bucket still caps the link, whatever address asks.
      expect((await app.request(`/v1/public/responses/${token}`, { headers: { 'X-Forwarded-For': '203.0.113.51' } })).status).toBe(200);
      expect((await app.request(`/v1/public/responses/${token}`, { headers: { 'X-Forwarded-For': '203.0.113.52' } })).status).toBe(200);
      expect((await app.request(`/v1/public/responses/${token}`, { headers: { 'X-Forwarded-For': '203.0.113.53' } })).status).toBe(429);
    } finally {
      Reflect.set(config, 'KORTIX_PUBLIC_RESPONSE_REQS_PER_MIN', configured);
    }
  });

  test('the per-share shared-response limit defaults to 3000 per minute', async () => {
    const { config } = await import('../config');
    const configured = Reflect.get(config, 'KORTIX_PUBLIC_RESPONSE_REQS_PER_MIN');
    Reflect.set(config, 'KORTIX_PUBLIC_RESPONSE_REQS_PER_MIN', undefined);
    try {
      const app = new Hono();
      const shareId = '33333333-3333-4333-8333-333333333333';
      app.use('/v1/public/responses/:token', createPublicResponseRateLimitMiddleware(async () => shareId));
      app.get('/v1/public/responses/:token', (c) => c.json({ ok: true }));
      const res = await app.request('/v1/public/responses/kps_33333333333343338333333333333333');
      expect(res.status).toBe(200);
      expect(res.headers.get('X-RateLimit-Limit')).toBe('3000');
    } finally {
      Reflect.set(config, 'KORTIX_PUBLIC_RESPONSE_REQS_PER_MIN', configured);
    }
  });

  test('limits public check-email probes by client IP and writes an audit event on hit', async () => {
    const app = new Hono();
    app.use('/v1/access/check-email', createCheckEmailRateLimitMiddleware());
    app.post('/v1/access/check-email', (c) => c.json({ allowed: true, mode: 'signup' }));

    const first = await app.request('/v1/access/check-email', {
      method: 'POST',
      headers: { 'X-Forwarded-For': '203.0.113.30' },
    });
    expect(first.status).toBe(200);

    const second = await app.request('/v1/access/check-email', {
      method: 'POST',
      headers: { 'X-Forwarded-For': '203.0.113.30' },
    });
    expect(second.status).toBe(429);
    expect(second.headers.get('Retry-After')).toBeTruthy();

    const otherIp = await app.request('/v1/access/check-email', {
      method: 'POST',
      headers: { 'X-Forwarded-For': '203.0.113.31' },
    });
    expect(otherIp.status).toBe(200);

    expect(auditRows.at(-1)).toMatchObject({
      resourceType: 'access_check_email',
      ip: '203.0.113.30',
      metadata: { limiter: 'check_email' },
    });
  });

  test('limits project webhooks by project and client IP without database audit work', async () => {
    const app = new Hono();
    app.use('/v1/webhooks/projects/:projectId/:slug', createProjectWebhookRateLimitMiddleware());
    app.post('/v1/webhooks/projects/:projectId/:slug', (c) => c.json({ ok: true }));

    const headers = { 'X-Forwarded-For': '203.0.113.40' };
    const first = await app.request('/v1/webhooks/projects/project-1/hook', {
      method: 'POST',
      headers,
    });
    expect(first.status).toBe(200);

    const second = await app.request('/v1/webhooks/projects/project-1/hook', {
      method: 'POST',
      headers,
    });
    expect(second.status).toBe(429);
    expect(second.headers.get('Retry-After')).toBeTruthy();
    expect(await second.json()).toMatchObject({ error: 'rate_limit_exceeded' });
    expect(auditRows).toHaveLength(0);

    const otherProject = await app.request('/v1/webhooks/projects/project-2/hook', {
      method: 'POST',
      headers,
    });
    expect(otherProject.status).toBe(200);
  });

  test('session LLM router policy: free budget, or paid x12 for any credits-plan key', () => {
    expect(sessionLlmPolicyForTier('free').limit).toBe(1);
    // Every paid plan is x12 the paid budget (2/min here), whatever its key:
    // legacy keys resolve to `credits`.
    expect(sessionLlmPolicyForTier('credits').limit).toBe(24);
    expect(sessionLlmPolicyForTier('pro').limit).toBe(24);
    expect(sessionLlmPolicyForTier('tier_12_100').limit).toBe(24);
  });
});
