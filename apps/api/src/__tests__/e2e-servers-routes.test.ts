import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: any) => {
    c.set('userId', '00000000-0000-4000-a000-000000000001');
    await next();
  },
}));

mock.module('../shared/db', () => ({
  db: {},
}));

const { serversApp } = await import('../servers');

function createServersTestApp() {
  const app = new Hono();
  app.route('/v1/servers', serversApp);
  return app;
}

describe('Servers: removed item routes', () => {
  test('legacy single-server read and update endpoints are not mounted', async () => {
    const app = createServersTestApp();
    const read = await app.request('/v1/servers/custom-server', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_token' },
    });
    const update = await app.request('/v1/servers/custom-server', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_token' },
      body: JSON.stringify({ label: 'Updated' }),
    });

    expect(read.status).toBe(404);
    expect(update.status).toBe(404);
  });
});
