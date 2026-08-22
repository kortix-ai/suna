import { describe, expect, test } from 'bun:test';

import { connectorSecretBindingInput, oauth2AuthorizeSteps } from './connectors.ts';

describe('connectorSecretBindingInput', () => {
  test('binds an identifier to a connector slug', () => {
    expect(connectorSecretBindingInput(['github', 'GITHUB_API_KEY'], false)).toEqual({
      slug: 'github',
      secretIdentifier: 'GITHUB_API_KEY',
    });
  });

  test('clears a connector binding without an identifier', () => {
    expect(connectorSecretBindingInput(['github'], true)).toEqual({
      slug: 'github',
      secretIdentifier: null,
    });
  });

  test('rejects missing and ambiguous arguments', () => {
    expect(connectorSecretBindingInput([], false)).toEqual({ error: 'a connector slug' });
    expect(connectorSecretBindingInput(['github'], false)).toEqual({
      error: 'a secret identifier',
    });
    expect(connectorSecretBindingInput(['github', 'GITHUB_API_KEY'], true)).toEqual({
      error: 'Do not pass a secret identifier with --clear.',
    });
  });
});

describe('oauth2AuthorizeSteps', () => {
  const DISCOVERY_WITH_DCR = {
    resource_url: 'https://api.read.ai/mcp',
    requires_authorization: true,
    resource: 'https://api.read.ai/mcp',
    resource_name: 'Read AI MCP Server',
    authorization_server: 'https://authn.read.ai/',
    metadata: {
      discovery_url: 'https://authn.read.ai/.well-known/oauth-authorization-server',
      authorization_url: 'https://authn.read.ai/oauth2/auth',
      token_url: 'https://authn.read.ai/oauth2/token',
      resource: 'https://api.read.ai/mcp',
    },
    registration_endpoint: 'https://api.read.ai/oauth/register',
    token_endpoint_auth_methods_supported: ['client_secret_basic'],
    scopes: ['openid', 'mcp:execute'],
    warnings: [],
  };

  test('a server with dynamic registration needs no operator input', () => {
    expect(oauth2AuthorizeSteps(DISCOVERY_WITH_DCR, {})).toEqual({
      register: {
        registration_endpoint: 'https://api.read.ai/oauth/register',
        issuer: 'https://authn.read.ai/',
        discovery_url: 'https://authn.read.ai/.well-known/oauth-authorization-server',
        authorization_url: 'https://authn.read.ai/oauth2/auth',
        token_url: 'https://authn.read.ai/oauth2/token',
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
        scopes: ['openid', 'mcp:execute'],
        resource: 'https://api.read.ai/mcp',
      },
      scopes: ['openid', 'mcp:execute'],
    });
  });

  test('--scope narrows what the authorization request asks for', () => {
    const steps = oauth2AuthorizeSteps(DISCOVERY_WITH_DCR, { scopes: ['mcp:execute'] });
    expect(steps).toMatchObject({ scopes: ['mcp:execute'] });
    expect((steps as unknown as { register: { scopes: string[] } }).register.scopes).toEqual([
      'mcp:execute',
    ]);
  });

  test('without dynamic registration the caller supplies a client id', () => {
    const { registration_endpoint: _drop, ...noDcr } = DISCOVERY_WITH_DCR;
    expect(oauth2AuthorizeSteps(noDcr, { clientId: 'my-client', clientSecret: 'shh' })).toEqual({
      application: {
        issuer: 'https://authn.read.ai/',
        discovery_url: 'https://authn.read.ai/.well-known/oauth-authorization-server',
        authorization_url: 'https://authn.read.ai/oauth2/auth',
        token_url: 'https://authn.read.ai/oauth2/token',
        client_id: 'my-client',
        client_secret: 'shh',
        token_endpoint_auth_method: 'client_secret_basic',
        scopes: ['openid', 'mcp:execute'],
        resource: 'https://api.read.ai/mcp',
      },
      scopes: ['openid', 'mcp:execute'],
    });
  });

  test('a public client is registered without a secret', () => {
    const { registration_endpoint: _drop, ...noDcr } = DISCOVERY_WITH_DCR;
    const steps = oauth2AuthorizeSteps(
      { ...noDcr, token_endpoint_auth_methods_supported: ['none'] },
      { clientId: 'public-client' },
    );
    expect((steps as unknown as { application: Record<string, unknown> }).application).toMatchObject({
      client_id: 'public-client',
      token_endpoint_auth_method: 'none',
    });
    expect('client_secret' in (steps as unknown as { application: object }).application).toBe(false);
  });

  test('no registration endpoint and no client id is an actionable error', () => {
    const { registration_endpoint: _drop, ...noDcr } = DISCOVERY_WITH_DCR;
    expect(oauth2AuthorizeSteps(noDcr, {})).toEqual({
      error:
        'https://authn.read.ai/ does not support dynamic client registration — pass --client-id (and --client-secret).',
    });
  });

  test('a server that needs no authorization says so instead of registering', () => {
    expect(
      oauth2AuthorizeSteps(
        { resource_url: 'https://open.example.com/mcp', requires_authorization: false, scopes: [], warnings: [] },
        {},
      ),
    ).toEqual({ error: 'This server accepted an unauthenticated request — no OAuth setup needed.' });
  });

  test('an undiscoverable server reports the reason it collected', () => {
    expect(
      oauth2AuthorizeSteps(
        {
          resource_url: 'https://api.example.com/mcp',
          requires_authorization: true,
          scopes: [],
          warnings: ['No authorization server metadata could be discovered.'],
        },
        {},
      ),
    ).toEqual({ error: 'No authorization server metadata could be discovered.' });
  });
});
