import { describe, expect, test } from 'bun:test';
import {
  buildOAuth2AuthorizationRequest,
  discoverOAuth2Metadata,
  exchangeOAuth2AuthorizationCode,
  pollOAuth2DeviceAuthorization,
  refreshOAuth2Token,
  revokeOAuth2Token,
  startOAuth2DeviceAuthorization,
} from './oauth2-lifecycle';

const PUBLIC_APP = {
  authorization_url: 'https://identity.example.com/authorize',
  token_url: 'https://identity.example.com/token',
  device_authorization_url: 'https://identity.example.com/device',
  revocation_url: 'https://identity.example.com/revoke',
  client_id: 'public-client',
  token_endpoint_auth_method: 'none' as const,
  scopes: ['read'],
};

describe('generic OAuth2 lifecycle protocol', () => {
  test('builds Authorization Code with state and mandatory PKCE S256', () => {
    const result = buildOAuth2AuthorizationRequest(PUBLIC_APP, {
      callbackUrl: 'https://api.kortix.test/v1/connectors/oauth2/callback',
      randomBytes: (length) => Buffer.alloc(length, 7),
      now: () => 1_000_000,
    });
    const url = new URL(result.authorizationUrl);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('public-client');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).not.toBe(result.pkceVerifier);
    expect(result.stateHash).toHaveLength(64);
    expect(result.expiresAt).toBe(1_600_000);
  });

  test('exchanges an authorization code with the PKCE verifier', async () => {
    let body = new URLSearchParams();
    const token = await exchangeOAuth2AuthorizationCode(
      PUBLIC_APP,
      {
        code: 'code-123',
        callbackUrl: 'https://api.kortix.test/v1/connectors/oauth2/callback',
        pkceVerifier: 'verifier-123',
      },
      {
        now: () => 1_000_000,
        fetchImpl: async (_url, init) => {
          body = new URLSearchParams(String(init?.body));
          return Response.json({
            access_token: 'access-123',
            refresh_token: 'refresh-123',
            expires_in: 3600,
            scope: 'read write',
          });
        },
      },
    );
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toBe('verifier-123');
    expect(token.refresh_token).toBe('refresh-123');
    expect(token.scopes).toEqual(['read', 'write']);
  });

  test('rotates refresh tokens and preserves the old token when omitted', async () => {
    const rotated = await refreshOAuth2Token(
      PUBLIC_APP,
      'refresh-old',
      { fetchImpl: async () => Response.json({ access_token: 'new', refresh_token: 'refresh-new' }) },
    );
    expect(rotated.refresh_token).toBe('refresh-new');
    const preserved = await refreshOAuth2Token(
      PUBLIC_APP,
      'refresh-old',
      { fetchImpl: async () => Response.json({ access_token: 'new' }) },
    );
    expect(preserved.refresh_token).toBe('refresh-old');
  });

  test('uses client_secret_jwt without putting the secret in the form', async () => {
    let body = new URLSearchParams();
    await refreshOAuth2Token(
      {
        ...PUBLIC_APP,
        client_id: 'confidential',
        token_endpoint_auth_method: 'client_secret_jwt',
        client_secret: 'secret-123',
      },
      'refresh-old',
      {
        now: () => 1_000_000,
        randomId: () => 'jti-1',
        fetchImpl: async (_url, init) => {
          body = new URLSearchParams(String(init?.body));
          return Response.json({ access_token: 'new' });
        },
      },
    );
    expect(body.has('client_secret')).toBe(false);
    expect(body.get('client_assertion_type')).toContain('jwt-bearer');
    expect(body.get('client_assertion')?.split('.')).toHaveLength(3);
  });

  test('starts and polls Device Authorization', async () => {
    const requests: URLSearchParams[] = [];
    const start = await startOAuth2DeviceAuthorization(PUBLIC_APP, {
      fetchImpl: async (_url, init) => {
        requests.push(new URLSearchParams(String(init?.body)));
        return Response.json({
          device_code: 'device-secret',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://identity.example.com/activate',
          expires_in: 900,
          interval: 5,
        });
      },
      now: () => 1_000_000,
    });
    expect(start.deviceCode).toBe('device-secret');
    expect(start.intervalSeconds).toBe(5);

    const pending = await pollOAuth2DeviceAuthorization(PUBLIC_APP, 'device-secret', {
      fetchImpl: async (_url, init) => {
        requests.push(new URLSearchParams(String(init?.body)));
        return Response.json({ error: 'authorization_pending' }, { status: 400 });
      },
    });
    expect(pending).toEqual({ status: 'pending' });
    expect(requests[1]?.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:device_code',
    );
  });

  test('discovers bounded standard metadata', async () => {
    const metadata = await discoverOAuth2Metadata(
      'https://identity.example.com/.well-known/oauth-authorization-server',
      {
        fetchImpl: async () =>
          Response.json({
            authorization_endpoint: 'https://identity.example.com/authorize',
            token_endpoint: 'https://identity.example.com/token',
            revocation_endpoint: 'https://identity.example.com/revoke',
            device_authorization_endpoint: 'https://identity.example.com/device',
            scopes_supported: ['read'],
          }),
      },
    );
    expect(metadata.token_url).toBe('https://identity.example.com/token');
    expect(metadata.scopes).toEqual(['read']);
  });

  test('revokes a token with the configured client authentication', async () => {
    let body = new URLSearchParams();
    await revokeOAuth2Token(PUBLIC_APP, 'refresh-123', 'refresh_token', {
      fetchImpl: async (_url, init) => {
        body = new URLSearchParams(String(init?.body));
        return new Response(null, { status: 200 });
      },
    });
    expect(body.get('token')).toBe('refresh-123');
    expect(body.get('token_type_hint')).toBe('refresh_token');
  });

  test('does not expose provider error descriptions', async () => {
    await expect(
      refreshOAuth2Token(PUBLIC_APP, 'refresh-secret', {
        fetchImpl: async () =>
          Response.json(
            { error: 'invalid_grant', error_description: 'refresh-secret was rejected' },
            { status: 400 },
          ),
      }),
    ).rejects.toThrow('OAuth2 token request failed (400): invalid_grant');
  });
});

describe('RFC 8707 resource indicator', () => {
  test('authorization request carries the resource when configured', () => {
    const result = buildOAuth2AuthorizationRequest(
      { ...PUBLIC_APP, resource: 'https://mcp.example.com/mcp' },
      { callbackUrl: 'https://api.kortix.test/v1/connectors/oauth2/callback' },
    );
    const url = new URL(result.authorizationUrl);
    expect(url.searchParams.get('resource')).toBe('https://mcp.example.com/mcp');
  });

  test('authorization request omits resource when not configured', () => {
    const result = buildOAuth2AuthorizationRequest(PUBLIC_APP, {
      callbackUrl: 'https://api.kortix.test/v1/connectors/oauth2/callback',
    });
    expect(new URL(result.authorizationUrl).searchParams.has('resource')).toBe(false);
  });
});
