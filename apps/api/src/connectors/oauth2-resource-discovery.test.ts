import { describe, expect, test } from 'bun:test';
import { discoverProtectedResourceOAuth2 } from './oauth2-resource-discovery';

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

function mockFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    return route(url, init);
  };
  return { fetchImpl, calls };
}

const AS_METADATA = {
  issuer: 'https://authn.example.com/',
  authorization_endpoint: 'https://authn.example.com/oauth2/auth',
  token_endpoint: 'https://authn.example.com/oauth2/token',
  device_authorization_endpoint: 'https://authn.example.com/oauth2/device/auth',
  revocation_endpoint: 'https://authn.example.com/oauth2/revoke',
  registration_endpoint: 'https://api.example.com/oauth/register',
  scopes_supported: ['openid', 'offline_access', 'mcp:execute', 'meeting:read'],
  token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
  code_challenge_methods_supported: ['plain', 'S256'],
};

const PRM = {
  resource: 'https://api.example.com/mcp',
  resource_name: 'Example MCP Server',
  authorization_servers: ['https://authn.example.com/'],
  scopes_supported: ['openid', 'offline_access', 'mcp:execute'],
  bearer_methods_supported: ['header'],
};

const unauthorized = (extra = '') =>
  new Response(JSON.stringify({ error: 'invalid_token' }), {
    status: 401,
    headers: {
      'www-authenticate': `Bearer error="invalid_token", resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/mcp"${extra}`,
    },
  });

