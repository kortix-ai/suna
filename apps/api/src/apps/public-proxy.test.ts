import { describe, expect, test } from 'bun:test';

process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.KORTIX_APPS_BASE_DOMAIN = 'apps.kortix.com';
process.env.KORTIX_APPS_ALLOW_LOCAL_EDGE = 'true';

const {
  appPublicUnavailableResponse,
  appPublicBudgetResponse,
  appPublicResponseHeaders,
  appPublicStatusResponse,
  appColdStartUpstreamResponse,
  appProviderStoppedResponse,
  appRuntimeNeedsWake,
  appEdgeSignature,
  appUpstreamHeaders,
  authorizeAppRequest,
  resolveAppHost,
  resolveAppRequest,
  verifyAppEdgeRequest,
} = await import('./public-proxy');
const { createAppAccessToken } = await import('./access');

describe('Apps public edge', () => {
  test('public Apps bypass browser authentication', async () => {
    const request = new Request('https://dev-public-aaaaaaaaaaaaaaaa.apps.kortix.com/asset.js');
    const response = await authorizeAppRequest(request, new URL(request.url), {
      appId: '11111111-1111-4111-8111-111111111111',
      accountId: '99999999-9999-4999-8999-999999999999',
      projectId: '22222222-2222-4222-8222-222222222222',
      name: 'Public App',
      accessMode: 'public',
      accessPasswordHash: null,
      accessRevision: 1,
      createdBy: null,
      updatedAt: new Date(),
    });

    expect(response).toBeNull();
  });

  test('requires Kortix access by default and exchanges a scoped link into a host-only cookie', async () => {
    const app = {
      appId: '11111111-1111-4111-8111-111111111111',
      accountId: '99999999-9999-4999-8999-999999999999',
      projectId: '22222222-2222-4222-8222-222222222222',
      name: 'Private App',
      accessMode: 'private',
      accessPasswordHash: null,
      accessRevision: 7,
      createdBy: '33333333-3333-4333-8333-333333333333',
      updatedAt: new Date('2026-08-07T19:00:00.000Z'),
    };
    const denied = await authorizeAppRequest(
      new Request('https://dev-private-aaaaaaaaaaaaaaaa.apps.kortix.com/', {
        headers: { accept: 'text/html' },
      }),
      new URL('https://dev-private-aaaaaaaaaaaaaaaa.apps.kortix.com/'),
      app,
    );
    expect(denied?.status).toBe(401);
    expect(await denied?.text()).toContain('Continue with Kortix');

    const token = createAppAccessToken({
      appId: app.appId,
      kind: 'kortix',
      userId: '33333333-3333-4333-8333-333333333333',
      revision: app.accessRevision,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const url = new URL(`https://dev-private-aaaaaaaaaaaaaaaa.apps.kortix.com/path?__kortix_access=${token}`);
    const exchanged = await authorizeAppRequest(new Request(url), url, app, async () => true);
    expect(exchanged?.status).toBe(303);
    expect(exchanged?.headers.get('location')).toBe('/path');
    expect(exchanged?.headers.get('set-cookie')).toContain('__Host-kortix_app_access=');
    expect(exchanged?.headers.get('set-cookie')).not.toContain('Domain=');

    const cookie = exchanged!.headers.get('set-cookie')!.split(';', 1)[0]!;
    const asset = await authorizeAppRequest(
      new Request('https://dev-private-aaaaaaaaaaaaaaaa.apps.kortix.com/assets/app.js', {
        headers: { cookie },
      }),
      new URL('https://dev-private-aaaaaaaaaaaaaaaa.apps.kortix.com/assets/app.js'),
      { ...app, updatedAt: new Date('2026-08-07T19:01:00.000Z') },
      async () => true,
    );
    expect(asset).toBeNull();

    const revoked = await authorizeAppRequest(
      new Request('https://dev-private-aaaaaaaaaaaaaaaa.apps.kortix.com/assets/app.js', {
        headers: { cookie },
      }),
      new URL('https://dev-private-aaaaaaaaaaaaaaaa.apps.kortix.com/assets/app.js'),
      { ...app, accessRevision: 8 },
      async () => true,
    );
    expect(revoked?.status).toBe(401);
  });

  test('exchanges local access links into an iframe-compatible partitioned cookie', async () => {
    const app = {
      appId: '11111111-1111-4111-8111-111111111111',
      accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      projectId: '22222222-2222-4222-8222-222222222222',
      createdBy: '33333333-3333-4333-8333-333333333333',
      name: 'Local private App',
      accessMode: 'private',
      accessPasswordHash: null,
      accessRevision: 4,
      updatedAt: new Date('2026-08-07T19:01:00.000Z'),
    };
    const token = createAppAccessToken({
      appId: app.appId,
      kind: 'kortix',
      userId: app.createdBy,
      revision: app.accessRevision,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const url = new URL(`http://aaaaaaaaaaaaaaaa.apps.localhost:8008/?__kortix_access=${token}`);
    const response = await authorizeAppRequest(
      new Request(url),
      url,
      app,
      async () => true,
    );

    expect(response?.status).toBe(303);
    expect(response?.headers.get('set-cookie')).toStartWith('kortix_app_access=');
    expect(response?.headers.get('set-cookie')).toContain('; Secure;');
    expect(response?.headers.get('set-cookie')).toContain('; SameSite=None; Partitioned');
  });

  test('preserves the requested deep path through the password form', async () => {
    const request = new Request(
      'https://dev-password-aaaaaaaaaaaaaaaa.apps.kortix.com/reports/weekly?team=core',
      { headers: { accept: 'text/html' } },
    );
    const response = await authorizeAppRequest(request, new URL(request.url), {
      appId: '44444444-4444-4444-8444-444444444444',
      accountId: '99999999-9999-4999-8999-999999999999',
      projectId: '22222222-2222-4222-8222-222222222222',
      name: 'Password App',
      accessMode: 'password',
      accessPasswordHash: 'unused',
      accessRevision: 3,
      createdBy: null,
      updatedAt: new Date(),
    });

    expect(response?.status).toBe(401);
    expect(await response?.text()).toContain(
      'name="return_to" value="/reports/weekly?team=core"',
    );
  });

  test('verifies an App password and never stores it in the browser cookie', async () => {
    const password = 'correct-horse-battery-staple';
    const request = new Request('https://dev-password-aaaaaaaaaaaaaaaa.apps.kortix.com/_kortix/access/password', {
      method: 'POST',
      headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password, return_to: '/dashboard' }),
    });
    const response = await authorizeAppRequest(request, new URL(request.url), {
      appId: '44444444-4444-4444-8444-444444444444',
      accountId: '99999999-9999-4999-8999-999999999999',
      projectId: '22222222-2222-4222-8222-222222222222',
      name: 'Password App',
      accessMode: 'password',
      accessPasswordHash: await Bun.password.hash(password, { algorithm: 'argon2id' }),
      accessRevision: 2,
      createdBy: null,
      updatedAt: new Date(),
    });
    expect(response?.status).toBe(303);
    expect(response?.headers.get('location')).toBe('/dashboard');
    expect(response?.headers.get('set-cookie')).not.toContain(password);
  });

  test('rejects an incorrect App password without setting a cookie', async () => {
    const password = 'correct-horse-battery-staple';
    const request = new Request('https://dev-password-aaaaaaaaaaaaaaaa.apps.kortix.com/_kortix/access/password', {
      method: 'POST',
      headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'incorrect-password', return_to: '/reports' }),
    });
    const response = await authorizeAppRequest(request, new URL(request.url), {
      appId: '44444444-4444-4444-8444-444444444444',
      accountId: '99999999-9999-4999-8999-999999999999',
      projectId: '22222222-2222-4222-8222-222222222222',
      name: 'Password App',
      accessMode: 'password',
      accessPasswordHash: await Bun.password.hash(password, { algorithm: 'argon2id' }),
      accessRevision: 2,
      createdBy: null,
      updatedAt: new Date(),
    });

    expect(response?.status).toBe(401);
    expect(response?.headers.get('set-cookie')).toBeNull();
    const html = await response?.text();
    expect(html).toContain('The password is incorrect.');
    expect(html).toContain('name="return_to" value="/reports"');
  });
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

  test('direct-edge mode refuses a caller-supplied App host header', () => {
    // x-kortix-app-host is an EDGE-SIGNED field. In direct-edge mode (a
    // self-host with no Apps Worker, which `kortix self-host configure` now
    // sets up) nothing verifies a signature, so trusting the header would let
    // anyone who can reach the public API origin name any App and be proxied
    // into it, past that App's access policy. Only the real Host header counts.
    const spoofed = 'dev-victim-bbbbbbbbbbbbbbbb.apps.kortix.com';
    const request = new Request('https://api.kortix.com/secret', {
      headers: { 'x-kortix-app-host': spoofed },
    });
    const url = new URL(request.url);

    process.env.KORTIX_APPS_ALLOW_DIRECT_EDGE = 'true';
    try {
      // api.kortix.com is not an App hostname, so the request is not an App
      // request at all — it falls through to the ordinary API.
      expect(resolveAppRequest(request, url)).toBeNull();

      // A real App hostname still resolves, from the Host header alone.
      const direct = new Request(`https://${spoofed}/`, {
        headers: { 'x-kortix-app-host': 'dev-other-cccccccccccccccc.apps.kortix.com' },
      });
      expect(resolveAppRequest(direct, new URL(direct.url))).toEqual({
        routeKey: 'bbbbbbbbbbbbbbbb',
        local: false,
        publicHost: spoofed,
      });
    } finally {
      delete process.env.KORTIX_APPS_ALLOW_DIRECT_EDGE;
    }

    // With the Worker in front, the header IS the signed edge contract and
    // stays authoritative — verifyAppEdgeRequest checks the HMAC over it.
    expect(resolveAppRequest(request, url)).toEqual({
      routeKey: 'bbbbbbbbbbbbbbbb',
      local: false,
      publicHost: spoofed,
    });
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

  test('returns a machine-readable starting state without owner or provider details', async () => {
    const response = appPublicUnavailableResponse();

    expect(response.status).toBe(202);
    expect(response.headers.get('retry-after')).toBe('3');
    expect(await response.json()).toEqual({
      error: 'App deployment is starting',
      code: 'app_starting',
      status: 'starting',
    });
  });

  test('renders a stable budget state without exposing account billing details', async () => {
    const browser = appPublicBudgetResponse(
      new Request('https://dev-store-aaaaaaaaaaaaaaaa.apps.kortix.com/', {
        headers: { accept: 'text/html' },
      }),
      { name: 'Storefront' },
    );
    expect(browser.status).toBe(402);
    expect(browser.headers.get('retry-after')).toBeNull();
    const html = await browser.text();
    expect(html).toContain('App paused');
    expect(html).toContain('monthly compute limit');
    expect(html).not.toContain('http-equiv="refresh"');

    const machine = appPublicBudgetResponse(
      new Request('https://dev-store-aaaaaaaaaaaaaaaa.apps.kortix.com/'),
      { name: 'Storefront' },
    );
    expect(machine.status).toBe(402);
    expect(await machine.json()).toEqual({
      error: 'App compute budget reached',
      code: 'app_budget_exceeded',
      status: 'budget',
    });
  });

  test('renders an auto-refreshing boot page instead of unavailable JSON for browser requests', async () => {
    const response = appPublicUnavailableResponse(
      new Request('https://dev-store-aaaaaaaaaaaaaaaa.apps.kortix.com/', {
        headers: { accept: 'text/html' },
      }),
      { name: 'Storefront' },
    );

    expect(response.status).toBe(202);
    expect(response.headers.get('retry-after')).toBe('3');
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('Starting Storefront');
    expect(html).not.toContain('temporarily unavailable');
    expect(html).not.toContain('app_unavailable');
    expect(html).toContain('http-equiv="refresh"');
  });

  test('converts only a cold-wake ingress 502 into the branded starting response', async () => {
    const request = new Request('https://dev-store-aaaaaaaaaaaaaaaa.apps.kortix.com/', {
      headers: { accept: 'text/html' },
    });

    const coldResponse = appColdStartUpstreamResponse(
      request,
      { name: 'Storefront' },
      true,
      502,
    );
    expect(coldResponse?.status).toBe(202);
    expect(coldResponse?.headers.get('retry-after')).toBe('3');
    const html = await coldResponse?.text();
    expect(html).toContain('Starting Storefront');
    expect(html).not.toContain('temporarily unavailable');

    expect(appColdStartUpstreamResponse(request, { name: 'Storefront' }, false, 502)).toBeNull();
    expect(appColdStartUpstreamResponse(request, { name: 'Storefront' }, true, 500)).toBeNull();
    expect(appColdStartUpstreamResponse(request, { name: 'Storefront' }, true, 404)).toBeNull();
  });

  test('classifies only Daytona provider-stopped 400 responses as wake signals', () => {
    expect(appProviderStoppedResponse(
      'daytona',
      400,
      'bad request: failed to resolve container IP: no IP address found. Is the Sandbox started?',
    )).toBe(true);
    expect(appProviderStoppedResponse('daytona', 400, 'failed to get runner info')).toBe(true);
    expect(appProviderStoppedResponse('daytona', 400, 'application validation failed')).toBe(false);
    expect(appProviderStoppedResponse('platinum', 400, 'no IP address found')).toBe(false);
    expect(appProviderStoppedResponse('daytona', 502, 'no IP address found')).toBe(false);
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

  test('renders every lifecycle state without stale unavailable copy', async () => {
    const cases = [
      ['waiting', 'Waiting for first deployment', 202, true],
      ['queued', 'Deployment queued', 202, true],
      ['validating', 'Validating your App', 202, true],
      ['building', 'Building your App', 202, true],
      ['provisioning', 'Provisioning your App', 202, true],
      ['checking', 'Checking readiness', 202, true],
      ['ready', 'Activating your App', 202, true],
      ['starting', 'Starting Storefront', 202, true],
      ['budget', 'App paused', 402, false],
      ['failed', 'Deployment failed', 503, false],
      ['cancelled', 'Deployment cancelled', 503, false],
    ] as const;

    for (const [status, heading, httpStatus, refreshes] of cases) {
      const response = appPublicStatusResponse(
        new Request('https://dev-store-aaaaaaaaaaaaaaaa.apps.kortix.com/', {
          headers: { accept: 'text/html' },
        }),
        { name: 'Storefront' },
        { status },
      );
      expect(response.status).toBe(httpStatus);
      const html = await response.text();
      expect(html).toContain(heading);
      expect(html.includes('http-equiv="refresh"')).toBe(refreshes);
      expect(html).not.toContain('temporarily unavailable');
      expect(html).not.toContain('app_stopped');
      expect(html).not.toContain('App not found');
    }
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
