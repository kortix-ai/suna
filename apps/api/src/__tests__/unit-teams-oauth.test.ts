import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHmac } from 'node:crypto';

/**
 * The one-click Teams install callback. On dev (2026-09-17) it redirected to a
 * bare `?teams=consented` after saving the tenant: the org-catalog publish had
 * failed inside a 30 s abort, nothing recorded why, and nothing in the web app
 * read the status. These tests pin the replacement contract:
 *
 * - the publish outcome is persisted on the install (publishing → published /
 *   review / failed + reason), so the dashboard can show it;
 * - the browser is never held hostage by Graph — a slow publish redirects
 *   `?teams=publishing` at once and finishes in the background;
 * - the redirect lands on the Channels surface, where the row shows the state.
 */

const PROJECT_ID = '40c2e222-c4c2-47f6-ba40-05e8f40098b3';
const TENANT_ID = '36009a52-46d2-44bc-ba56-57a87e485e0a';
const BASE_URL = 'https://dev-api.kortix.com';
const CHANNELS_URL = `https://dev.kortix.com/projects/${PROJECT_ID}/customize/connectors?scope=channels`;

let flagOn = true;
let tokenExchangeOk = true;
const saved: Array<Record<string, unknown>> = [];
const states: Array<{ state: string; error?: string | null }> = [];
const orgInstalled: boolean[] = [];
const catalogIds: string[] = [];
let publishImpl: () => Promise<Record<string, unknown>> = async () => ({ ok: true, published: true, teamsAppId: 'cat-1' });

mock.module('../config', () => ({
  SANDBOX_VERSION: 'test',
  config: {
    MICROSOFT_APP_ID: '62b4470a-e8e6-4e13-a73f-363de2209dfc',
    MICROSOFT_APP_PASSWORD: 'app-secret',
    API_KEY_SECRET: 'unit-test-api-key-secret',
    FRONTEND_URL: 'https://dev.kortix.com',
    TEAMS_APP_NAME: 'Kortix Dev',
  },
}));

mock.module('../feature-flags/for-project', () => ({
  projectFeatureFlagEnabled: async () => flagOn,
}));

const realInstallStore = await import('../channels/install-store');
mock.module('../channels/install-store', () => ({
  ...realInstallStore,
  saveTeamsInstall: async (input: Record<string, unknown>) => {
    saved.push(input);
    return { tenantId: input.tenantId };
  },
  setTeamsPublishState: async (_projectId: string, state: string, error?: string | null) => {
    states.push(error === undefined ? { state } : { state, error });
  },
  setTeamsOrgInstalled: async (_projectId: string, installed: boolean) => {
    orgInstalled.push(installed);
  },
  setTeamsCatalogAppId: async (_projectId: string, id: string) => {
    catalogIds.push(id);
  },
}));

mock.module('../channels/teams/catalog', () => ({
  publishTeamsAppToCatalog: () => publishImpl(),
}));

// teams-oauth.ts imports exactly one name from ../connectors/sync. The file
// runs under --isolate, so a hand-listed stub cannot leak into a sibling suite,
// and NOT loading the real module keeps the Composio client (an optional dep
// that a fresh worktree may not have installed) out of this test's graph.
mock.module('../connectors/sync', () => ({
  reconcileChannelConnectors: async () => undefined,
}));

const realFetch = globalThis.fetch;

function graphJwt(tid: string): string {
  const b64 = (v: string) => Buffer.from(v).toString('base64url');
  return `${b64('{"alg":"RS256"}')}.${b64(JSON.stringify({ tid, scp: 'AppCatalog.ReadWrite.All' }))}.sig`;
}