describe('discoverProtectedResourceOAuth2 — MCP authorization discovery chain', () => {
  test('401 → resource_metadata → PRM → AS metadata → registration endpoint', async () => {
    const { fetchImpl, calls } = mockFetch({
      'https://api.example.com/mcp': () => unauthorized(),
      'https://api.example.com/.well-known/oauth-protected-resource/mcp': () => Response.json(PRM),
      'https://authn.example.com/.well-known/oauth-authorization-server': () =>
        Response.json(AS_METADATA),
    });
    const result = await discoverProtectedResourceOAuth2(
      { resourceUrl: 'https://api.example.com/mcp', provider: 'mcp' },
      { fetchImpl },
    );
    expect(result.requires_authorization).toBe(true);
    expect(result.resource).toBe('https://api.example.com/mcp');
    expect(result.resource_name).toBe('Example MCP Server');
    expect(result.protected_resource_metadata_url).toBe(
      'https://api.example.com/.well-known/oauth-protected-resource/mcp',
    );
    expect(result.authorization_server).toBe('https://authn.example.com/');
    expect(result.metadata).toEqual({
      discovery_url: 'https://authn.example.com/.well-known/oauth-authorization-server',
      authorization_url: 'https://authn.example.com/oauth2/auth',
      token_url: 'https://authn.example.com/oauth2/token',
      device_authorization_url: 'https://authn.example.com/oauth2/device/auth',
      revocation_url: 'https://authn.example.com/oauth2/revoke',
      scopes: ['openid', 'offline_access', 'mcp:execute', 'meeting:read'],
      resource: 'https://api.example.com/mcp',
    });
    expect(result.registration_endpoint).toBe('https://api.example.com/oauth/register');
    // PRM scopes win over the AS-wide list: they are what this resource accepts.
    expect(result.scopes).toEqual(['openid', 'offline_access', 'mcp:execute']);
    expect(result.token_endpoint_auth_methods_supported).toEqual([
      'client_secret_post',
      'client_secret_basic',
      'none',
    ]);
    expect(result.code_challenge_methods_supported).toEqual(['plain', 'S256']);
    expect(result.warnings).toEqual([]);
    // The probe is a real MCP request so the server answers with its challenge.
    expect(calls[0]).toBe('POST https://api.example.com/mcp');
  });

  test('WWW-Authenticate scope narrows the scopes to request', async () => {
    const { fetchImpl } = mockFetch({
      'https://api.example.com/mcp': () => unauthorized(', scope="mcp:execute offline_access"'),
      'https://api.example.com/.well-known/oauth-protected-resource/mcp': () => Response.json(PRM),
      'https://authn.example.com/.well-known/oauth-authorization-server': () =>
        Response.json(AS_METADATA),
    });
    const result = await discoverProtectedResourceOAuth2(
      { resourceUrl: 'https://api.example.com/mcp', provider: 'mcp' },
      { fetchImpl },
    );
    expect(result.scopes).toEqual(['mcp:execute', 'offline_access']);
  });

  test('no resource_metadata hint → well-known PRM with path, then root', async () => {
    const { fetchImpl, calls } = mockFetch({
      'https://api.example.com/mcp': () =>
        new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer' } }),
      'https://api.example.com/.well-known/oauth-protected-resource': () => Response.json(PRM),
      'https://authn.example.com/.well-known/oauth-authorization-server': () =>
        Response.json(AS_METADATA),
    });
    const result = await discoverProtectedResourceOAuth2(
      { resourceUrl: 'https://api.example.com/mcp', provider: 'mcp' },
      { fetchImpl },
    );
    expect(calls).toContain('GET https://api.example.com/.well-known/oauth-protected-resource/mcp');
    expect(result.protected_resource_metadata_url).toBe(
      'https://api.example.com/.well-known/oauth-protected-resource',
    );
    expect(result.authorization_server).toBe('https://authn.example.com/');
  });

  test('issuer with a path tries RFC 8414 path insertion, then OIDC forms', async () => {
    const issuer = 'https://login.example.com/tenant-a';
    const { fetchImpl, calls } = mockFetch({
      'https://api.example.com/mcp': () => unauthorized(),
      'https://api.example.com/.well-known/oauth-protected-resource/mcp': () =>
        Response.json({ ...PRM, authorization_servers: [issuer] }),
      'https://login.example.com/tenant-a/.well-known/openid-configuration': () =>
        Response.json({
          ...AS_METADATA,
          issuer,
          authorization_endpoint: 'https://login.example.com/tenant-a/authorize',
        }),
    });
    const result = await discoverProtectedResourceOAuth2(
      { resourceUrl: 'https://api.example.com/mcp', provider: 'mcp' },
      { fetchImpl },
    );
    expect(calls.slice(2)).toEqual([
      'GET https://login.example.com/.well-known/oauth-authorization-server/tenant-a',
      'GET https://login.example.com/.well-known/openid-configuration/tenant-a',
      'GET https://login.example.com/tenant-a/.well-known/openid-configuration',
    ]);
    expect(result.metadata?.authorization_url).toBe('https://login.example.com/tenant-a/authorize');
    expect(result.metadata?.discovery_url).toBe(
      'https://login.example.com/tenant-a/.well-known/openid-configuration',
    );
  });

  test('server that answers 200 without credentials needs no authorization', async () => {
    const { fetchImpl, calls } = mockFetch({
      'https://api.example.com/mcp': () =>
        Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
    });
    const result = await discoverProtectedResourceOAuth2(
      { resourceUrl: 'https://api.example.com/mcp', provider: 'mcp' },
      { fetchImpl },
    );
    expect(result.requires_authorization).toBe(false);
    expect(result.authorization_server).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  test('no PRM anywhere → legacy AS metadata at the resource origin', async () => {
    const { fetchImpl } = mockFetch({
      'https://api.example.com/mcp': () =>
        new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer' } }),
      'https://api.example.com/.well-known/oauth-authorization-server': () =>
        Response.json({ ...AS_METADATA, issuer: 'https://api.example.com' }),
    });
    const result = await discoverProtectedResourceOAuth2(
      { resourceUrl: 'https://api.example.com/mcp', provider: 'mcp' },
      { fetchImpl },
    );
    expect(result.requires_authorization).toBe(true);
    expect(result.authorization_server).toBe('https://api.example.com');
    expect(result.metadata?.token_url).toBe('https://authn.example.com/oauth2/token');
    // No PRM → the resource indicator is the MCP server URL itself.
    expect(result.resource).toBe('https://api.example.com/mcp');
    expect(result.warnings.some((w) => w.includes('protected resource metadata'))).toBe(true);
  });

  test('nothing discoverable → authorization required, manual setup, warnings', async () => {
    const { fetchImpl } = mockFetch({
      'https://api.example.com/mcp': () =>
        new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer' } }),
    });
    const result = await discoverProtectedResourceOAuth2(
      { resourceUrl: 'https://api.example.com/mcp', provider: 'mcp' },
      { fetchImpl },
    );
    expect(result.requires_authorization).toBe(true);
    expect(result.authorization_server).toBeUndefined();
    expect(result.metadata).toBeUndefined();
    expect(result.registration_endpoint).toBeUndefined();
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test('ignores non-https endpoints advertised by metadata', async () => {
    const { fetchImpl } = mockFetch({
      'https://api.example.com/mcp': () => unauthorized(),
      'https://api.example.com/.well-known/oauth-protected-resource/mcp': () => Response.json(PRM),
      'https://authn.example.com/.well-known/oauth-authorization-server': () =>
        Response.json({
          ...AS_METADATA,
          registration_endpoint: 'http://api.example.com/oauth/register',
          token_endpoint: 'http://authn.example.com/oauth2/token',
        }),
    });
    const result = await discoverProtectedResourceOAuth2(
      { resourceUrl: 'https://api.example.com/mcp', provider: 'mcp' },
      { fetchImpl },
    );
    expect(result.registration_endpoint).toBeUndefined();
    expect(result.metadata?.token_url).toBeUndefined();
  });

  test('http/graphql resources are probed without a JSON-RPC body', async () => {
    const { fetchImpl, calls } = mockFetch({
      'https://api.example.com/v1': () => unauthorized(),
      'https://api.example.com/.well-known/oauth-protected-resource/mcp': () => Response.json(PRM),
      'https://authn.example.com/.well-known/oauth-authorization-server': () =>
        Response.json(AS_METADATA),
    });
    await discoverProtectedResourceOAuth2(
      { resourceUrl: 'https://api.example.com/v1', provider: 'http' },
      { fetchImpl },
    );
    expect(calls[0]).toBe('GET https://api.example.com/v1');
  });
});
