/**
 * The Apps gate tells the container who is looking — and only the gate can.
 *
 * Everything here runs the REAL gate code: the real cookie the gate mints, the
 * real HMAC verification, the real header assembly. Only the two leaves that
 * need a database (identity lookup, token minting) are stubbed.
 */
import { describe, expect, mock, test } from 'bun:test';
import * as realViewer from './viewer';
import * as realAccess from './access';
import * as realCrypto from '../shared/crypto';

process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.KORTIX_APPS_BASE_DOMAIN = 'apps.kortix.com';

const APP_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '55555555-5555-4555-8555-555555555555';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const GROUP_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_USER = '99999999-9999-4999-8999-999999999999';

let mintedFor: Array<{ appId: string; userId: string; scope: string }> = [];

mock.module('../shared/crypto', () => ({
  ...realCrypto,
  isAccountToken: (t: string) => t.startsWith('kortix_pat_'),
  isServiceAccountToken: (t: string) => t.startsWith('kortix_sa_'),
  isKortixToken: (t: string) => t.startsWith('kortix_'),
}));

mock.module('../repositories/account-tokens', () => ({
  validateAccountToken: async (t: string) =>
    t === 'kortix_pat_member'
      ? { isValid: true, userId: OTHER_USER, accountId: ACCOUNT_ID, projectId: null, tokenId: 'tok-1' }
      : { isValid: false, error: 'Invalid PAT' },
}));
mock.module('../repositories/service-accounts', () => ({
  validateServiceAccountToken: async () => ({ isValid: false, error: 'Invalid service account' }),
}));

mock.module('./access', () => ({
  ...realAccess,
  // The bearer path's policy check — the real one needs the IAM engine + DB.
  appAccessibleToUser: async (_app: unknown, userId: string) => userId === OTHER_USER,
}));

mock.module('./viewer', () => ({
  ...realViewer,
  resolveAppViewerIdentity: async (userId: string) => ({
    email: `${userId}@example.test`,
    groupIds: [GROUP_ID],
  }),
  mintAppViewerToken: async (
    app: { appId: string; viewerTokenScope: string },
    userId: string,
  ) => {
    mintedFor.push({ appId: app.appId, userId, scope: app.viewerTokenScope });
    const scopes = realViewer.appViewerScopes(
      realViewer.normalizeViewerTokenScope(app.viewerTokenScope),
    );
    return scopes.length
      ? { accessToken: 'kortix_oat_minted', expiresAt: new Date(Date.now() + 3600_000), scopes }
      : null;
  },
}));

const {
  appUpstreamHeaders,
  appViewerContextHeader,
  appViewerEndpointResponse,
  resolveAppViewerUserId,
} = await import('./public-proxy');
const { createAppAccessToken, appAccessSecret } = realAccess;
const { APP_VIEWER_HEADER, APP_VIEWER_TOKEN_HEADER, appViewerSecret, verifyAppViewerContext } = realViewer;

function appRow(overrides: Record<string, unknown> = {}) {
  return {
    appId: APP_ID,
    accountId: ACCOUNT_ID,
    projectId: '66666666-6666-4666-8666-666666666666',
    name: 'Dashboards',
    accessMode: 'restricted',
    accessPasswordHash: null,
    accessRevision: 3,
    createdBy: USER_ID,
    updatedAt: new Date(),
    viewerTokenScope: 'identity',
    ...overrides,
  } as never;
}

const URL_HTTPS = new URL('https://dev-dashboards-abc.apps.kortix.com/');

/** The cookie the gate itself mints after a Kortix sign-in. */
function sessionCookie(revision = 3, kind: 'kortix' | 'password' = 'kortix') {
  const token = createAppAccessToken(
    {
      appId: APP_ID,
      kind,
      ...(kind === 'kortix' ? { userId: USER_ID } : {}),
      revision,
      expiresAt: new Date(Date.now() + 3600_000),
    },
    appAccessSecret(),
  );
  return `__Host-kortix_app_access=${token}`;
}

const req = (init: RequestInit = {}, path = '/') =>
  new Request(`${URL_HTTPS.origin}${path}`, init);

describe('resolveAppViewerUserId', () => {
  test('reads the viewer out of the gate’s own session cookie', () => {
    const request = req({ headers: { cookie: sessionCookie() } });
    expect(resolveAppViewerUserId(request, URL_HTTPS, appRow())).toBe(USER_ID);
  });

  test('a cookie from a previous access policy is ignored (revision bump revokes it)', () => {
    const request = req({ headers: { cookie: sessionCookie(2) } });
    expect(resolveAppViewerUserId(request, URL_HTTPS, appRow())).toBeNull();
  });

  test('password and public Apps carry no identity at all', () => {
    const request = req({ headers: { cookie: sessionCookie(3, 'password') } });
    expect(resolveAppViewerUserId(request, URL_HTTPS, appRow({ accessMode: 'password' }))).toBeNull();
    expect(resolveAppViewerUserId(request, URL_HTTPS, appRow({ accessMode: 'public' }))).toBeNull();
  });

  test('no cookie, a forged cookie, and another App’s cookie all answer null', () => {
    expect(resolveAppViewerUserId(req(), URL_HTTPS, appRow())).toBeNull();
    expect(
      resolveAppViewerUserId(
        req({ headers: { cookie: '__Host-kortix_app_access=not.a.token' } }),
        URL_HTTPS,
        appRow(),
      ),
    ).toBeNull();
    const otherApp = createAppAccessToken(
      {
        appId: '77777777-7777-4777-8777-777777777777',
        kind: 'kortix',
        userId: USER_ID,
        revision: 3,
        expiresAt: new Date(Date.now() + 3600_000),
      },
      appAccessSecret(),
    );
    expect(
      resolveAppViewerUserId(
        req({ headers: { cookie: `__Host-kortix_app_access=${otherApp}` } }),
        URL_HTTPS,
        appRow(),
      ),
    ).toBeNull();
  });
});

