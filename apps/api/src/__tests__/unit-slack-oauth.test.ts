import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realConnectorSync from '../connectors/sync';

/**
 * The Slack OAuth install is bound to the Kortix user who started it. The
 * callback (the registered redirect URI) carries no Kortix credential, so it
 * installs nothing and hands the browser to the web completion page. The
 * completion step installs only for the user and project the signed state names.
 */

const PROJECT_ID = '4967754f-867c-45b1-b647-da56f99a55d9';
const OTHER_PROJECT_ID = '0a4c1d52-2f0e-4d6b-9f55-7f6b3c7d9a10';
const USER_ID = '49851790-41b5-4c3e-a39e-a022d0976255';
const OTHER_USER_ID = 'b1f3e0c4-6a55-4d3e-8c1a-1f2e3d4c5b6a';
const WORKSPACE_ID = 'T123';

let projectRows: Array<{ projectId: string }> = [];
let saveError: Error | null = null;
const saveCalls: Array<Record<string, unknown>> = [];
let fetchCalls = 0;
let identityRow: { userId: string } | null = null;
const linkCalls: Array<Record<string, unknown>> = [];

function makeSelectChain(): any {
  const chain: any = {};
  for (const method of ['from', 'where', 'limit']) chain[method] = () => chain;
  chain.then = (resolve: (rows: Array<{ projectId: string }>) => unknown) =>
    Promise.resolve(resolve(projectRows));
  return chain;
}

mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => makeSelectChain(),
  },
}));

mock.module('../config', () => ({
  SANDBOX_VERSION: 'test',
  config: {
    SLACK_SIGNING_SECRET: 'state-secret',
    API_KEY_SECRET: 'unit-test-api-key-secret',
    SLACK_CLIENT_ID: 'client-id',
    SLACK_CLIENT_SECRET: 'client-secret',
    SLACK_REDIRECT_URI: 'https://dev-api.kortix.com/v1/webhooks/slack/oauth/callback',
    SLACK_OAUTH_SCOPES: 'app_mentions:read,chat:write,commands',
    SLACK_REQUIRE_USER_IDENTITY: false,
    FRONTEND_URL: 'https://dev.kortix.com',
  },
}));

const realInstallStore = await import('../channels/install-store');
mock.module('../channels/install-store', () => ({
  ...realInstallStore,
  saveSlackOauthInstall: async (input: Record<string, unknown>) => {
    saveCalls.push(input);
    if (saveError) throw saveError;
  },
  loadSlackTokenForProject: async () => null,
}));

const realIdentity = await import('../channels/slack/identity');
mock.module('../channels/slack/identity', () => ({
  ...realIdentity,
  lookupSlackIdentity: async () => identityRow,
  linkSlackIdentity: async (input: Record<string, unknown>) => {
    linkCalls.push(input);
  },
}));

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../connectors/sync', () => ({
  ...realConnectorSync,
  reconcileChannelConnectors: async () => undefined,
}));

const realFetch = globalThis.fetch;
let slackResponse: Record<string, unknown> = {};

