import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('../config', () => ({
  config: {
    MICROSOFT_APP_ID: 'app-id',
    MICROSOFT_APP_PASSWORD: 'app-secret',
    MICROSOFT_APP_TENANT: 'botframework.com',
  },
}));

const {
  BOT_CONNECTOR_SCOPE,
  GRAPH_SCOPE,
  botConnectorToken,
  clearTeamsTokenCache,
  graphToken,
  mintTeamsToken,
  teamsConfigured,
} = await import('../channels/teams-auth');

interface FetchCall {
  url: string;
  body: string;
}

let calls: FetchCall[] = [];
let nextStatus = 200;
let nextBody = JSON.stringify({ access_token: 'tok-1', expires_in: 3600 });
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  nextStatus = 200;
  nextBody = JSON.stringify({ access_token: 'tok-1', expires_in: 3600 });
  clearTeamsTokenCache();
  globalThis.fetch = (async (url: string, init: { body?: string }) => {
    calls.push({ url: String(url), body: init?.body ?? '' });
    return {
      ok: nextStatus >= 200 && nextStatus < 300,
      status: nextStatus,
      text: async () => nextBody,
    };
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('teamsConfigured', () => {
  test('true when app id + password set', () => {
    expect(teamsConfigured()).toBe(true);
  });
});

describe('mintTeamsToken', () => {
  test('posts client-credentials to the tenant token endpoint and returns the token', async () => {
    const tok = await mintTeamsToken({ scope: BOT_CONNECTOR_SCOPE });
    expect(tok).toBe('tok-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token');
    expect(calls[0]!.body).toContain('grant_type=client_credentials');
    expect(calls[0]!.body).toContain('client_id=app-id');
    expect(calls[0]!.body).toContain(encodeURIComponent(BOT_CONNECTOR_SCOPE));
  });

  test('caches per (tenant, scope) — second call does not re-fetch', async () => {
    await mintTeamsToken({ scope: BOT_CONNECTOR_SCOPE });
    await mintTeamsToken({ scope: BOT_CONNECTOR_SCOPE });
    expect(calls).toHaveLength(1);
  });

  test('different scope is a distinct cache entry', async () => {
    await mintTeamsToken({ scope: BOT_CONNECTOR_SCOPE });
    await mintTeamsToken({ scope: GRAPH_SCOPE, tenantId: 'contoso.onmicrosoft.com' });
    expect(calls).toHaveLength(2);
  });

  test('throws a clear error on a non-2xx response', async () => {
    nextStatus = 401;
    nextBody = JSON.stringify({ error: 'invalid_client' });
    await expect(mintTeamsToken({ scope: BOT_CONNECTOR_SCOPE })).rejects.toThrow(/401/);
  });

  test('throws when the response has no access_token', async () => {
    nextBody = JSON.stringify({ expires_in: 3600 });
    await expect(mintTeamsToken({ scope: BOT_CONNECTOR_SCOPE })).rejects.toThrow(/access_token/);
  });
});

describe('scoped helpers', () => {
  test('botConnectorToken uses the bot-framework scope against the home tenant', async () => {
    await botConnectorToken();
    expect(calls[0]!.url).toContain('/botframework.com/');
    expect(calls[0]!.body).toContain(encodeURIComponent(BOT_CONNECTOR_SCOPE));
  });

  test('graphToken uses the graph scope against the customer tenant', async () => {
    await graphToken('contoso.onmicrosoft.com');
    expect(calls[0]!.url).toContain('/contoso.onmicrosoft.com/');
    expect(calls[0]!.body).toContain(encodeURIComponent(GRAPH_SCOPE));
  });
});
