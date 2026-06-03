import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

const { platformApp } = await import('../platform');

function createPlatformTestApp() {
  const app = new Hono();
  app.route('/v1/platform', platformApp);
  return app;
}

describe('Platform: removed routes', () => {
  test('legacy sandbox version endpoint is not mounted', async () => {
    const app = createPlatformTestApp();
    const res = await app.request('/v1/platform/sandbox/version', {
      method: 'GET',
    });

    expect(res.status).toBe(404);
  });
});
