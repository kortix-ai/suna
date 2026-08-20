import { beforeEach, describe, expect, test } from 'bun:test';

// hostnames.ts reads config at import time; pin the env the same way
// hostnames.test.ts does so resolveAppHost matches a known base domain + env.
process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.FRONTEND_URL = 'https://app.example.com';
process.env.KORTIX_APPS_BASE_DOMAIN = 'apps.acme.com';

const { appTlsCheckStatus, createAppEdgeApp } = await import('./edge');

const ROUTE_KEY = 'aaaaaaaaaaaaaaaa';
const VALID_HOST = `dev-store-${ROUTE_KEY}.apps.acme.com`;
// A well-formed App host whose route key has no App row.
const UNKNOWN_HOST = 'dev-store-bbbbbbbbbbbbbbbb.apps.acme.com';

// Inject the existence check so the endpoint is exercised with no DB.
const appExists = async (routeKey: string) => routeKey === ROUTE_KEY;

describe('appTlsCheckStatus (on-demand-TLS gate decision)', () => {
  test('200 for a real, resolvable App host', async () => {
    expect(await appTlsCheckStatus(VALID_HOST, appExists)).toBe(200);
  });

  test('403 for a hostname that is not an App host shape', async () => {
    expect(await appTlsCheckStatus('evil.example.com', appExists)).toBe(403);
    // Right shape, wrong base domain — still 403 (never issue on a domain this
    // deployment does not serve).
    expect(await appTlsCheckStatus(`dev-store-${ROUTE_KEY}.apps.kortix.com`, appExists)).toBe(403);
    // Missing / empty domain.
    expect(await appTlsCheckStatus(undefined, appExists)).toBe(403);
    expect(await appTlsCheckStatus('', appExists)).toBe(403);
  });

  test('404 for an App-shaped host with no matching App', async () => {
    expect(await appTlsCheckStatus(UNKNOWN_HOST, appExists)).toBe(404);
  });
});

describe('GET /tls-check (Caddy on_demand_tls ask endpoint)', () => {
  let app: ReturnType<typeof createAppEdgeApp>;
  beforeEach(() => {
    app = createAppEdgeApp(appExists);
  });

  test('200 + {ok:true} for a valid App host', async () => {
    const res = await app.request(`/tls-check?domain=${VALID_HOST}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('403 for a bogus hostname', async () => {
    const res = await app.request('/tls-check?domain=evil.example.com');
    expect(res.status).toBe(403);
  });

  test('404 for an App-shaped host with no matching App', async () => {
    const res = await app.request(`/tls-check?domain=${UNKNOWN_HOST}`);
    expect(res.status).toBe(404);
  });

  test('403 when the domain query param is absent', async () => {
    const res = await app.request('/tls-check');
    expect(res.status).toBe(403);
  });
});
