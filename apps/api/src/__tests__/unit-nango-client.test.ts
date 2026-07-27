import { describe, expect, test } from 'bun:test';
import { createNangoClient } from '../projects/nango/client';
import { NangoError } from '../projects/nango/errors';

const apiKey = 'nango-api-key-do-not-log';
const baseUrl = 'https://nango.example.test';

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

const sessionResponse = {
  data: {
    token: 'connect-session-token',
    expires_at: '2026-07-27T18:00:00.000Z',
    connect_link: 'https://connect.nango.dev/session',
  },
};

const connectionResponse = {
  id: 42,
  connection_id: 'connection-1',
  provider_config_key: 'github-account',
  provider: 'github-app-oauth',
  errors: [],
  metadata: {},
  connection_config: { installation_id: '1234' },
  tags: { kortix_account_id: 'account-1' },
  created_at: '2026-07-27T17:00:00.000Z',
  updated_at: '2026-07-27T17:01:00.000Z',
  last_fetched_at: '2026-07-27T17:02:00.000Z',
  credentials: {
    type: 'CUSTOM',
    app: {
      type: 'APP',
      access_token: 'installation-token',
      raw: {},
    },
    user: {
      type: 'OAUTH2',
      access_token: 'user-token',
      raw: {},
    },
    raw: {},
  },
};

