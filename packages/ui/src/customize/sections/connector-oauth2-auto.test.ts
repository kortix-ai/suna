import type { OAuth2ResourceDiscovery } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { EMPTY_OAUTH2_APPLICATION_FORM } from './connector-oauth2';
import { mergeResourceDiscoveryIntoForm } from './connector-oauth2-auto';

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