beforeEach(() => {
  flagOn = true;
  tokenExchangeOk = true;
  saved.length = 0;
  states.length = 0;
  orgInstalled.length = 0;
  catalogIds.length = 0;
  publishImpl = async () => ({ ok: true, published: true, teamsAppId: 'cat-1' });
  globalThis.fetch = (async (url: any) => {
    // Only the token endpoint may be called from the callback; the catalog
    // publish is mocked at the module boundary above.
    if (new URL(String(url)).hostname !== 'login.microsoftonline.com') {
      throw new Error(`unexpected fetch ${url}`);
    }
    if (!tokenExchangeOk) return new Response('{"error":"invalid_grant"}', { status: 400 });
    return new Response(JSON.stringify({ access_token: graphJwt(TENANT_ID), expires_in: 3600 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as any;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  mock.restore();
});

const oauth = (await import('../channels/teams-oauth')) as any;
const { teamsOauthApp, teamsOrgConsentUrl, setTeamsPublishRedirectWaitForTest } = oauth;

const USER_ID = '8c7d5e1a-3b2f-4e6d-9a1c-0f2e4d6b8a3c';
const OTHER_USER_ID = '1e2d3c4b-5a69-4788-9a0b-1c2d3e4f5a6b';
const OTHER_PROJECT_ID = '7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2910';

function state(userId = USER_ID): string {
  const url = teamsOrgConsentUrl({ projectId: PROJECT_ID, userId, baseUrl: BASE_URL, enabled: true });
  const s = url && new URL(url).searchParams.get('state');
  if (!s) throw new Error('missing state');
  return s;
}

function location(res: Response): string {
  const l = res.headers.get('location');
  if (!l) throw new Error('missing redirect location');
  return l;
}

function complete(input: Partial<{ projectId: string; userId: string; code: string; state: string }> = {}) {
  return oauth.completeTeamsOauthInstall({
    projectId: PROJECT_ID,
    userId: USER_ID,
    code: 'c1',
    state: state(),
    ...input,
  });
}

const landed = (status: string) => ({ ok: true, redirectUrl: `${CHANNELS_URL}&teams=${status}` });

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Teams one-click install callback', () => {
  test('consent URL asks for the delegated catalog scope and carries the callback', () => {
    const url = new URL(teamsOrgConsentUrl({ projectId: PROJECT_ID, userId: USER_ID, baseUrl: BASE_URL, enabled: true })!);
    expect(url.searchParams.get('scope')).toContain('AppCatalog.ReadWrite.All');
    expect(url.searchParams.get('redirect_uri')).toBe(`${BASE_URL}/v1/webhooks/teams/oauth/callback`);
    expect(url.searchParams.get('client_id')).toBe('62b4470a-e8e6-4e13-a73f-363de2209dfc');
  });

  test('the callback hands off to web completion and saves nothing', async () => {
    const s = state();
    const res = await teamsOauthApp.request(`/callback?code=c1&state=${s}`);

    expect(res.status).toBe(302);
    const target = new URL(location(res));
    expect(`${target.origin}${target.pathname}`).toBe('https://dev.kortix.com/teams/install');
    expect(target.searchParams.get('project')).toBe(PROJECT_ID);
    expect(target.searchParams.get('code')).toBe('c1');
    expect(target.searchParams.get('state')).toBe(s);
    expect(saved).toHaveLength(0);
    expect(states).toHaveLength(0);
  });

  test('flag off for the project → ?teams=disabled, nothing saved', async () => {
    flagOn = false;
    const res = await teamsOauthApp.request(`/callback?code=c6&state=${state()}`);
    expect(location(res)).toBe(`${CHANNELS_URL}&teams=disabled`);
    expect(saved).toHaveLength(0);
  });

  test('user declined at Microsoft → ?teams=declined', async () => {
    const res = await teamsOauthApp.request(`/callback?error=access_denied&state=${state()}`);
    expect(location(res)).toBe(`${CHANNELS_URL}&teams=declined`);
    expect(saved).toHaveLength(0);
  });

  test('tampered or expired state → home with ?teams_error=expired', async () => {
    const res = await teamsOauthApp.request(`/callback?code=c8&state=${state()}x`);
    expect(location(res)).toBe('https://dev.kortix.com/?teams_error=expired');
  });
});

describe('Teams one-click install completion', () => {
  test('admin publish completes within the wait → ?teams=connected on the Channels page, outcome persisted', async () => {
    expect(await complete()).toEqual(landed('connected'));
    expect(saved).toEqual([{ projectId: PROJECT_ID, tenantId: TENANT_ID }]);
    expect(states).toEqual([{ state: 'publishing' }, { state: 'published' }]);
    expect(orgInstalled).toEqual([true]);
    expect(catalogIds).toEqual(['cat-1']);
  });

  test('another Kortix user is refused with 403 before the code is exchanged, and nothing is saved', async () => {
    tokenExchangeOk = false;
    const result = await complete({ state: state(OTHER_USER_ID) });
    expect(result).toMatchObject({ ok: false, status: 403, code: 'CHANNEL_INSTALL_STATE_MISMATCH' });
    expect(saved).toHaveLength(0);
    expect(states).toHaveLength(0);
  });

  test('another project is refused with 403, and nothing is saved', async () => {
    const result = await complete({ projectId: OTHER_PROJECT_ID });
    expect(result).toMatchObject({ ok: false, status: 403, code: 'CHANNEL_INSTALL_STATE_MISMATCH' });
    expect(saved).toHaveLength(0);
  });

  test('a state that does not verify is refused with 400', async () => {
    const result = await complete({ state: 'nope' });
    expect(result).toMatchObject({ ok: false, status: 400, code: 'CHANNEL_INSTALL_STATE_INVALID' });
    expect(saved).toHaveLength(0);
  });

  test('non-admin submit → ?teams=review, state "review"', async () => {
    publishImpl = async () => ({ ok: true, published: false, pendingReview: true, teamsAppId: 'sub-9' });

    expect(await complete()).toEqual(landed('review'));
    expect(states).toEqual([{ state: 'publishing' }, { state: 'review' }]);
    expect(orgInstalled).toEqual([]);
    expect(catalogIds).toEqual(['sub-9']);
  });

  test('Graph rejects the package → ?teams=failed, the reason is persisted on the install', async () => {
    publishImpl = async () => ({
      ok: false,
      published: false,
      error: 'Graph app-catalog publish failed (400): Invalid manifest',
    });

    expect(await complete()).toEqual(landed('failed'));
    expect(states).toEqual([
      { state: 'publishing' },
      { state: 'failed', error: 'Graph app-catalog publish failed (400): Invalid manifest' },
    ]);
    expect(saved).toHaveLength(1);
  });

  test('publish throws → still ?teams=failed with the thrown message, never a 500', async () => {
    publishImpl = async () => {
      throw new Error('socket hang up');
    };

    expect(await complete()).toEqual(landed('failed'));
    expect(states[1]).toEqual({ state: 'failed', error: 'socket hang up' });
  });

  test('a slow publish answers ?teams=publishing at once and finishes in the background', async () => {
    setTeamsPublishRedirectWaitForTest(20);
    let release!: (v: Record<string, unknown>) => void;
    publishImpl = () => new Promise((r) => (release = r));

    expect(await complete()).toEqual(landed('publishing'));
    expect(states).toEqual([{ state: 'publishing' }]);
    expect(saved).toHaveLength(1);

    release({ ok: true, published: true, teamsAppId: 'cat-late' });
    await tick();
    await tick();

    expect(states).toEqual([{ state: 'publishing' }, { state: 'published' }]);
    expect(catalogIds).toEqual(['cat-late']);
    setTeamsPublishRedirectWaitForTest(null);
  });

  test('flag off for the project → ?teams=disabled, nothing saved', async () => {
    flagOn = false;
    expect(await complete()).toEqual(landed('disabled'));
    expect(saved).toHaveLength(0);
  });

  test('token exchange fails → ?teams=failed, nothing saved', async () => {
    tokenExchangeOk = false;
    expect(await complete()).toEqual(landed('failed'));
    expect(saved).toHaveLength(0);
    expect(states).toHaveLength(0);
  });
});

/**
 * `MICROSOFT_APP_PASSWORD` defaults to '' (config.ts optStr), so a `??`
 * fallback on it never fired and the state could be MACed with an empty key,
 * which anyone can compute. The state key now derives from API_KEY_SECRET.
 */
describe('Teams install state key', () => {
  test('a state MACed with an empty key is refused while MICROSOFT_APP_PASSWORD is empty, and nothing is saved', async () => {
    const { config } = (await import('../config')) as { config: Record<string, unknown> };
    const original = config.MICROSOFT_APP_PASSWORD;
    config.MICROSOFT_APP_PASSWORD = '';
    try {
      const body = Buffer.from(
        JSON.stringify({ projectId: PROJECT_ID, userId: USER_ID, baseUrl: BASE_URL, exp: Date.now() + 60_000, nonce: 'n' }),
      ).toString('base64url');
      const forged = `${body}.${createHmac('sha256', '').update(body).digest('base64url')}`;
      const res = await teamsOauthApp.request(`/callback?code=c9&state=${forged}`);
      expect(location(res)).toBe('https://dev.kortix.com/?teams_error=expired');
      expect(saved).toHaveLength(0);
    } finally {
      config.MICROSOFT_APP_PASSWORD = original;
    }
  });

  test('a state MACed with the app password is refused', async () => {
    const body = Buffer.from(
      JSON.stringify({ projectId: PROJECT_ID, userId: USER_ID, baseUrl: BASE_URL, exp: Date.now() + 60_000, nonce: 'n' }),
    ).toString('base64url');
    const forged = `${body}.${createHmac('sha256', 'app-secret').update(body).digest('base64url')}`;
    const res = await teamsOauthApp.request(`/callback?code=c10&state=${forged}`);
    expect(location(res)).toBe('https://dev.kortix.com/?teams_error=expired');
    expect(saved).toHaveLength(0);
  });
});
