import { describe, expect, test } from 'bun:test';
import { constants, generateKeyPairSync, verify } from 'node:crypto';
import {
  acquireOAuth2ClientCredentialsToken,
  createStoredOAuth2Credential,
  oauth2TokenIsFresh,
  resolveStoredOAuth2Credential,
} from './oauth2';

const SECRET_CONFIG = {
  type: 'oauth2_client_credentials' as const,
  token_url: 'https://identity.example.com/oauth2/token',
  client_id: 'client-123',
  token_endpoint_auth_method: 'client_secret_post' as const,
  client_secret: 'secret-123',
  scopes: ['records.read'],
  resource: 'https://resource.example.com',
  audience: 'https://api.example.com',
  token_params: { tenant_hint: 'tenant-123' },
};

describe('OAuth2 client credentials', () => {
  test('posts a client secret and normalizes the token expiry', async () => {
    const request: { current: { url: string; init: RequestInit } | null } = {
      current: null,
    };
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
        scope: 'records.read',
        resource: 'https://resource.example.com',
        audience: 'https://api.example.com',
        tenant_hint: 'tenant-123',
      }),
    );
    expect(token).toEqual({
      access_token: 'access-123',
      token_type: 'Bearer',
      expires_at: 4_600_000,
      scopes: ['one', 'two'],
    });
  });

  test('uses client_secret_basic with form-encoded credentials and no body credential', async () => {
    const request: { current: RequestInit | null } = { current: null };
    await acquireOAuth2ClientCredentialsToken(
      {
        ...SECRET_CONFIG,
        client_id: 'client id:one',
        client_secret: 'secret+value two',
        token_endpoint_auth_method: 'client_secret_basic',
      },
      {
        fetchImpl: async (_url, init) => {
          request.current = init ?? {};
          return Response.json({
            access_token: 'access-123',
            expires_in: 3600,
          });
        },
      },
    );

    expect(new Headers(request.current?.headers).get('authorization')).toBe(
      `Basic ${Buffer.from('client+id%3Aone:secret%2Bvalue+two').toString('base64')}`,
    );
    const body = new URLSearchParams(String(request.current?.body));
    expect(body.has('client_id')).toBe(false);
    expect(body.has('client_secret')).toBe(false);
    expect(body.get('tenant_hint')).toBe('tenant-123');
  });

  test('uses none for a public client without any client authentication', async () => {
    let publicBody = new URLSearchParams();
    let publicHeaders = new Headers();
    await acquireOAuth2ClientCredentialsToken(
      {
        ...SECRET_CONFIG,
        token_endpoint_auth_method: 'none',
        client_secret: undefined,
      },
      {
        fetchImpl: async (_url, init) => {
          publicBody = new URLSearchParams(String(init?.body));
          publicHeaders = new Headers(init?.headers);
          return Response.json({ access_token: 'public-access' });
        },
      },
    );
    expect(publicBody.get('client_id')).toBe('client-123');
    expect(publicBody.has('client_secret')).toBe(false);
    expect(publicBody.has('client_assertion')).toBe(false);
    expect(publicBody.get('tenant_hint')).toBe('tenant-123');
    expect(publicHeaders.get('authorization')).toBeNull();
  });

  test('uses client_secret_jwt with an HS256 assertion and no raw secret', async () => {
    let jwtBody = new URLSearchParams();
    await acquireOAuth2ClientCredentialsToken(
      { ...SECRET_CONFIG, token_endpoint_auth_method: 'client_secret_jwt' },
      {
        fetchImpl: async (_url, init) => {
          jwtBody = new URLSearchParams(String(init?.body));
          return Response.json({ access_token: 'jwt-access' });
        },
      },
    );
    expect(jwtBody.has('client_secret')).toBe(false);
    expect(jwtBody.get('client_id')).toBe('client-123');
    expect(jwtBody.get('tenant_hint')).toBe('tenant-123');
    expect(jwtBody.get('client_assertion_type')).toContain('jwt-bearer');
    const assertion = jwtBody.get('client_assertion');
    if (!assertion) throw new Error('expected client_secret_jwt assertion');
    const [encodedHeader, encodedPayload] = assertion.split('.');
    expect(JSON.parse(Buffer.from(encodedHeader, 'base64url').toString())).toEqual({
      alg: 'HS256',
      typ: 'JWT',
    });
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString());
    expect(payload).toMatchObject({
      aud: SECRET_CONFIG.token_url,
      iss: 'client-123',
      sub: 'client-123',
    });
    expect(typeof payload.jti).toBe('string');
    expect(payload.nbf).toBe(payload.iat);
    expect(payload.exp - payload.iat).toBe(60);
    expect(assertion.split('.')).toHaveLength(3);
  });

  test('uses private_key_jwt in an actual token request with no shared secret', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    let requestBody = new URLSearchParams();
    let requestHeaders = new Headers();
    await acquireOAuth2ClientCredentialsToken(
      {
        ...SECRET_CONFIG,
        token_endpoint_auth_method: 'private_key_jwt',
        client_secret: undefined,
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        certificate_thumbprint: 'thumbprint-123',
      },
      {
        fetchImpl: async (_url, init) => {
          requestBody = new URLSearchParams(String(init?.body));
          requestHeaders = new Headers(init?.headers);
          return Response.json({ access_token: 'private-key-access' });
        },
      },
    );

    expect(requestHeaders.get('authorization')).toBeNull();
    expect(requestBody.get('client_id')).toBe('client-123');
    expect(requestBody.has('client_secret')).toBe(false);
    expect(requestBody.get('tenant_hint')).toBe('tenant-123');
    expect(requestBody.get('client_assertion_type')).toContain('jwt-bearer');
    const assertion = requestBody.get('client_assertion');
    if (!assertion) throw new Error('expected private_key_jwt assertion');
    const [encodedHeader, encodedPayload, signature] = assertion.split('.');
    expect(JSON.parse(Buffer.from(encodedHeader, 'base64url').toString())).toEqual({
      alg: 'PS256',
      typ: 'JWT',
      'x5t#S256': 'thumbprint-123',
    });
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString());
    expect(payload).toMatchObject({
      aud: SECRET_CONFIG.token_url,
      iss: 'client-123',
      sub: 'client-123',
    });
    expect(typeof payload.jti).toBe('string');
    expect(payload.nbf).toBe(payload.iat);
    expect(payload.exp - payload.iat).toBe(60);
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

  test('uses private_key_jwt without an optional certificate thumbprint', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    let requestBody = new URLSearchParams();
    await acquireOAuth2ClientCredentialsToken(
      {
        ...SECRET_CONFIG,
        token_endpoint_auth_method: 'private_key_jwt',
        client_secret: undefined,
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        certificate_thumbprint: undefined,
      },
      {
        fetchImpl: async (_url, init) => {
          requestBody = new URLSearchParams(String(init?.body));
          return Response.json({ access_token: 'private-key-access' });
        },
      },
    );

    const assertion = requestBody.get('client_assertion');
    if (!assertion) throw new Error('expected private_key_jwt assertion');
    const [encodedHeader, encodedPayload, signature] = assertion.split('.');
    expect(JSON.parse(Buffer.from(encodedHeader, 'base64url').toString())).toEqual({
      alg: 'PS256',
      typ: 'JWT',
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

  test('defensively ignores protocol-owned token_params from legacy stored input', async () => {
    let body = new URLSearchParams();
    await acquireOAuth2ClientCredentialsToken(
      {
        ...SECRET_CONFIG,
        token_params: {
          tenant_hint: 'tenant-123',
          grant_type: 'password',
          client_id: 'attacker-client',
          client_secret: 'attacker-secret',
          scope: 'attacker-scope',
          resource: 'https://attacker.example.com',
          audience: 'https://attacker.example.com',
          client_assertion: 'attacker-assertion',
          client_assertion_type: 'attacker-type',
        },
      },
      {
        fetchImpl: async (_url, init) => {
          body = new URLSearchParams(String(init?.body));
          return Response.json({ access_token: 'access-123' });
        },
      },
    );

    expect(Object.fromEntries(body)).toEqual({
      tenant_hint: 'tenant-123',
      grant_type: 'client_credentials',
      scope: 'records.read',
      resource: 'https://resource.example.com',
      audience: 'https://api.example.com',
      client_id: 'client-123',
      client_secret: 'secret-123',
    });
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
    if (!resolved.updatedValue) throw new Error('expected refreshed stored credential');
    expect(JSON.parse(resolved.updatedValue).config.token_params).toEqual({
      tenant_hint: 'tenant-123',
    });
    expect(
      await resolveStoredOAuth2Credential(resolved.updatedValue, {
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
            {
              error: 'invalid_client',
              error_description: 'secret-123 is invalid',
            },
            { status: 401 },
          ),
      }),
    ).rejects.toThrow('OAuth2 token request failed (401): invalid_client');
  });
});