describe('Nango HTTP client', () => {
  test('creates a scoped Connect session with server-owned tags and a webhook override', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createNangoClient({
      apiKey,
      baseUrl,
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return jsonResponse(sessionResponse, { status: 201 });
      },
    });

    const result = await client.createConnectSession({
      integrationId: 'github-account',
      tags: {
        kortix_account_id: 'account-1',
        kortix_user_id: 'user-1',
        kortix_purpose: 'account',
        kortix_display_name: 'Acme',
        kortix_connect_attempt_id: 'attempt-1',
      },
      webhookUrlOverride: 'https://tunnel.example.test/v1/webhooks/nango',
    });

    expect(result).toEqual({
      token: 'connect-session-token',
      expiresAt: '2026-07-27T18:00:00.000Z',
      connectLink: 'https://connect.nango.dev/session',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${baseUrl}/connect/sessions`);
    expect(calls[0]?.init.method).toBe('POST');
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe(`Bearer ${apiKey}`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      allowed_integrations: ['github-account'],
      tags: {
        kortix_account_id: 'account-1',
        kortix_user_id: 'user-1',
        kortix_purpose: 'account',
        kortix_display_name: 'Acme',
        kortix_connect_attempt_id: 'attempt-1',
      },
      webhook_url_override: 'https://tunnel.example.test/v1/webhooks/nango',
    });
  });

  test('creates a reconnect session for the same connection ID', async () => {
    const bodies: unknown[] = [];
    const client = createNangoClient({
      apiKey,
      baseUrl,
      fetchImpl: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse(sessionResponse, { status: 201 });
      },
    });

    await client.createReconnectSession({
      connectionId: 'connection-existing',
      integrationId: 'github-account',
      tags: { kortix_account_id: 'account-1' },
    });

    expect(bodies).toEqual([
      {
        connection_id: 'connection-existing',
        integration_id: 'github-account',
        tags: { kortix_account_id: 'account-1' },
      },
    ]);
  });

  test('lists connection metadata without requesting credentials', async () => {
    const urls: string[] = [];
    const client = createNangoClient({
      apiKey,
      baseUrl,
      fetchImpl: async (input) => {
        urls.push(String(input));
        return jsonResponse({ connections: [connectionResponse] });
      },
    });

    const result = await client.listConnections({
      connectionId: 'connection-1',
      integrationId: 'github-account',
      tags: { kortix_account_id: 'account-1' },
      limit: 1,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.connectionId).toBe('connection-1');
    expect(result[0]).not.toHaveProperty('credentials');
    const listedUrl = urls.at(0);
    if (!listedUrl) throw new Error('Expected one Nango list request.');
    const url = new URL(listedUrl);
    expect(url.pathname).toBe('/connections');
    expect(url.searchParams.get('connectionId')).toBe('connection-1');
    expect(url.searchParams.get('integrationId')).toBe('github-account');
    expect(url.searchParams.get('tags[kortix_account_id]')).toBe('account-1');
    expect(url.searchParams.get('limit')).toBe('1');
  });

  test('gets fresh credentials and deletes a connection', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const client = createNangoClient({
      apiKey,
      baseUrl,
      fetchImpl: async (input, init) => {
        const method = init?.method ?? 'GET';
        calls.push({ url: String(input), method });
        return method === 'DELETE'
          ? jsonResponse({ success: true })
          : jsonResponse(connectionResponse);
      },
    });

    const connection = await client.getConnection({
      connectionId: 'connection-1',
      integrationId: 'github-account',
      refreshGithubAppJwtToken: true,
    });
    await client.deleteConnection({
      connectionId: 'connection-1',
      integrationId: 'github-account',
    });

    expect(connection.connectionId).toBe('connection-1');
    expect(connection.credentials).toEqual(connectionResponse.credentials);
    expect(calls).toEqual([
      {
        url: `${baseUrl}/connections/connection-1?provider_config_key=github-account&refresh_github_app_jwt_token=true`,
        method: 'GET',
      },
      {
        url: `${baseUrl}/connections/connection-1?provider_config_key=github-account`,
        method: 'DELETE',
      },
    ]);
  });

  test('maps timeout and network failures to nango_unavailable without secret data', async () => {
    const secretResponse = 'installation-token-that-must-not-escape';
    const client = createNangoClient({
      apiKey,
      baseUrl,
      timeoutMs: 5,
      fetchImpl: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException(secretResponse, 'AbortError'));
          });
        }),
    });

    let error: unknown;
    try {
      await client.getConnection({
        connectionId: 'connection-1',
        integrationId: 'github-account',
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(NangoError);
    expect(error).toMatchObject({ code: 'nango_unavailable', status: 503 });
    expect(String(error)).not.toContain(apiKey);
    expect(String(error)).not.toContain(secretResponse);
  });

  test('preserves Retry-After on a Nango 429 response', async () => {
    const client = createNangoClient({
      apiKey,
      baseUrl,
      fetchImpl: async () =>
        jsonResponse(
          { error: { message: 'rate limit body must stay private' } },
          { status: 429, headers: { 'retry-after': '17' } },
        ),
    });

    await expect(client.listConnections({ integrationId: 'github-account' })).rejects.toMatchObject(
      {
        code: 'github_provider_rate_limited',
        status: 429,
        retryAfter: '17',
        upstreamStatus: 429,
      },
    );
  });

  test('maps a missing or invalid stored connection to github_reconnect_required', async () => {
    for (const status of [404, 424]) {
      const client = createNangoClient({
        apiKey,
        baseUrl,
        fetchImpl: async () => jsonResponse({ error: 'private' }, { status }),
      });

      await expect(
        client.getConnection({
          connectionId: 'connection-1',
          integrationId: 'github-account',
        }),
      ).rejects.toMatchObject({
        code: 'github_reconnect_required',
        status: 409,
        upstreamStatus: status,
      });
    }
  });

  test('rejects malformed success responses without including the raw payload', async () => {
    const secretPayload = 'ghu_secret_user_token';
    const client = createNangoClient({
      apiKey,
      baseUrl,
      fetchImpl: async () => jsonResponse({ credentials: { access_token: secretPayload } }),
    });

    let error: unknown;
    try {
      await client.getConnection({
        connectionId: 'connection-1',
        integrationId: 'github-account',
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code: 'github_provider_failed', status: 502 });
    expect(String(error)).not.toContain(apiKey);
    expect(String(error)).not.toContain(secretPayload);
  });
});
