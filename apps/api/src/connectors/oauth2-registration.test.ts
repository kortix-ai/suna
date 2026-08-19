import { describe, expect, test } from 'bun:test';
import {
  registerOAuth2Client,
  selectTokenEndpointAuthMethod,
} from './oauth2-registration';

describe('selectTokenEndpointAuthMethod', () => {
  test('prefers a confidential client when the server allows one', () => {
    expect(selectTokenEndpointAuthMethod(['client_secret_post', 'client_secret_basic', 'none'])).toBe(
      'client_secret_basic',
    );
    expect(selectTokenEndpointAuthMethod(['client_secret_post', 'none'])).toBe('client_secret_post');
    expect(selectTokenEndpointAuthMethod(['none'])).toBe('none');
  });
  test('RFC 8414 default when the server does not say', () => {
    expect(selectTokenEndpointAuthMethod(undefined)).toBe('client_secret_basic');
  });
  test('falls back to none when nothing Kortix supports is offered', () => {
    expect(selectTokenEndpointAuthMethod(['tls_client_auth'])).toBe('none');
  });
});

describe('registerOAuth2Client — RFC 7591 dynamic client registration', () => {
  test('posts a standard registration and returns the issued client', async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const result = await registerOAuth2Client(
      {
        registrationEndpoint: 'https://api.example.com/oauth/register',
        redirectUri: 'https://api.kortix.com/v1/connectors/oauth2/callback',
        scopes: ['openid', 'offline_access', 'mcp:execute'],
        tokenEndpointAuthMethodsSupported: ['client_secret_post', 'client_secret_basic', 'none'],
      },
      {
        fetchImpl: async (url, init) => {
          seen = { url: String(url), init };
          return new Response(
            JSON.stringify({
              client_id: 'issued-client',
              client_secret: 'issued-secret',
              client_secret_expires_at: 0,
              token_endpoint_auth_method: 'client_secret_basic',
              redirect_uris: ['https://api.kortix.com/v1/connectors/oauth2/callback'],
              registration_access_token: 'reg-token',
              registration_client_uri: 'https://authn.example.com/oauth2/register/issued-client',
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          );
        },
      },
    );
    expect(seen!.url).toBe('https://api.example.com/oauth/register');
    expect(seen!.init?.method).toBe('POST');
    const body = JSON.parse(String(seen!.init?.body));
    expect(body).toEqual({
      client_name: 'Kortix',
      client_uri: 'https://kortix.com',
      redirect_uris: ['https://api.kortix.com/v1/connectors/oauth2/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: 'web',
      token_endpoint_auth_method: 'client_secret_basic',
      scope: 'openid offline_access mcp:execute',
    });
    expect(result).toEqual({
      client_id: 'issued-client',
      client_secret: 'issued-secret',
      token_endpoint_auth_method: 'client_secret_basic',
      registration_access_token: 'reg-token',
      registration_client_uri: 'https://authn.example.com/oauth2/register/issued-client',
    });
  });

  test('a loopback callback registers as a native client (SEP-837)', async () => {
    let body: Record<string, unknown> = {};
    await registerOAuth2Client(
      {
        registrationEndpoint: 'https://api.example.com/oauth/register',
        // A self-hosted Kortix on loopback. Registered as `web`, an
        // OIDC-based server rejects the redirect URI outright.
        redirectUri: 'http://localhost:8008/v1/connectors/oauth2/callback',
      },
      {
        fetchImpl: async (_url, init) => {
          body = JSON.parse(String(init?.body));
          return Response.json({ client_id: 'x', client_secret: 'y' });
        },
      },
    );
    expect(body.application_type).toBe('native');
  });

  test('accepts HTTP 200 and a public client (no secret, method none)', async () => {
    const result = await registerOAuth2Client(
      {
        registrationEndpoint: 'https://api.example.com/oauth/register',
        redirectUri: 'https://api.kortix.com/v1/connectors/oauth2/callback',
        tokenEndpointAuthMethodsSupported: ['none'],
      },
      {
        fetchImpl: async () =>
          Response.json({ client_id: 'public-client', token_endpoint_auth_method: 'none' }),
      },
    );
    expect(result).toEqual({ client_id: 'public-client', token_endpoint_auth_method: 'none' });
  });

  test('the server-issued auth method wins; a secret method without a secret is an error', async () => {
    await expect(
      registerOAuth2Client(
        {
          registrationEndpoint: 'https://api.example.com/oauth/register',
          redirectUri: 'https://api.kortix.com/v1/connectors/oauth2/callback',
        },
        {
          fetchImpl: async () =>
            Response.json({ client_id: 'x', token_endpoint_auth_method: 'client_secret_post' }),
        },
      ),
    ).rejects.toThrow('client_secret');
  });

  test('omits scope when none are requested and surfaces the provider error code', async () => {
    let body: Record<string, unknown> = {};
    await expect(
      registerOAuth2Client(
        {
          registrationEndpoint: 'https://api.example.com/oauth/register',
          redirectUri: 'https://api.kortix.com/v1/connectors/oauth2/callback',
        },
        {
          fetchImpl: async (_url, init) => {
            body = JSON.parse(String(init?.body));
            return Response.json(
              { error: 'invalid_redirect_uri', error_description: 'nope <script>' },
              { status: 400 },
            );
          },
        },
      ),
    ).rejects.toThrow('OAuth2 client registration failed (400): invalid_redirect_uri');
    expect('scope' in body).toBe(false);
  });
});
