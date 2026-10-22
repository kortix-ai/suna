import { expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';

// Audit persistence is unrelated to response headers and needs PostgreSQL.
mock.module('../middleware/audit', () => ({
  auditApiRequest: async (_context: unknown, next: () => Promise<void>) => next(),
}));
const { installHttpMiddleware } = await import('../http-middleware');

const app = new OpenAPIHono();
installHttpMiddleware(app);
app.get('/', (c) => {
  c.header('X-Content-Type-Options', 'nosniff');
  return c.text('ok');
});
app.get('/denied', (c) => c.json({ error: 'unauthorized' }, 401));
app.get('/failure', () => { throw new Error('synthetic failure'); });

for (const [path, status] of [['/', 200], ['/denied', 401], ['/missing', 404], ['/failure', 500]] as const) {
  test(`Permissions-Policy covers ${status} responses`, async () => {
    const response = await app.request(path);
    expect(response.status).toBe(status);
    expect(response.headers.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
    if (path === '/') {
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(await response.text()).toBe('ok');
    }
  });
}

test('Permissions-Policy covers CORS preflight', async () => {
  const response = await app.request('/', {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'GET' },
  });
  expect(response.status).toBe(204);
  expect(response.headers.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
});
