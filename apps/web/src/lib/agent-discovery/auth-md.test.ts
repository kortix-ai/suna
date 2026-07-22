import { describe, expect, test } from 'bun:test';

import { GET } from '@/app/auth.md/route';
import { OAUTH_ENDPOINTS, OAUTH_TOKEN_RATE_LIMIT_PER_MINUTE } from './endpoints';
import { renderAuthMd } from './auth-md';
import { buildAuthorizationServerMetadata } from './oauth-metadata';

const body = renderAuthMd();

describe('auth.md', () => {
  test('lists every OAuth endpoint the API exposes', () => {
    expect(body).toContain(OAUTH_ENDPOINTS.authorization);
    expect(body).toContain(OAUTH_ENDPOINTS.token);
    expect(body).toContain(OAUTH_ENDPOINTS.userinfo);
  });

  test('states that PKCE is mandatory and S256 is the only method', () => {
    expect(body).toContain('PKCE');
    expect(body).toContain('S256');
  });

  test('is honest that there is no self-service registration', () => {
    expect(body).toContain('no dynamic client registration');
    expect(body).toContain(buildAuthorizationServerMetadata().agent_auth.register_uri);
  });

  test('documents the token endpoint rate limit', () => {
    expect(body).toContain(String(OAUTH_TOKEN_RATE_LIMIT_PER_MINUTE));
  });

  test('links the machine-readable companions', () => {
    expect(body).toContain('/.well-known/oauth-authorization-server');
    expect(body).toContain('/.well-known/oauth-protected-resource');
    expect(body).toContain('/.well-known/api-catalog');
  });

  test('never claims an OIDC capability Kortix does not have', () => {
    expect(body).not.toContain('id_token');
    expect(body).not.toContain('jwks');
  });

  test('the route serves markdown', async () => {
    const response = GET();
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(await response.text()).toBe(body);
  });
});
