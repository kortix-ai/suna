import { describe, expect, test } from 'bun:test';
import { constants, generateKeyPairSync, verify } from 'node:crypto';
import {
  acquireOAuth2ClientCredentialsToken,
  buildPrivateKeyClientAssertion,
  createStoredOAuth2Credential,
  oauth2TokenIsFresh,
  resolveStoredOAuth2Credential,
} from './oauth2';

const SECRET_CONFIG = {
  type: 'oauth2_client_credentials' as const,
  token_url: 'https://login.example.com/oauth2/v2.0/token',
  client_id: 'client-123',
  token_endpoint_auth_method: 'client_secret_post' as const,
  client_secret: 'secret-123',
  scopes: ['https://graph.example.com/.default'],
  resource: 'https://sharepoint.example.com',
  audience: 'https://api.example.com',
};

describe('OAuth2 client credentials', () => {
  test('posts a client secret and normalizes the token expiry', async () => {
    const request: { current: { url: string; init: RequestInit } | null } = { current: null };
    const token = await acquireOAuth2ClientCredentialsToken(SECRET_CONFIG, {
      now: () => 1_000_000,
      fetchImpl: async (url, init) => {
        request.current = { url: String(url), init: init ?? {} };
        return new Response(
          JSON.stringify({
            access_token: 'access-123',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'one two',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    expect(request.current?.url).toBe(SECRET_CONFIG.token_url);
    expect(request.current?.init.method).toBe('POST');
    expect(new URLSearchParams(String(request.current?.init.body))).toEqual(
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: 'client-123',
        client_secret: 'secret-123',
        scope: 'https://graph.example.com/.default',
        resource: 'https://sharepoint.example.com',
        audience: 'https://api.example.com',
      }),
    );
    expect(token).toEqual({
      access_token: 'access-123',
      token_type: 'Bearer',
      expires_at: 4_600_000,
      scopes: ['one', 'two'],
    });
  });

  test('uses HTTP Basic without placing the secret in the form', async () => {
    const request: { current: RequestInit | null } = { current: null };
    await acquireOAuth2ClientCredentialsToken(
      { ...SECRET_CONFIG, token_endpoint_auth_method: 'client_secret_basic' },
      {
        fetchImpl: async (_url, init) => {
          request.current = init ?? {};
          return Response.json({ access_token: 'access-123', expires_in: 3600 });
        },
      },
    );

    expect(new Headers(request.current?.headers).get('authorization')).toBe(
      `Basic ${Buffer.from('client-123:secret-123').toString('base64')}`,
    );
    expect(new URLSearchParams(String(request.current?.body)).has('client_secret')).toBe(false);
  });

  test('supports public clients and client_secret_jwt', async () => {
    let publicBody = new URLSearchParams();
    await acquireOAuth2ClientCredentialsToken(
      {
        ...SECRET_CONFIG,
        token_endpoint_auth_method: 'none',
        client_secret: undefined,
      },
      {
        fetchImpl: async (_url, init) => {
          publicBody = new URLSearchParams(String(init?.body));
          return Response.json({ access_token: 'public-access' });
        },
      },
    );
    expect(publicBody.get('client_id')).toBe('client-123');
    expect(publicBody.has('client_secret')).toBe(false);

    let jwtBody = new URLSearchParams();
    await acquireOAuth2ClientCredentialsToken(
      { ...SECRET_CONFIG, token_endpoint_auth_method: 'client_secret_jwt' },
      {
        now: () => 1_000_000,
        randomId: () => 'jwt-id',
        fetchImpl: async (_url, init) => {
          jwtBody = new URLSearchParams(String(init?.body));
          return Response.json({ access_token: 'jwt-access' });
        },
      },
    );
    expect(jwtBody.has('client_secret')).toBe(false);
    expect(jwtBody.get('client_assertion_type')).toContain('jwt-bearer');
    expect(jwtBody.get('client_assertion')?.split('.')).toHaveLength(3);
  });

  test('creates a PS256 private-key client assertion with the certificate thumbprint', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const assertion = await buildPrivateKeyClientAssertion(
      {
        ...SECRET_CONFIG,
        token_endpoint_auth_method: 'private_key_jwt',
        client_secret: undefined,
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        certificate_thumbprint: 'thumbprint-123',
      },
      { now: () => 1_000_000, randomId: () => 'assertion-id' },
    );
    const [encodedHeader, encodedPayload, signature] = assertion.split('.');
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString());

    expect(header).toEqual({ alg: 'PS256', typ: 'JWT', 'x5t#S256': 'thumbprint-123' });
    expect(payload).toEqual({
      aud: SECRET_CONFIG.token_url,
      iss: 'client-123',
      sub: 'client-123',
      jti: 'assertion-id',
      nbf: 940,
      exp: 1600,
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        {
          key: publicKey,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
        },
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
  });

  test('refreshes tokens inside the 60 second expiry window', () => {
    expect(oauth2TokenIsFresh({ expires_at: 1_061_000 }, 1_000_000)).toBe(true);
    expect(oauth2TokenIsFresh({ expires_at: 1_060_000 }, 1_000_000)).toBe(false);
  });

  test('reuses a fresh encrypted credential token without another token request', async () => {
    const stored = createStoredOAuth2Credential(SECRET_CONFIG, {
      access_token: 'cached-access',
      token_type: 'Bearer',
      expires_at: 1_061_000,
      scopes: [],
    });
    let acquisitions = 0;
    const resolved = await resolveStoredOAuth2Credential(stored, {
      now: () => 1_000_000,
      acquire: async () => {
        acquisitions += 1;
        throw new Error('not expected');
      },
    });

    expect(resolved.accessToken).toBe('cached-access');
    expect(resolved.updatedValue).toBeNull();
    expect(acquisitions).toBe(0);
  });

  test('refreshes an expired encrypted credential token and returns the replacement value', async () => {
    const stored = createStoredOAuth2Credential(SECRET_CONFIG, {
      access_token: 'expired-access',
      token_type: 'Bearer',
      expires_at: 1_060_000,
      scopes: [],
    });
    const resolved = await resolveStoredOAuth2Credential(stored, {
      now: () => 1_000_000,
      acquire: async () => ({
        access_token: 'fresh-access',
        token_type: 'Bearer',
        expires_at: 4_600_000,
        scopes: ['one'],
      }),
    });

    expect(resolved.accessToken).toBe('fresh-access');
    expect(resolved.updatedValue).toContain('"kind":"oauth2_client_credentials"');
    expect(
      await resolveStoredOAuth2Credential(resolved.updatedValue!, {
        now: () => 1_000_000,
        acquire: async () => {
          throw new Error('not expected');
        },
      }),
    ).toMatchObject({ accessToken: 'fresh-access', updatedValue: null });
  });

  test('returns the upstream OAuth error without exposing the client secret', async () => {
    await expect(
      acquireOAuth2ClientCredentialsToken(SECRET_CONFIG, {
        fetchImpl: async () =>
          Response.json(
            { error: 'invalid_client', error_description: 'secret-123 is invalid' },
            { status: 401 },
          ),
      }),
    ).rejects.toThrow('OAuth2 token request failed (401): invalid_client');
  });
});
