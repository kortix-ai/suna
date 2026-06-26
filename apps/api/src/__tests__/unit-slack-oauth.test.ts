import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const PROJECT_ID = '4967754f-867c-45b1-b647-da56f99a55d9';
const USER_ID = '49851790-41b5-4c3e-a39e-a022d0976255';
const WORKSPACE_ID = 'T123';

let projectRows: Array<{ projectId: string }> = [];
let saveError: Error | null = null;
const saveCalls: Array<Record<string, unknown>> = [];

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
    SLACK_CLIENT_ID: 'client-id',
    SLACK_CLIENT_SECRET: 'client-secret',
    SLACK_REDIRECT_URI: 'https://dev-api.kortix.com/v1/webhooks/slack/oauth/callback',
    SLACK_OAUTH_SCOPES: 'app_mentions:read,chat:write,commands',
    FRONTEND_URL: 'https://dev.kortix.com',
  },
}));

mock.module('../channels/install-store', () => ({
  saveSlackOauthInstall: async (input: Record<string, unknown>) => {
    saveCalls.push(input);
    if (saveError) throw saveError;
  },
}));

mock.module('../executor/sync', () => ({
  reconcileChannelConnectors: async () => undefined,
}));

const realFetch = globalThis.fetch;

beforeEach(() => {
  projectRows = [{ projectId: PROJECT_ID }];
  saveError = null;
  saveCalls.length = 0;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({
      ok: true,
      access_token: 'xoxb-new-token',
      bot_user_id: 'U_BOT',
      team: { id: WORKSPACE_ID, name: 'KortixDev' },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as any;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const { slackOauthApp, buildSlackInstallUrl } = await import('../channels/slack-oauth');

function stateFromInstallUrl(): string {
  const url = new URL(buildSlackInstallUrl(PROJECT_ID, USER_ID));
  const state = url.searchParams.get('state');
  if (!state) throw new Error('missing state');
  return state;
}

function redirectLocation(res: Response): string {
  const location = res.headers.get('location');
  if (!location) throw new Error('missing redirect location');
  return location;
}

describe('Slack OAuth callback', () => {
  test('saves a project-scoped install and redirects to the project connectors page', async () => {
    const res = await slackOauthApp.request(`/callback?code=code-1&state=${stateFromInstallUrl()}`);

    expect(res.status).toBe(302);
    expect(redirectLocation(res)).toBe(
      `https://dev.kortix.com/projects/${PROJECT_ID}?projectId=${PROJECT_ID}&success=1&customize=connectors`,
    );
    expect(saveCalls).toEqual([{
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      botToken: 'xoxb-new-token',
      botUserId: 'U_BOT',
      teamName: 'KortixDev',
    }]);
  });

  test('redirects instead of returning a raw 500 when reconnect persistence fails', async () => {
    saveError = new Error('duplicate install/schema drift');

    const res = await slackOauthApp.request(`/callback?code=code-2&state=${stateFromInstallUrl()}`);

    expect(res.status).toBe(302);
    expect(redirectLocation(res)).toBe(
      `https://dev.kortix.com/projects/${PROJECT_ID}?projectId=${PROJECT_ID}&error=slack_install_save_failed&customize=connectors`,
    );
    expect(saveCalls).toHaveLength(1);
  });

  test('redirects to the project when Slack token exchange fails unexpectedly', async () => {
    globalThis.fetch = (async () => {
      throw new Error('slack unavailable');
    }) as any;

    const res = await slackOauthApp.request(`/callback?code=code-3&state=${stateFromInstallUrl()}`);

    expect(res.status).toBe(302);
    expect(redirectLocation(res)).toBe(
      `https://dev.kortix.com/projects/${PROJECT_ID}?projectId=${PROJECT_ID}&error=oauth_exchange_failed&customize=connectors`,
    );
    expect(saveCalls).toHaveLength(0);
  });

  test('redirects to the project when Slack rejects the authorization code', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: 'invalid_code' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as any;

    const res = await slackOauthApp.request(`/callback?code=code-4&state=${stateFromInstallUrl()}`);

    expect(res.status).toBe(302);
    expect(redirectLocation(res)).toBe(
      `https://dev.kortix.com/projects/${PROJECT_ID}?projectId=${PROJECT_ID}&error=invalid_code&customize=connectors`,
    );
    expect(saveCalls).toHaveLength(0);
  });
});
