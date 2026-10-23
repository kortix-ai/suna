import { expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';

mock.module('../lib/sentry', () => ({
  captureException: () => {},
  isSentryIgnoredError: () => false,
}));
const { installHttpErrors } = await import('../http-errors');

for (const status of [500, 502, 503, 504] as const) {
  for (const explicitResponse of [false, true]) {
    test(`HTTP ${status} hides internals (explicit response: ${explicitResponse})`, async () => {
      const app = new OpenAPIHono();
      installHttpErrors(app);
      app.get('/failure', () => {
        throw new HTTPException(status, {
          message: 'SQL SELECT synthetic FROM internal_table at /srv/private/example.ts',
          ...(explicitResponse ? { res: new Response('stack at /srv/private/example.ts', { status }) } : {}),
        });
      });
      const response = await app.request('/failure');
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: true, message: 'Internal server error', status });
    });
  }
}

test('malformed JSON and unknown deep paths return safe envelopes', async () => {
  const app = new OpenAPIHono();
  installHttpErrors(app);
  app.post('/json', async (c) => c.json(await c.req.json()));
  const malformed = await app.request('/json', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
  });
  expect(malformed.status).toBe(500);
  expect(await malformed.json()).toEqual({ error: true, message: 'Internal server error', status: 500 });
  const missing = await app.request('/unknown/deep/synthetic/path');
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: true, message: 'Not found', status: 404 });
});

test('typed client denials and request deadlines retain their contracts', async () => {
  const { RequestDeadlineHTTPException, REQUEST_DEADLINE_CODE } = await import('../middleware/request-deadline');
  const app = new OpenAPIHono();
  installHttpErrors(app);
  app.get('/denied', () => {
    throw new HTTPException(401, { res: Response.json({ error: true, code: 'synthetic_denial' }, { status: 401 }) });
  });
  app.get('/deadline', () => { throw new RequestDeadlineHTTPException(); });
  const denied = await app.request('/denied');
  expect(denied.status).toBe(401);
  expect(denied.headers.has('www-authenticate')).toBe(true);
  expect(await denied.json()).toEqual({ error: true, code: 'synthetic_denial' });
  const deadline = await app.request('/deadline');
  expect(deadline.status).toBe(503);
  expect(deadline.headers.get('retry-after')).toBe('10');
  expect(await deadline.json()).toMatchObject({ code: REQUEST_DEADLINE_CODE, status: 503 });
});
