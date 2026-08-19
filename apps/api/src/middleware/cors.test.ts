import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import {
  PROXY_HOP_HEADER,
  PROXY_UPSTREAM_STATUS_HEADER,
} from '../sandbox-proxy/proxy-hop';
import { portUnreachableResponse } from '../sandbox-proxy/routes/preview';
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

  // The act-as grant travels in a custom header, and a custom header missing
  // from the preflight allowlist is dropped BY THE BROWSER — the request then
  // runs as the operator's own account with the banner still up. Pin it.
  test('the impersonation and admin-bypass headers survive a preflight', async () => {
    const app = new Hono();
    app.use('*', createCorsMiddleware({ internalEnvironment: 'prod', extraOrigins: [] }));
    app.get('/v1/read', (context) => context.json({ ok: true }));

    const response = await app.request('/v1/read', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://kortix.com',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization,x-kortix-impersonate',
      },
    });

    const allowed = response.headers.get('access-control-allow-headers')?.toLowerCase() ?? '';
    expect(allowed).toContain('x-kortix-impersonate');
    expect(allowed).toContain('x-kortix-admin-bypass');
  });

  // The proxy attributes a failure with `X-Kortix-Proxy-Hop`, and the health
  // probe that reads it is ALWAYS cross-origin (dev.kortix.com →
  // dev-api.kortix.com). A response header the browser does not expose is
  // invisible to JS, so the probe reads null and is back to guessing.
  //
  // `portUnreachableResponse` sets `Access-Control-Expose-Headers` itself, but
  // this middleware is mounted on the SAME app (`index.ts` `app.use('*', …)`)
  // and Hono's `Context.res` setter copies the middleware's headers onto the
  // handler's response with `.set()` — the middleware value WINS. The only
  // place that makes the header readable in the deployed app is this list, so
  // the test drives the real middleware over the real handler.
  test('the proxy-hop headers are exposed to a cross-origin probe through the mounted middleware', async () => {
    const app = new Hono();
    app.use('*', createCorsMiddleware({ internalEnvironment: 'dev', extraOrigins: [] }));
    app.get('/v1/p/box/8000/kortix/health', () =>
      portUnreachableResponse({
        port: 8000,
        status: 502,
        origin: 'https://dev.kortix.com',
        incomingHeaders: new Headers({ accept: 'application/json' }),
        reason: 'sandbox upstream unreachable',
        hop: 'daemon',
        upstreamStatus: 502,
      }),
    );

    const response = await app.request('/v1/p/box/8000/kortix/health', {
      headers: { Origin: 'https://dev.kortix.com', accept: 'application/json' },
    });

    const exposed = response.headers.get('access-control-expose-headers')?.toLowerCase() ?? '';
    expect(exposed).toContain(PROXY_HOP_HEADER.toLowerCase());
    expect(exposed).toContain(PROXY_UPSTREAM_STATUS_HEADER.toLowerCase());
    expect(response.headers.get(PROXY_HOP_HEADER)).toBe('daemon');
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
