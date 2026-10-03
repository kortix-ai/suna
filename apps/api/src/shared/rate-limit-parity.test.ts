import { afterEach, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import type { AuditEventInput } from './audit';
const events: AuditEventInput[] = [];
mock.module('./audit', () => ({
  recordAuditEvent: async (event: AuditEventInput) => {
    events.push(event);
  },
}));
const rate = await import('./rate-limit');
const { config } = await import('../config');
const { RATE_LIMIT_EXCEEDED_ACTION } = await import('./rate-limit-audit');
const shareId = '11111111-1111-4111-8111-111111111111';
const cases = [
  {
    factory: rate.createInviteAcceptRateLimitMiddleware,
    setting: 'KORTIX_INVITE_ACCEPT_REQS_PER_MIN',
    path: '/:inviteId',
    url: '/invite-a',
    other: '/invite-b',
    resource: 'account_invite',
    id: 'invite-a',
    limiter: 'invite_accept',
    ipKey: true,
  },
  {
    factory: rate.createSandboxProxyRateLimitMiddleware,
    setting: 'KORTIX_PROXY_REQS_PER_MIN',
    path: '/:sandboxId',
    url: '/sandbox-a',
    other: '/sandbox-b',
    resource: 'sandbox_proxy',
    id: 'sandbox-a',
    limiter: 'sandbox_proxy',
    ipKey: false,
  },
  {
    factory: rate.createPublicSessionShareRateLimitMiddleware,
    setting: 'KORTIX_PUBLIC_SESSION_SHARE_REQS_PER_MIN',
    path: '/:shareId',
    url: `/${shareId}`,
    other: '/22222222-2222-4222-8222-222222222222',
    resource: 'public_session_share',
    id: shareId,
    limiter: 'public_session_share',
    ipKey: false,
  },
  {
    factory: rate.createDemoRequestRateLimitMiddleware,
    setting: 'KORTIX_DEMO_REQUEST_REQS_PER_MIN',
    path: '/:id',
    url: '/demo-a',
    other: '/demo-b',
    resource: 'demo_request',
    id: null,
    limiter: 'demo_request',
    ipKey: true,
  },
  {
    factory: rate.createCheckEmailRateLimitMiddleware,
    setting: 'KORTIX_CHECK_EMAIL_REQS_PER_MIN',
    path: '/:id',
    url: '/email-a',
    other: '/email-b',
    resource: 'access_check_email',
    id: null,
    limiter: 'check_email',
    ipKey: true,
  },
];
afterEach(() => {
  rate.resetRateLimiters();
  events.length = 0;
  for (const item of cases) Reflect.deleteProperty(config, item.setting);
});
for (const item of cases)
  test(`${item.limiter}: request, audit, key and dynamic policy parity`, async () => {
    Reflect.set(config, item.setting, 1);
    const app = new Hono<{ Variables: { userId: string } }>();
    let nextCalls = 0;
    app.use('*', async (c, next) => {
      c.set('userId', 'synthetic-user');
      await next();
    });
    app.use(item.path, item.factory());
    app.get(item.path, (c) => {
      nextCalls++;
      return c.json({ ok: true });
    });
    const request = (url: string, ip = '203.0.113.7') =>
      app.request(url, { headers: { 'x-real-ip': ip, 'user-agent': 'parity-test' } });
    const allowed = await request(item.url);
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('X-RateLimit-Limit')).toBe('1');
    expect(allowed.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(allowed.headers.get('X-RateLimit-Reset')).toBe('60');
    expect(allowed.headers.get('Retry-After')).toBeNull();
    expect(events).toEqual([]);
    const denied = await request(item.url);
    expect(denied.status).toBe(429);
    expect(await denied.json()).toEqual({
      error: 'rate_limit_exceeded',
      message: 'Rate limit exceeded. Please retry shortly.',
      retry_after_seconds: 60,
    });
    expect(denied.headers.get('X-RateLimit-Limit')).toBe('1');
    expect(denied.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(denied.headers.get('X-RateLimit-Reset')).toBe('60');
    expect(denied.headers.get('Retry-After')).toBe('60');
    expect(nextCalls).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      accountId: null,
      actorUserId: item.limiter === 'sandbox_proxy' ? 'synthetic-user' : null,
      action: RATE_LIMIT_EXCEEDED_ACTION,
      resourceType: item.resource,
      resourceId: item.id,
      ip: '203.0.113.7',
      userAgent: 'parity-test',
      metadata: {
        limiter: item.limiter,
        rate_limit: { limit: 1, remaining: 0, retry_after_ms: expect.any(Number) },
      },
    });
    expect(events[0]?.metadata?.rate_limit).toMatchObject({ retry_after_ms: expect.any(Number) });
    expect((await request(item.other)).status).toBe(item.ipKey ? 429 : 200);
    expect((await request(item.url, '198.51.100.4')).status).toBe(item.ipKey ? 200 : 429);
    Reflect.set(config, item.setting, 7);
    expect((await request(item.url)).headers.get('X-RateLimit-Limit')).toBe('7');
    expect((await request('/fresh-policy', '192.0.2.8')).headers.get('X-RateLimit-Limit')).toBe(
      '7',
    );
  });
