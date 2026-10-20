import { afterEach, expect, jest, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

mock.module('../config', () => ({ config: {} }));
let permitted = true;
mock.module('../middleware/resolve-account', () => ({
  resolveScopedAccountId: async (c: { req: { header(name: string): string | undefined } }) => c.req.header('x-test-account') ?? 'account-a',
}));
mock.module('../iam/actor', () => ({ actorOf: async () => ({}) }));
mock.module('../iam/authorize', () => ({ assertAuthorized: async () => {
  if (!permitted) throw new HTTPException(403);
} }));
const auditEvents: unknown[] = [];
mock.module('../shared/audit', () => ({ recordAuditEvent: async (event: unknown) => { auditEvents.push(event); } }));
const { resolveBillingWriteAccountId, resolveBillingReadAccountId } = await import('./http-require-billing-write');

let upstreamCalls = 0;
const app = new Hono();
app.post('/:operation', async (c) => {
  await resolveBillingWriteAccountId(c);
  upstreamCalls++;
  return c.json({ ok: true });
});
app.get('/read', async (c) => c.json({ account: await resolveBillingReadAccountId(c) }));
afterEach(() => { jest.useRealTimers(); permitted = true; });

test('a billing-write burst is refused before upstream work, across operations, then recovers', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-20T00:00:00Z'));
  upstreamCalls = 0;
  auditEvents.length = 0;
  const responses = await Promise.all(Array.from({ length: 577 }, (_, i) =>
    app.request(i % 2 ? '/plan' : '/purchase-credits', { method: 'POST' })));
  expect(responses.filter((r) => r.status === 200)).toHaveLength(5);
  expect(upstreamCalls).toBe(5);
  expect(auditEvents).toHaveLength(572);
  expect(auditEvents[0]).toMatchObject({ accountId: 'account-a', action: 'api.rate_limit.exceeded', metadata: { limiter: 'billing_write' } });
  const denied = responses.find((r) => r.status === 429);
  expect(denied).toBeDefined();
  expect(denied?.headers.get('Retry-After')).toBe('60');
  expect(await denied?.json()).toMatchObject({ error: 'rate_limit_exceeded', retry_after_seconds: 60 });
  expect((await app.request('/read')).status).toBe(200);
  expect((await app.request('/plan', { method: 'POST', headers: { 'x-test-account': 'account-b' } })).status).toBe(200);
  jest.advanceTimersByTime(60_000);
  expect((await app.request('/plan', { method: 'POST' })).status).toBe(200);
});

test('permission refusals do not spend the account billing-write budget', async () => {
  const headers = { 'x-test-account': 'account-c' };
  permitted = false;
  for (let i = 0; i < 6; i++) expect((await app.request('/plan', { method: 'POST', headers })).status).toBe(403);
  permitted = true;
  expect((await app.request('/plan', { method: 'POST', headers })).status).toBe(200);
});
