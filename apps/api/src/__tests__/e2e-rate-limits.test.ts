import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

let auditRows: Array<Record<string, unknown>> = [];

mock.module('../config', () => ({
  config: {
    KORTIX_INVITE_ACCEPT_REQS_PER_MIN: 1,
    KORTIX_LLM_ROUTER_REQS_PER_MIN_FREE: 1,
    KORTIX_LLM_ROUTER_REQS_PER_MIN_PAID: 2,
    KORTIX_PROXY_REQS_PER_MIN: 1,
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
  createInviteAcceptRateLimitMiddleware,
  createSandboxProxyRateLimitMiddleware,
  resetRateLimiters,
} = await import('../shared/rate-limit');
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
    expect(auditRows[0]).toMatchObject({
      action: 'RATE_LIMIT POST /v1/account-invites/invite-1/accept',
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
    expect(auditRows[0]).toMatchObject({
      actorUserId: '00000000-0000-4000-a000-000000000001',
      resourceType: 'sandbox_proxy',
      resourceId: 'sandbox-1',
      metadata: { limiter: 'sandbox_proxy' },
    });
  });

  test('scales session LLM router policy by tier', () => {
    expect(sessionLlmPolicyForTier('free').limit).toBe(1);
    expect(sessionLlmPolicyForTier('pro').limit).toBe(2);
    expect(sessionLlmPolicyForTier('tier_12_100').limit).toBe(6);
  });
});
