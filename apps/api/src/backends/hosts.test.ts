import { afterEach, describe, expect, test } from 'bun:test';

process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.FRONTEND_URL = 'https://app.example.com';
delete process.env.KORTIX_APPS_BASE_DOMAIN;
delete process.env.KORTIX_APPS_LOCAL;

const { config } = await import('../config');
const { resolveAppHost } = await import('../apps/hostnames');
const { backendDashboardUrl, backendHostUrl, backendPublicUrls, resolveBackendHost, prepareBackendWsUpgrade, resolveBackendRequest } =
  await import('./hosts');

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const HEX = '0f8fad5bd9cb469fa16570867728950e';
const originalUrl = config.KORTIX_URL;
const row = (patch: Record<string, unknown> = {}) =>
  ({ backendId: ID, status: 'running', url: 'https://x', metadata: { dashboard: true }, ...patch }) as never;
const cloud = () => ((config as { KORTIX_URL: string }).KORTIX_URL = 'https://dev-api.kortix.com');
const local = () => ((config as { KORTIX_URL: string }).KORTIX_URL = 'http://localhost:8008');

afterEach(() => {
  (config as { KORTIX_URL: string }).KORTIX_URL = originalUrl;
  delete process.env.KORTIX_APPS_EDGE_SECRET;
});

describe('backend hosts', () => {
  test('cloud: three hosts per backend on the Apps domain, each round-tripping the id and its kind', () => {
    cloud();
    expect(backendPublicUrls(ID)).toEqual({
      url: `https://dev-convex-${HEX}.apps.kortix.com`,
      siteUrl: `https://dev-convex-site-${HEX}.apps.kortix.com`,
    });
    expect(backendDashboardUrl(row())).toBe(`https://dev-backend-${HEX}.apps.kortix.com`);
    for (const kind of ['api', 'site', 'dashboard'] as const) {
      const host = new URL(backendHostUrl(ID, kind)!).hostname;
      expect(resolveBackendHost(host)).toEqual({ backendId: ID, kind, local: false });
      // Never an App host.
      expect(resolveAppHost(host)).toBeNull();
    }
  });

  test('cloud: another environment, another domain, a short id or an App-shaped label is not a backend host', () => {
    cloud();
    expect(resolveBackendHost(`prod-convex-${HEX}.apps.kortix.com`)).toBeNull();
    expect(resolveBackendHost(`dev-convex-${HEX}.apps.example.com`)).toBeNull();
    expect(resolveBackendHost(`dev-convex-${HEX.slice(1)}.apps.kortix.com`)).toBeNull();
    expect(resolveBackendHost(`dev-convex-${HEX.slice(0, 16)}.apps.kortix.com`)).toBeNull();
    expect(resolveBackendHost(`x.dev-convex-${HEX}.apps.kortix.com`)).toBeNull();
    // A local host is answered only by a local stack.
    expect(resolveBackendHost(`bc-${HEX}.apps.localhost`)).toBeNull();
  });

  test('local: bc-/bs-/bd-<id>.apps.localhost on the API port', () => {
    local();
    const { url, siteUrl } = backendPublicUrls(ID);
    expect(url).toMatch(new RegExp(`^http://bc-${HEX}\\.apps\\.localhost:\\d+$`));
    expect(siteUrl).toMatch(new RegExp(`^http://bs-${HEX}\\.apps\\.localhost:\\d+$`));
    expect(backendDashboardUrl(row())).toMatch(new RegExp(`^http://bd-${HEX}\\.apps\\.localhost:\\d+$`));
    expect(resolveBackendHost(`bc-${HEX}.apps.localhost`)).toEqual({ backendId: ID, kind: 'api', local: true });
    expect(resolveBackendHost(`bs-${HEX}.apps.localhost`)).toEqual({ backendId: ID, kind: 'site', local: true });
    expect(resolveBackendHost(`bd-${HEX}.apps.localhost`)).toEqual({ backendId: ID, kind: 'dashboard', local: true });
    expect(resolveBackendHost(`bx-${HEX}.apps.localhost`)).toBeNull();
    expect(resolveBackendHost(`bc-${HEX.slice(1)}.apps.localhost`)).toBeNull();
  });

  test('no dashboard URL for a machine without the dashboard or not running', () => {
    expect(backendDashboardUrl(row({ metadata: {} }))).toBeNull();
    expect(backendDashboardUrl(row({ status: 'provisioning' }))).toBeNull();
  });

  test('the gate: an unsigned request to a cloud host is refused before any lookup', async () => {
    cloud();
    process.env.KORTIX_APPS_EDGE_SECRET = 'synthetic-edge-secret';
    const req = new Request(`https://dev-convex-${HEX}.apps.kortix.com/api/1.46.0/sync`, { headers: { upgrade: 'websocket' } });
    const url = new URL(req.url);
    const matched = resolveBackendRequest(req, url)!;
    expect(matched).toMatchObject({ backendId: ID, kind: 'api', local: false });
    expect(await prepareBackendWsUpgrade(req, url, matched)).toEqual({ ok: false, status: 403, message: 'Forbidden' });
  });

  test('the gate: the dashboard host never upgrades a WebSocket', async () => {
    local();
    const req = new Request(`http://bd-${HEX}.apps.localhost:8008/`, { headers: { upgrade: 'websocket' } });
    const url = new URL(req.url);
    const result = await prepareBackendWsUpgrade(req, url, resolveBackendRequest(req, url)!);
    expect(result).toMatchObject({ ok: false, status: 404 });
  });
});
