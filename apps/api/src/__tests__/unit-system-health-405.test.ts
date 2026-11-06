import { describe, expect, it } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { installHttpErrors } from '../http-errors';
import { registerSystemRoutes } from '../routes/system';

// KRTX-3380 (pentest http.contract): POST /v1/health fell through to the 404
// handler with no Allow header. RFC 9110 §15.5.6: a 405 names the supported methods.
const app = new OpenAPIHono();
registerSystemRoutes(app);
installHttpErrors(app);

const PATHS = [
  '/health',
  '/v1/health',
  '/health/live',
  '/v1/health/live',
  '/health/ready',
  '/v1/health/ready',
];

describe('health endpoints are GET-only', () => {
  it('an unknown path still answers 404', async () => {
    const res = await app.request('/v1/healthz', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  for (const path of PATHS) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      it(`${method} ${path} answers 405 with Allow: GET, HEAD`, async () => {
        const res = await app.request(path, { method });
        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('GET, HEAD');
      });
    }
  }

  it('GET and HEAD still reach the handler', async () => {
    const get = await app.request('/v1/health');
    expect(get.status).toBe(200);
    expect((await get.json()).status).toBe('ok');
    const head = await app.request('/v1/health', { method: 'HEAD' });
    expect(head.status).toBe(200);
  });
});
