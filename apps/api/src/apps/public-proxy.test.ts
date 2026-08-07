import { describe, expect, test } from 'bun:test';

process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.KORTIX_APPS_BASE_DOMAIN = 'apps.kortix.com';
process.env.KORTIX_APPS_ALLOW_LOCAL_EDGE = 'true';

const {
  appPublicUnavailableResponse,
  appPublicResponseHeaders,
  appPublicStatusResponse,
  appRuntimeNeedsWake,
  appEdgeSignature,
  appUpstreamHeaders,
  resolveAppHost,
  resolveAppRequest,
  verifyAppEdgeRequest,
} = await import('./public-proxy');

describe('Apps public edge', () => {
  test('revalidates a running row after its Kortix idle deadline passes', () => {
    const now = new Date('2026-08-07T10:30:00.000Z');
    expect(appRuntimeNeedsWake({
      status: 'running',
      idleDeadlineAt: new Date('2026-08-07T10:29:59.000Z'),
    }, now)).toBe(true);
    expect(appRuntimeNeedsWake({
      status: 'running',
      idleDeadlineAt: new Date('2026-08-07T10:30:01.000Z'),
    }, now)).toBe(false);
    expect(appRuntimeNeedsWake({ status: 'stopped', idleDeadlineAt: null }, now)).toBe(true);
  });

  test('resolves local and environment-scoped production hostnames', () => {
    expect(resolveAppHost('aaaaaaaaaaaaaaaa.apps.localhost')).toEqual({
      routeKey: 'aaaaaaaaaaaaaaaa', local: true,
    });
    expect(resolveAppHost('dev-hello-world-aaaaaaaaaaaaaaaa.apps.kortix.com')).toEqual({
      routeKey: 'aaaaaaaaaaaaaaaa', local: false,
    });
    expect(resolveAppHost('prod-hello-aaaaaaaaaaaaaaaa.apps.kortix.com')).toBeNull();
    expect(resolveAppHost('anything.example.com')).toBeNull();
  });

  test('accepts a valid edge signature and rejects header or path substitution', () => {
    const timestamp = String(Date.now());
    const host = 'dev-hello-aaaaaaaaaaaaaaaa.apps.kortix.com';
    const secret = 'edge-secret-at-least-sixteen';
    process.env.KORTIX_APPS_EDGE_SECRET = secret;
    const signature = appEdgeSignature(timestamp, host, 'POST', '/api/items?q=1', secret);
    const request = new Request(`https://${host}/api/items?q=1`, {
      method: 'POST',
      headers: {
        'x-kortix-app-host': host,
        'x-kortix-app-timestamp': timestamp,
        'x-kortix-app-signature': signature,
      },
    });
    expect(verifyAppEdgeRequest(request, new URL(request.url), false)).toBe(true);
    expect(verifyAppEdgeRequest(request, new URL(`https://${host}/api/other`), false)).toBe(false);
  });

  test('resolves and verifies the signed public host after the Worker forwards to the API host', () => {
    const timestamp = String(Date.now());
    const publicHost = 'dev-hello-aaaaaaaaaaaaaaaa.apps.kortix.com';
    const secret = 'edge-secret-at-least-sixteen';
    process.env.KORTIX_APPS_EDGE_SECRET = secret;
    const signature = appEdgeSignature(timestamp, publicHost, 'GET', '/assets/app.js?q=1', secret);
    const request = new Request('https://dev-api.kortix.com/assets/app.js?q=1', {
      headers: {
        'x-kortix-app-host': publicHost,
        'x-kortix-app-timestamp': timestamp,
        'x-kortix-app-signature': signature,
      },
    });

    const resolved = resolveAppRequest(request, new URL(request.url));
    expect(resolved).toEqual({
      routeKey: 'aaaaaaaaaaaaaaaa',
      local: false,
      publicHost,
    });
    expect(verifyAppEdgeRequest(
      request,
      new URL(request.url),
      false,
      resolved!.publicHost,
    )).toBe(true);
  });

  test('allows direct local development without Cloudflare headers', () => {
    const request = new Request('http://aaaaaaaaaaaaaaaa.apps.localhost:8008/');
    expect(verifyAppEdgeRequest(request, new URL(request.url), true)).toBe(true);
  });

  test('forces identity encoding because Bun fetch transparently decompresses upstream bodies', () => {
    const request = new Request('https://dev-app-aaaaaaaaaaaaaaaa.apps.kortix.com/', {
      headers: { 'accept-encoding': 'gzip, br, zstd' },
    });
    const headers = appUpstreamHeaders(request, {}, 'dev-app-aaaaaaaaaaaaaaaa.apps.kortix.com');

    expect(headers.get('accept-encoding')).toBe('identity');
  });

  test('hides owner billing and provider details from public callers', async () => {
    const response = appPublicUnavailableResponse();

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(await response.json()).toEqual({
      error: 'App is temporarily unavailable',
      code: 'app_unavailable',
    });
  });

  test('renders a branded unavailable page for browser requests', async () => {
    const response = appPublicUnavailableResponse(
      new Request('https://dev-store-aaaaaaaaaaaaaaaa.apps.kortix.com/', {
        headers: { accept: 'text/html' },
      }),
      { name: 'Storefront' },
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('App temporarily unavailable');
    expect(html).toContain('Storefront');
  });

  test('allows Apps to render inside Kortix while preserving the rest of the upstream CSP', () => {
    const headers = new Headers({
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'; script-src 'self'",
      'content-security-policy-report-only': "frame-ancestors https://example.com; img-src 'self'",
    });

    const result = appPublicResponseHeaders(headers);

    expect(result.get('x-frame-options')).toBeNull();
    expect(result.get('content-security-policy')).toBe(
      "default-src 'self'; script-src 'self'; frame-ancestors 'self' https://kortix.com https://*.kortix.com http://localhost:* http://127.0.0.1:*",
    );
    expect(result.get('content-security-policy-report-only')).toBe("img-src 'self'");
  });

  test('renders a branded, auto-refreshing browser page while an App is building', async () => {
    const response = appPublicStatusResponse(
      new Request('https://dev-store-aaaaaaaaaaaaaaaa.apps.kortix.com/', {
        headers: { accept: 'text/html' },
      }),
      { name: 'Storefront' },
      { status: 'building' },
    );

    expect(response.status).toBe(202);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('retry-after')).toBe('3');
    const html = await response.text();
    expect(html).toContain('<title>Building Storefront</title>');
    expect(html).toContain('Building your App');
    expect(html).toContain('http-equiv="refresh" content="3"');
  });

  test('returns machine-readable state to non-browser callers', async () => {
    const response = appPublicStatusResponse(
      new Request('https://dev-store-aaaaaaaaaaaaaaaa.apps.kortix.com/'),
      { name: 'Storefront' },
      { status: 'checking' },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      error: 'App deployment is checking readiness',
      code: 'app_deployment_checking',
      status: 'checking',
    });
  });

  test('shows a stable failed state without auto-refreshing forever', async () => {
    const response = appPublicStatusResponse(
      new Request('https://dev-store-aaaaaaaaaaaaaaaa.apps.kortix.com/', {
        headers: { 'sec-fetch-dest': 'document' },
      }),
      { name: 'Storefront' },
      { status: 'failed' },
    );

    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toContain('Deployment failed');
    expect(html).not.toContain('http-equiv="refresh"');
  });
});
