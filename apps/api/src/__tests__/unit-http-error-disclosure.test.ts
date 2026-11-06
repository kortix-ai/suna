import { expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';

mock.module('../lib/sentry', () => ({
  addBreadcrumb: () => {},
  captureException: () => {},
  isSentryIgnoredError: () => false,
}));
mock.module('../middleware/audit', () => ({
  auditApiRequest: async (_context: unknown, next: () => Promise<void>) => next(),
}));
const { installHttpErrors } = await import('../http-errors');
const { installHttpMiddleware } = await import('../http-middleware');

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

test('a typed JSON 5xx body the thrower built keeps its code', async () => {
  const app = new OpenAPIHono();
  installHttpErrors(app);
  const body = { error: true, message: 'Storage is unavailable, try again shortly', status: 503, code: 'synthetic_unavailable' };
  app.get('/typed', () => {
    throw new HTTPException(503, { message: body.message, res: Response.json(body, { status: 503 }) });
  });
  const response = await app.request('/typed');
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual(body);
});

test('malformed JSON is a 400 and unknown deep paths return safe envelopes', async () => {
  const app = new OpenAPIHono();
  installHttpMiddleware(app);
  installHttpErrors(app);
  app.post('/json', async (c) => c.json(await c.req.json()));
  for (const body of ['{', '', '{"a":', 'not json']) {
    const malformed = await app.request('/json', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: true, message: 'Malformed JSON in request body', status: 400 });
  }
  const valid = await app.request('/json', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ok":true}',
  });
  expect(valid.status).toBe(200);
  expect(await valid.json()).toEqual({ ok: true });
  const missing = await app.request('/unknown/deep/synthetic/path');
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: true, message: 'Not found', status: 404 });
});

test('a literal null body is a 400 whatever the content type, never a TypeError 500', async () => {
  const app = new OpenAPIHono();
  installHttpMiddleware(app);
  installHttpErrors(app);
  app.post('/deref', async (c) => c.json({ name: (await c.req.json()).name }));
  for (const contentType of ['application/json', 'text/plain', undefined]) {
    const response = await app.request('/deref', {
      method: 'POST', headers: contentType ? { 'Content-Type': contentType } : {}, body: 'null',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: true, message: 'Request body must not be null', status: 400 });
  }
  const valid = await app.request('/deref', {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"name":"x"}',
  });
  expect(valid.status).toBe(200);
});

test('a SyntaxError that is not the request body stays a 500', async () => {
  const app = new OpenAPIHono();
  installHttpMiddleware(app);
  installHttpErrors(app);
  app.post('/upstream', () => JSON.parse('{'));
  const response = await app.request('/upstream', { method: 'POST', body: '{}' });
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: true, message: 'Internal server error', status: 500 });
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
