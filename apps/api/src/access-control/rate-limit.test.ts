import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';

const submissions: Array<Record<string, unknown>> = [];
mock.module('../config', () => ({ config: {} }));
mock.module('../shared/db', () => ({
  db: { insert: () => ({ values: async (row: Record<string, unknown>) => { submissions.push(row); } }) },
}));
mock.module('../shared/audit', () => ({ recordAuditEvent: async () => {} }));
mock.module('../repositories/sso', () => ({ ssoEnforcedForEmail: async () => null }));
mock.module('../shared/access-control-cache', () => ({
  areSignupsEnabled: () => true,
  canSignUp: () => true,
}));

const { accessControlApp } = await import('./index');
const { resetRateLimiters } = await import('../middleware/rate-limit');
let now = 0;
beforeEach(() => {
  submissions.length = 0;
  resetRateLimiters();
  now = 0;
  spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => mock.restore());

function submit(client = '192.0.2.1', prefix = '198.51.100.1') {
  return accessControlApp.request('/request-access', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `${prefix}, ${client}, 192.0.2.254` },
    body: JSON.stringify({ email: 'agent@kortix.ai', company: 'Synthetic', useCase: 'Testing' }),
  });
}

test('a normal unauthenticated submission succeeds and preserves its fields', async () => {
  const response = await submit();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true, message: 'Access request submitted' });
  expect(submissions).toEqual([{ email: 'agent@kortix.ai', company: 'Synthetic', useCase: 'Testing' }]);
});

test('a burst stops at 60 writes, ignores forged prefixes, and refills after a minute', async () => {
  for (let i = 0; i < 60; i++) expect((await submit()).status).toBe(200);
  const denied = await submit('192.0.2.1', '198.51.100.2');
  expect(denied.status).toBe(429);
  expect(denied.headers.get('X-RateLimit-Limit')).toBe('60');
  expect(denied.headers.get('X-RateLimit-Remaining')).toBe('0');
  expect(denied.headers.get('Retry-After')).toBe('60');
  expect(await denied.json()).toMatchObject({ error: 'rate_limit_exceeded' });
  expect(submissions).toHaveLength(60);
  expect((await submit('192.0.2.2')).status).toBe(200);
  now = 60_000;
  expect((await submit()).status).toBe(200);
  expect(submissions).toHaveLength(62);
});
