import type { OAuth2ResourceDiscovery } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { EMPTY_OAUTH2_APPLICATION_FORM } from './connector-oauth2';
import {
  autoConnectPlan,
  buildClientRegistrationInput,
  mergeResourceDiscoveryIntoForm,
} from './connector-oauth2-auto';

const FULL: OAuth2ResourceDiscovery = {
  resource_url: 'https://api.read.ai/mcp',
  requires_authorization: true,
  resource: 'https://api.read.ai/mcp',
  resource_name: 'Read AI MCP Server',
  protected_resource_metadata_url: 'https://api.read.ai/.well-known/oauth-protected-resource/mcp',
  authorization_server: 'https://authn.read.ai/',
  metadata: {
    discovery_url: 'https://authn.read.ai/.well-known/oauth-authorization-server',
    authorization_url: 'https://authn.read.ai/oauth2/auth',
    token_url: 'https://authn.read.ai/oauth2/token',
    device_authorization_url: 'https://authn.read.ai/oauth2/device/auth',
    revocation_url: 'https://authn.read.ai/oauth2/revoke',
    resource: 'https://api.read.ai/mcp',
  },
  registration_endpoint: 'https://api.read.ai/oauth/register',
  token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
  code_challenge_methods_supported: ['S256'],
  scopes: ['openid', 'offline_access', 'mcp:execute', 'meeting:read'],
  warnings: [],
};

describe('autoConnectPlan', () => {
  test('a fully compliant server is one click, no fields', () => {
    expect(autoConnectPlan(FULL)).toEqual({
      kind: 'register',
      label: 'Connect Read AI MCP Server',
      registrationEndpoint: 'https://api.read.ai/oauth/register',
      scopes: ['openid', 'offline_access', 'mcp:execute', 'meeting:read'],
    });
  });

  test('endpoints but no registration endpoint → the user supplies a client id', () => {
    const { registration_endpoint: _drop, ...rest } = FULL;
    expect(autoConnectPlan(rest)).toEqual({
      kind: 'client_id_required',
      label: 'Connect Read AI MCP Server',
      scopes: FULL.scopes,
    });
  });

  test('a server that needs no authorization is not an OAuth connector', () => {
    expect(
      autoConnectPlan({
        resource_url: 'https://open.example.com/mcp',
        requires_authorization: false,
        scopes: [],
        warnings: [],
      }),
    ).toEqual({ kind: 'no_authorization' });
  });

  test('no discoverable endpoints → manual setup', () => {
    expect(
      autoConnectPlan({
        resource_url: 'https://api.example.com/mcp',
        requires_authorization: true,
        scopes: [],
        warnings: ['No authorization server metadata could be discovered.'],
      }),
    ).toEqual({
      kind: 'manual',
      reason: 'No authorization server metadata could be discovered.',
    });
  });

  test('null discovery (not run yet) is undecided', () => {
    expect(autoConnectPlan(null)).toEqual({ kind: 'unknown' });
  });

  test('a resource without a name falls back to its host', () => {
    const { resource_name: _drop, ...rest } = FULL;
    expect(autoConnectPlan(rest)).toMatchObject({ label: 'Connect api.read.ai' });
  });
});

describe('buildClientRegistrationInput', () => {
  test('carries every discovered endpoint, the scopes, and the resource', () => {
    expect(buildClientRegistrationInput(FULL)).toEqual({
      registration_endpoint: 'https://api.read.ai/oauth/register',
      issuer: 'https://authn.read.ai/',
      discovery_url: 'https://authn.read.ai/.well-known/oauth-authorization-server',
      authorization_url: 'https://authn.read.ai/oauth2/auth',
      token_url: 'https://authn.read.ai/oauth2/token',
      device_authorization_url: 'https://authn.read.ai/oauth2/device/auth',
      revocation_url: 'https://authn.read.ai/oauth2/revoke',
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
      scopes: ['openid', 'offline_access', 'mcp:execute', 'meeting:read'],
      resource: 'https://api.read.ai/mcp',
    });
  });

  test('throws when the server has no registration endpoint', () => {
    const { registration_endpoint: _drop, ...rest } = FULL;
    expect(() => buildClientRegistrationInput(rest)).toThrow('registration');
  });
});

describe('a catalogue app on a Kortix OAuth client (kortix_client)', () => {
  const GMAIL: OAuth2ResourceDiscovery = {
    resource_url: 'https://gmailmcp.googleapis.com/mcp/v1',
    requires_authorization: true,
    resource: 'https://gmailmcp.googleapis.com/mcp/v1',
    authorization_server: 'https://accounts.google.com',
    metadata: {
      authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_url: 'https://oauth2.googleapis.com/token',
    },
    kortix_client: true,
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    warnings: [],
  };

  test('is one click with no registration endpoint', () => {
    expect(autoConnectPlan(GMAIL)).toEqual({
      kind: 'register',
      label: 'Connect gmailmcp.googleapis.com',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    });
  });

  test('registers without a registration endpoint, so the API uses its own client', () => {
    const input = buildClientRegistrationInput(GMAIL);
    expect(input).not.toHaveProperty('registration_endpoint');
    expect(input.token_url).toBe('https://oauth2.googleapis.com/token');
  });
});

describe('mergeResourceDiscoveryIntoForm', () => {
  test('prefills the authorization-code form and never overwrites user input', () => {
    const prefilled = mergeResourceDiscoveryIntoForm(
      { ...EMPTY_OAUTH2_APPLICATION_FORM, grant: 'authorization_code' },
      FULL,
    );
    expect(prefilled).toMatchObject({
      grant: 'authorization_code',
      discoveryUrl: 'https://authn.read.ai/.well-known/oauth-authorization-server',
      authorizationUrl: 'https://authn.read.ai/oauth2/auth',
      tokenUrl: 'https://authn.read.ai/oauth2/token',
      revocationUrl: 'https://authn.read.ai/oauth2/revoke',
      scopes: 'openid offline_access mcp:execute meeting:read',
      resource: 'https://api.read.ai/mcp',
    });
    const edited = mergeResourceDiscoveryIntoForm(
      { ...prefilled, tokenUrl: 'https://my.override/token', scopes: 'openid' },
      FULL,
    );
    expect(edited.tokenUrl).toBe('https://my.override/token');
    expect(edited.scopes).toBe('openid');
  });
});
