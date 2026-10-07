/**
 * `/_kortix/api/v1/*` forwards an App's browser call to the Kortix API as its
 * viewer. The real cookie, HMAC check and header handling run; only the token
 * mint (it needs a database) is stubbed, and `forward` records what the API
 * would receive.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realViewer from './viewer';
import * as realAccess from './access';

process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.KORTIX_APPS_BASE_DOMAIN = 'apps.kortix.com';

const APP_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const HOST = 'dev-dashboards-abc.apps.kortix.com';

let minted: Array<{ appId: string; userId: string }> = [];
mock.module('./viewer', () => ({
  ...realViewer,
  mintAppViewerToken: async (app: { appId: string }, userId: string) => {
    minted.push({ appId: app.appId, userId });
    return { accessToken: 'kortix_oat_viewer', expiresAt: new Date(Date.now() + 3600_000), scopes: ['profile', 'email', 'kortix'] };
  },
}));

const { appApiProxyResponse } = await import('./public-proxy-api');

function appRow(overrides: Record<string, unknown> = {}) {
  return {
    appId: APP_ID,
    accountId: '55555555-5555-4555-8555-555555555555',
    projectId: '66666666-6666-4666-8666-666666666666',
    name: 'Dashboards',
    accessMode: 'restricted',
    accessPasswordHash: null,
    accessRevision: 3,
    createdBy: USER_ID,
    updatedAt: new Date(),
    viewerTokenScope: 'api',
    ...overrides,
  } as never;
}

function sessionCookie(): string {
  const token = realAccess.createAppAccessToken(
    { appId: APP_ID, kind: 'kortix', userId: USER_ID, revision: 3, expiresAt: new Date(Date.now() + 3600_000) },
    realAccess.appAccessSecret(),
  );
  return `__Host-kortix_app_access=${token}`;
}

let forwarded: Request[] = [];
const forward = async (request: Request) => {
  forwarded.push(request);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'set-cookie': 'api=1; Path=/' },
  });
};

async function call(path: string, init: RequestInit = {}, app = appRow()) {
  const request = new Request(`https://${HOST}${path}`, init);
  return appApiProxyResponse(request, new URL(request.url), HOST, app, forward);
}

const sameOrigin = (extra: Record<string, string> = {}) => ({
  cookie: sessionCookie(),
  'sec-fetch-site': 'same-origin',
  ...extra,
});

beforeEach(() => {
  minted = [];
  forwarded = [];
});

describe('the App API path', () => {
  test('forwards to /v1/* with the viewer token and none of the App’s credentials', async () => {
    const response = await call('/_kortix/api/v1/projects?limit=2', {
      headers: sameOrigin({
        authorization: 'Bearer app-own-key',
        'x-kortix-app-authorization': 'Bearer kortix_pat_x',
        'x-kortix-app-host': HOST,
        accept: 'application/json',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(minted).toEqual([{ appId: APP_ID, userId: USER_ID }]);
    expect(forwarded).toHaveLength(1);
    const sent = forwarded[0]!;
    const target = new URL(sent.url);
    expect(`${target.pathname}${target.search}`).toBe('/v1/projects?limit=2');
    expect(target.hostname).not.toBe(HOST);
    expect(sent.headers.get('authorization')).toBe('Bearer kortix_oat_viewer');
    expect(sent.headers.get('accept')).toBe('application/json');
    for (const name of ['cookie', 'x-kortix-app-authorization', 'x-kortix-app-host']) {
      expect(sent.headers.get(name)).toBeNull();
    }
  });

  test('forwards a write body', async () => {
    const response = await call('/_kortix/api/v1/projects/p/connectors/call', {
      method: 'POST',
      headers: sameOrigin({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name: 'ke2e-http' }),
    });
    expect(response.status).toBe(200);
    expect(forwarded[0]!.method).toBe('POST');
    expect(await forwarded[0]!.json()).toEqual({ name: 'ke2e-http' });
  });

  test('an App that is not API-scoped answers 403 viewer_api_disabled and mints nothing', async () => {
    for (const scope of ['identity', 'off']) {
      const response = await call('/_kortix/api/v1/accounts/me', { headers: sameOrigin() }, appRow({ viewerTokenScope: scope }));
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe('viewer_api_disabled');
    }
    expect(minted).toEqual([]);
    expect(forwarded).toEqual([]);
  });

  test('no signed-in viewer (a public App, a bearer caller) answers 401 no_viewer_identity', async () => {
    const response = await call('/_kortix/api/v1/accounts/me', {
      headers: { 'sec-fetch-site': 'same-origin', authorization: 'Bearer kortix_pat_x' },
    });
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe('no_viewer_identity');
    expect(forwarded).toEqual([]);
  });

  test('a cross-site request never acts as the viewer', async () => {
    const crossSite = await call('/_kortix/api/v1/accounts/me', { headers: sameOrigin({ 'sec-fetch-site': 'cross-site' }) });
    expect(crossSite.status).toBe(403);
    expect((await crossSite.json()).error).toBe('cross_site_request');
    // No Fetch Metadata (an older browser): a write needs this App's Origin.
    const foreignWrite = await call('/_kortix/api/v1/projects', {
      method: 'POST',
      headers: { cookie: sessionCookie(), origin: 'https://attacker.example.test' },
      body: '{}',
    });
    expect(foreignWrite.status).toBe(403);
    const noOriginWrite = await call('/_kortix/api/v1/projects', { method: 'POST', headers: { cookie: sessionCookie() }, body: '{}' });
    expect(noOriginWrite.status).toBe(403);
    const ownWrite = await call('/_kortix/api/v1/projects', {
      method: 'POST',
      headers: { cookie: sessionCookie(), origin: `https://${HOST}` },
      body: '{}',
    });
    expect(ownWrite.status).toBe(200);
    expect(forwarded).toHaveLength(1);
  });

  test('forwards /v1/* only, never /v1/oauth or an MCP endpoint', async () => {
    for (const path of ['/_kortix/api/health', '/_kortix/api/v1/oauth/token', '/_kortix/api/v1/%6fauth/token', '/_kortix/api/v1/mcp']) {
      const response = await call(path, { headers: sameOrigin() });
      expect(response.status).toBe(404);
    }
    expect(forwarded).toEqual([]);
  });
});
