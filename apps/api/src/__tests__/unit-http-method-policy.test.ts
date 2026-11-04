import { expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';

// Audit persistence needs PostgreSQL; this test exercises the HTTP chain.
mock.module('../middleware/audit', () => ({
  auditApiRequest: async (_context: unknown, next: () => Promise<void>) => next(),
}));
const { installHttpMiddleware } = await import('../http-middleware');

const app = new OpenAPIHono();
installHttpMiddleware(app);
let reachedHandler = false;
app.all('*', (c) => {
  reachedHandler = true;
  return c.text('synthetic downstream response');
});

for (const method of ['TRACE', 'CONNECT']) {
  for (const path of ['/', '/v1/health', '/v1/p/synthetic/8000/']) {
    test(`${method} ${path} is rejected before downstream handling without echo`, async () => {
      reachedHandler = false;
      const response = await app.request(path, {
        method,
        headers: { 'X-Synthetic-Canary': 'synthetic-canary' },
      });
      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
      expect(reachedHandler).toBe(false);
      expect(await response.text()).toBe('Method Not Allowed');
      expect(response.headers.get('X-Synthetic-Canary')).toBeNull();
    });
  }
}

test('ordinary methods still reach downstream handlers', async () => {
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    reachedHandler = false;
    const response = await app.request('/', { method });
    expect(response.status).toBe(200);
    expect(reachedHandler).toBe(true);
  }
});

test('OPTIONS retains CORS preflight without advertising TRACE or CONNECT', async () => {
  const response = await app.request('/', {
    method: 'OPTIONS',
    headers: { Origin: 'https://kortix.com', 'Access-Control-Request-Method': 'POST' },
  });
  expect(response.status).toBe(204);
  expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET,POST,PUT,PATCH,DELETE,OPTIONS');
});
