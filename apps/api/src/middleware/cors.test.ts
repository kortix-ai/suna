import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { createCorsMiddleware } from './cors';

describe('createCorsMiddleware', () => {
  test('an allowed origin receives a cacheable authenticated preflight response', async () => {
    const app = new Hono();
    app.use(
      '*',
      createCorsMiddleware({
        internalEnvironment: 'prod',
        extraOrigins: [],
      }),
    );
    app.get('/v1/read', (context) => context.json({ ok: true }));

    const response = await app.request('/v1/read', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://kortix.com',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers':
          'authorization,content-type,last-event-id,x-kortix-client',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://kortix.com');
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'last-event-id',
    );
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'x-kortix-client',
    );
    expect(response.headers.get('access-control-max-age')).toBe('600');
  });

  test('an unknown production origin receives no CORS authorization', async () => {
    const app = new Hono();
    app.use(
      '*',
      createCorsMiddleware({
        internalEnvironment: 'prod',
        extraOrigins: [],
      }),
    );
    app.get('/v1/read', (context) => context.json({ ok: true }));

    const response = await app.request('/v1/read', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://unknown.example',
        'Access-Control-Request-Method': 'GET',
      },
    });

    expect(response.headers.has('access-control-allow-origin')).toBe(false);
  });

  test('a configured origin and a preview origin follow their environment gates', async () => {
    const app = new Hono();
    app.use(
      '*',
      createCorsMiddleware({
        internalEnvironment: 'preview',
        extraOrigins: ['https://customer.example'],
      }),
    );
    app.get('/v1/read', (context) => context.json({ ok: true }));

    const configured = await app.request('/v1/read', {
      headers: { Origin: 'https://customer.example' },
    });
    const preview = await app.request('/v1/read', {
      headers: { Origin: 'https://change-123.preview.kortix.com' },
    });

    expect(configured.headers.get('access-control-allow-origin')).toBe('https://customer.example');
    expect(preview.headers.get('access-control-allow-origin')).toBe(
      'https://change-123.preview.kortix.com',
    );
  });
});