describe('the viewer header the container receives', () => {
  test('is signed with the App’s own secret and carries identity', async () => {
    const request = req({ headers: { cookie: sessionCookie() } });
    const header = await appViewerContextHeader(request, URL_HTTPS, appRow());
    expect(header).toBeTruthy();
    expect(header!.token).toBeNull(); // identity scope carries no API token
    const verified = verifyAppViewerContext(header!.context, appViewerSecret(APP_ID));
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error('expected ok');
    expect(verified.viewer).toMatchObject({
      appId: APP_ID,
      userId: USER_ID,
      email: `${USER_ID}@example.test`,
      groupIds: [GROUP_ID],
      accountId: ACCOUNT_ID,
      accessMode: 'restricted',
    });
  });

  test('an `api`-scoped App also receives the viewer’s token, ready to use', async () => {
    const request = req({ headers: { cookie: sessionCookie() } });
    const header = await appViewerContextHeader(request, URL_HTTPS, appRow({ viewerTokenScope: 'api' }));
    expect(header!.token).toBe('kortix_oat_minted');
  });

  test('is absent when the App opted out (`viewer_token_scope: off`)', async () => {
    const request = req({ headers: { cookie: sessionCookie() } });
    expect(await appViewerContextHeader(request, URL_HTTPS, appRow({ viewerTokenScope: 'off' }))).toBeNull();
  });

  test('a client-supplied viewer header is DELETED, never forwarded', () => {
    const forged = req({ headers: { [APP_VIEWER_HEADER]: 'forged.header', cookie: sessionCookie() } });
    // No gate-resolved viewer → the header must not survive.
    expect(appUpstreamHeaders(forged, {}, 'x.apps.kortix.com', null).get(APP_VIEWER_HEADER)).toBeNull();
    // With one → exactly the gate's value, never the client's.
    const carried = appUpstreamHeaders(forged, {}, 'x.apps.kortix.com', {
      context: 'gate.value',
      token: 'kortix_oat_minted',
    });
    expect(carried.get(APP_VIEWER_HEADER)).toBe('gate.value');
    expect(carried.get(APP_VIEWER_TOKEN_HEADER)).toBe('kortix_oat_minted');
  });
});

describe('GET /_kortix/viewer', () => {
  test('hands a signed-in viewer their identity and an App-scoped token', async () => {
    mintedFor = [];
    const request = req({ headers: { cookie: sessionCookie() } }, '/_kortix/viewer');
    const res = await appViewerEndpointResponse(request, URL_HTTPS, appRow());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      app_id: APP_ID,
      access_mode: 'restricted',
      account_id: ACCOUNT_ID,
      user_id: USER_ID,
      email: `${USER_ID}@example.test`,
      group_ids: [GROUP_ID],
      scopes: ['profile', 'email'],
      access_token: 'kortix_oat_minted',
      expires_at: expect.any(String),
    });
    expect(mintedFor).toEqual([{ appId: APP_ID, userId: USER_ID, scope: 'identity' }]);
  });

  test('`api` scope adds `kortix` so the App can act as the viewer', async () => {
    const request = req({ headers: { cookie: sessionCookie() } }, '/_kortix/viewer');
    const res = await appViewerEndpointResponse(request, URL_HTTPS, appRow({ viewerTokenScope: 'api' }));
    expect((await res.json()).scopes).toEqual(['profile', 'email', 'kortix']);
  });

  test('no session → 401, and nothing is minted', async () => {
    mintedFor = [];
    const res = await appViewerEndpointResponse(req({}, '/_kortix/viewer'), URL_HTTPS, appRow());
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('no_viewer_identity');
    expect(mintedFor).toEqual([]);
  });

  test('an App that opted out answers 404, even for a signed-in viewer', async () => {
    const request = req({ headers: { cookie: sessionCookie() } }, '/_kortix/viewer');
    const res = await appViewerEndpointResponse(request, URL_HTTPS, appRow({ viewerTokenScope: 'off' }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('viewer_disabled');
  });

  test('a server-side caller may present its own Kortix credential — and must pass the App policy', async () => {
    const allowed = await appViewerEndpointResponse(
      req({ headers: { authorization: 'Bearer kortix_pat_member' } }, '/_kortix/viewer'),
      URL_HTTPS,
      appRow(),
    );
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).user_id).toBe(OTHER_USER);

    const refused = await appViewerEndpointResponse(
      req({ headers: { authorization: 'Bearer kortix_pat_unknown' } }, '/_kortix/viewer'),
      URL_HTTPS,
      appRow(),
    );
    expect(refused.status).toBe(401);
  });
});
