import { describe, expect, test } from 'bun:test';

import { GET as getAuthorizationServer } from '@/app/(public)/well-known/oauth-authorization-server/route';
import { GET as getProtectedResource } from '@/app/(public)/well-known/oauth-protected-resource/route';
import { API_BASE, OAUTH_ISSUER } from './endpoints';
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
} from './oauth-metadata';

describe('authorization server metadata', () => {
  test('carries every field RFC 8414 requires', () => {
    const metadata = buildAuthorizationServerMetadata();
    expect(metadata.issuer).toBe(OAUTH_ISSUER);
    expect(metadata.authorization_endpoint).toBe(
      'https://api.kortix.com/v1/oauth/authorize',
    );
    expect(metadata.token_endpoint).toBe('https://api.kortix.com/v1/oauth/token');
    expect(metadata.response_types_supported).toEqual(['code']);
  });

  test('describes the flow apps/api actually implements', () => {
    const metadata = buildAuthorizationServerMetadata();
    expect(metadata.grant_types_supported).toEqual([
      'authorization_code',
      'refresh_token',
    ]);
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
    expect(metadata.token_endpoint_auth_methods_supported).toEqual([
      'client_secret_post',
    ]);
    expect(metadata.scopes_supported).toEqual(['profile']);
  });

  test('claims no OIDC capability, because Kortix issues opaque tokens', () => {
    const metadata = buildAuthorizationServerMetadata() as Record<string, unknown>;
    expect(metadata.jwks_uri).toBeUndefined();
    expect(metadata.id_token_signing_alg_values_supported).toBeUndefined();
    expect(metadata.subject_types_supported).toBeUndefined();
  });

  test('points agents at a real place to request credentials', () => {
    // There is no dynamic client registration endpoint in apps/api, so
    // register_uri must be the human request path, not an invented /register.
    const { agent_auth: agentAuth } = buildAuthorizationServerMetadata();
    expect(agentAuth.register_uri).toBe('https://kortix.com/contact');
    expect(agentAuth.credential_types).toEqual(['client_secret']);
  });

  test('never advertises an identity this grant cannot mint', () => {
    // grant_types_supported has no client_credentials grant, so a
    // service_account identity here would send an agent into a 400
    // unsupported_grant_type. Every token this flow issues traces back to a
    // delegated end user instead.
    const { agent_auth: agentAuth, grant_types_supported: grantTypes } =
      buildAuthorizationServerMetadata();
    expect(agentAuth.identity_types).toEqual(['user']);
    expect(grantTypes).not.toContain('client_credentials');
  });

  test('the metadata document location derives from the issuer', () => {
    // RFC 8414 §3: issuer https://kortix.com => metadata at
    // https://kortix.com/.well-known/oauth-authorization-server.
    expect(OAUTH_ISSUER).toBe('https://kortix.com');
  });
});

describe('protected resource metadata', () => {
  test('names the resource and the authorization server that guards it', () => {
    const metadata = buildProtectedResourceMetadata();
    expect(metadata.resource).toBe(API_BASE);
    expect(metadata.authorization_servers).toEqual([OAUTH_ISSUER]);
  });

  test('declares bearer tokens in the Authorization header', () => {
    expect(buildProtectedResourceMetadata().bearer_methods_supported).toEqual([
      'header',
    ]);
  });

  test('advertises the same scopes as the authorization server', () => {
    expect(buildProtectedResourceMetadata().scopes_supported).toEqual(
      buildAuthorizationServerMetadata().scopes_supported,
    );
  });
});

describe('routes', () => {
  test('both serve application/json', async () => {
    const as = getAuthorizationServer();
    const pr = getProtectedResource();
    expect(as.headers.get('content-type')).toBe('application/json');
    expect(pr.headers.get('content-type')).toBe('application/json');
    expect(await as.json()).toEqual(buildAuthorizationServerMetadata());
    expect(await pr.json()).toEqual(buildProtectedResourceMetadata());
  });
});