beforeEach(() => {
  projectRows = [{ projectId: PROJECT_ID }];
  saveError = null;
  saveCalls.length = 0;
  linkCalls.length = 0;
  identityRow = null;
  fetchCalls = 0;
  slackResponse = {
    ok: true,
    access_token: 'xoxb-new-token',
    bot_user_id: 'U_BOT',
    team: { id: WORKSPACE_ID, name: 'KortixDev' },
    authed_user: { id: 'U_ADMIN' },
  };
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify(slackResponse), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as any;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const { config } = (await import('../config')) as { config: Record<string, unknown> };
const oauth = (await import('../channels/slack-oauth')) as any;
const { slackOauthApp, buildSlackInstallUrl } = oauth;

function stateFromInstallUrl(projectId = PROJECT_ID, userId = USER_ID): string {
  const url = new URL(buildSlackInstallUrl(projectId, userId));
  const state = url.searchParams.get('state');
  if (!state) throw new Error('missing state');
  return state;
}

function redirectLocation(res: Response): string {
  const location = res.headers.get('location');
  if (!location) throw new Error('missing redirect location');
  return location;
}

function complete(input: Partial<{ projectId: string; userId: string; code: string; state: string }> = {}) {
  return oauth.completeSlackOauthInstall({
    projectId: PROJECT_ID,
    userId: USER_ID,
    code: 'code-1',
    state: stateFromInstallUrl(),
    ...input,
  });
}

const dashboard = (qs: string) =>
  `https://dev.kortix.com/projects/${PROJECT_ID}?projectId=${PROJECT_ID}&${qs}&customize=connectors`;

describe('Slack OAuth callback', () => {
  test('the callback hands off to web completion and saves nothing', async () => {
    const state = stateFromInstallUrl();
    const res = await slackOauthApp.request(`/callback?code=code-1&state=${state}`);

    expect(res.status).toBe(302);
    const location = new URL(redirectLocation(res));
    expect(`${location.origin}${location.pathname}`).toBe('https://dev.kortix.com/slack/install');
    expect(location.searchParams.get('project')).toBe(PROJECT_ID);
    expect(location.searchParams.get('code')).toBe('code-1');
    expect(location.searchParams.get('state')).toBe(state);
    expect(saveCalls).toHaveLength(0);
    expect(fetchCalls).toBe(0);
  });

  test('the callback never changes an identity link', async () => {
    config.SLACK_REQUIRE_USER_IDENTITY = true;
    try {
      identityRow = { userId: OTHER_USER_ID };
      await slackOauthApp.request(`/callback?code=code-1&state=${stateFromInstallUrl()}`);
      expect(linkCalls).toHaveLength(0);
    } finally {
      config.SLACK_REQUIRE_USER_IDENTITY = false;
    }
  });

  test('a Slack error redirects to the project with the error', async () => {
    const res = await slackOauthApp.request(`/callback?error=access_denied&state=${stateFromInstallUrl()}`);
    expect(redirectLocation(res)).toBe(dashboard('error=access_denied'));
    expect(saveCalls).toHaveLength(0);
  });

  test('a tampered state is a 400', async () => {
    const res = await slackOauthApp.request(`/callback?code=code-1&state=${stateFromInstallUrl()}x`);
    expect(res.status).toBe(400);
  });
});

describe('Slack OAuth completion', () => {
  test('the user who started the install completes it: saved, lands on the connectors page', async () => {
    const result = await complete();

    expect(result).toEqual({ ok: true, redirectUrl: dashboard('success=1') });
    expect(saveCalls).toEqual([{
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      botToken: 'xoxb-new-token',
      botUserId: 'U_BOT',
      teamName: 'KortixDev',
    }]);
  });

  test('another Kortix user is refused with 403 before the code is exchanged, and nothing is saved', async () => {
    const result = await complete({ userId: OTHER_USER_ID });
    expect(result).toMatchObject({ ok: false, status: 403, code: 'CHANNEL_INSTALL_STATE_MISMATCH' });
    expect(fetchCalls).toBe(0);
    expect(saveCalls).toHaveLength(0);
  });

  test('another project is refused with 403, and nothing is saved', async () => {
    const result = await complete({ projectId: OTHER_PROJECT_ID });
    expect(result).toMatchObject({ ok: false, status: 403, code: 'CHANNEL_INSTALL_STATE_MISMATCH' });
    expect(saveCalls).toHaveLength(0);
  });

  test('a state that does not verify is refused with 400', async () => {
    const result = await complete({ state: 'not-a-state' });
    expect(result).toMatchObject({ ok: false, status: 400, code: 'CHANNEL_INSTALL_STATE_INVALID' });
    expect(fetchCalls).toBe(0);
  });

  test('a failed save lands on the project with the save error', async () => {
    saveError = new Error('duplicate install/schema drift');
    expect(await complete()).toEqual({ ok: true, redirectUrl: dashboard('error=slack_install_save_failed') });
    expect(saveCalls).toHaveLength(1);
  });

  test('a token exchange that throws lands on the project with the exchange error', async () => {
    globalThis.fetch = (async () => {
      throw new Error('slack unavailable');
    }) as any;
    expect(await complete()).toEqual({ ok: true, redirectUrl: dashboard('error=oauth_exchange_failed') });
    expect(saveCalls).toHaveLength(0);
  });

  test('Slack rejecting the code lands on the project with Slack error', async () => {
    slackResponse = { ok: false, error: 'invalid_code' };
    expect(await complete()).toEqual({ ok: true, redirectUrl: dashboard('error=invalid_code') });
    expect(saveCalls).toHaveLength(0);
  });
});

describe('Slack OAuth installer identity', () => {
  beforeEach(() => {
    config.SLACK_REQUIRE_USER_IDENTITY = true;
  });
  afterEach(() => {
    config.SLACK_REQUIRE_USER_IDENTITY = false;
  });

  test('an absent link is created for the installing user', async () => {
    identityRow = null;
    await complete();
    expect(linkCalls).toEqual([{ teamId: WORKSPACE_ID, slackUserId: 'U_ADMIN', userId: USER_ID }]);
  });

  test('a link to the same Kortix user is refreshed', async () => {
    identityRow = { userId: USER_ID };
    await complete();
    expect(linkCalls).toHaveLength(1);
  });

  test('a live link to another Kortix user stays unchanged', async () => {
    identityRow = { userId: OTHER_USER_ID };
    const result = await complete();
    expect(result.ok).toBe(true);
    expect(saveCalls).toHaveLength(1);
    expect(linkCalls).toHaveLength(0);
  });
});
