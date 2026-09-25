import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// No real DNS: every host resolves from this table.
let dnsResults: Record<string, Array<{ address: string; family: number }>> = {};
mock.module('node:dns/promises', () => ({
  lookup: async (host: string) => dnsResults[host] ?? [],
}));

const { assertConnectorEndpointUrl, createConnectorEgressFetch } = await import('./egress');
const { resolveCatalog } = await import('./sync');
import type { ConnectorSpec } from '../projects/connectors';
import type { GitBackedProject } from '../projects/git';

let fetchCalls: string[] = [];
let responses: Array<{ status: number; headers?: Record<string, string>; body?: string }> = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  dnsResults = { 'api.example.com': [{ address: '93.184.216.34', family: 4 }] };
  fetchCalls = [];
  responses = [];
  globalThis.fetch = (async (url: string | URL) => {
    fetchCalls.push(String(url));
    const r = responses.shift() ?? { status: 200, body: '{}' };
    return new Response(r.body ?? null, { status: r.status, headers: r.headers });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('assertConnectorEndpointUrl', () => {
  test('accepts public http and https endpoints', () => {
    expect(() => assertConnectorEndpointUrl('https://api.example.com/v1', { allowPrivateHosts: [] })).not.toThrow();
    expect(() => assertConnectorEndpointUrl('http://api.example.com', { allowPrivateHosts: [] })).not.toThrow();
  });
  test.each([
    ['http://10.0.0.5:8080'],
    ['http://127.0.0.1:3000'],
    ['http://169.254.169.254/latest'],
    ['http://[::1]:8080'],
    ['http://[::ffff:127.0.0.1]/'],
    ['http://localhost:3000'],
    ['https://metadata.google.internal/'],
  ])('refuses the private host in %s', (url) => {
    expect(() => assertConnectorEndpointUrl(url, { what: 'base_url', allowPrivateHosts: [] })).toThrow(
      'base_url must be a public host',
    );
  });
  test('refuses userinfo, other schemes, and relative URLs', () => {
    expect(() => assertConnectorEndpointUrl('https://u:p@api.example.com', { allowPrivateHosts: [] })).toThrow(
      'must not embed credentials',
    );
    expect(() => assertConnectorEndpointUrl('ftp://api.example.com', { allowPrivateHosts: [] })).toThrow(
      'must use http or https',
    );
    expect(() => assertConnectorEndpointUrl('/api/v3', { allowPrivateHosts: [] })).toThrow('absolute');
  });
  test('an operator-listed host is exempt, and only that host', () => {
    expect(() => assertConnectorEndpointUrl('http://127.0.0.1:4010', { allowPrivateHosts: ['127.0.0.1'] })).not.toThrow();
    expect(() => assertConnectorEndpointUrl('http://10.0.0.5', { allowPrivateHosts: ['127.0.0.1'] })).toThrow();
  });
});

describe('connector egress fetch', () => {
  const egress = createConnectorEgressFetch({ allowPrivateHosts: () => [] });

  test('a public endpoint is fetched and its headers are returned', async () => {
    responses = [{ status: 200, body: '{"ok":true}', headers: { 'mcp-session-id': 's1' } }];
    const res = await egress('https://api.example.com/v1/items', { method: 'GET', headers: {} });
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe('{"ok":true}');
    expect(res.headers?.get('mcp-session-id')).toBe('s1');
  });

  test('a private endpoint is refused before any request', async () => {
    await expect(egress('http://10.255.255.1:8080/ping', { method: 'GET', headers: {} })).rejects.toThrow(
      /^connector_egress_blocked: /,
    );
    expect(fetchCalls).toHaveLength(0);
  });

  test('a hostname that resolves to a private address is refused', async () => {
    dnsResults['rebind.example'] = [{ address: '169.254.169.254', family: 4 }];
    await expect(egress('https://rebind.example/x', { method: 'GET', headers: {} })).rejects.toThrow(
      /^connector_egress_blocked: /,
    );
    expect(fetchCalls).toHaveLength(0);
  });

  test('a redirect to a metadata address is refused, not followed', async () => {
    responses = [{ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }];
    await expect(egress('https://api.example.com/x', { method: 'GET', headers: {} })).rejects.toThrow(
      /^connector_egress_blocked: /,
    );
    expect(fetchCalls).toEqual(['https://api.example.com/x']);
  });

  test('the refusal never echoes the URL query, where query credentials live', async () => {
    const error = await egress('http://10.0.0.1/x?api_key=secret-value', { method: 'GET', headers: {} }).catch(
      (e: Error) => e,
    );
    expect(String((error as Error).message)).not.toContain('secret-value');
  });
});

const BASE_SPEC = {
  slug: 'internal',
  path: 'kortix.yaml#connectors.internal',
  name: 'Internal',
  enabled: true,
  provider: 'http',
  credentialMode: 'shared',
  authorizationStrategy: 'project',
  sensitive: false,
  app: null,
  account: null,
  url: null,
  transport: null,
  endpoint: null,
  baseUrl: 'http://10.0.0.5:8080',
  platform: null,
  spec: null,
  auth: { type: 'none', in: 'header', name: null, prefix: null, secret: null },
  headers: {},
  policies: [],
} satisfies ConnectorSpec;

describe('sync refuses a private connector endpoint', () => {
  test('an http connector base_url', async () => {
    const catalog = await resolveCatalog({} as GitBackedProject, BASE_SPEC);
    expect(catalog.actions).toEqual([]);
    expect(catalog.error).toContain('base_url must be a public host');
  });

  test('the server an OpenAPI document declares', async () => {
    dnsResults['specs.example.com'] = [{ address: '93.184.216.35', family: 4 }];
    responses = [
      {
        status: 200,
        body: JSON.stringify({
          openapi: '3.0.0',
          servers: [{ url: 'http://169.254.169.254/latest' }],
          paths: { '/meta-data': { get: { operationId: 'read', responses: { 200: { description: 'ok' } } } } },
        }),
      },
    ];
    const catalog = await resolveCatalog({} as GitBackedProject, {
      ...BASE_SPEC,
      provider: 'openapi',
      baseUrl: null,
      spec: 'https://specs.example.com/openapi.json',
    });
    expect(catalog.server).toBeNull();
    expect(catalog.error).toContain('OpenAPI server URL must be a public host');
  });

  test('a public OpenAPI server is kept', async () => {
    dnsResults['specs.example.com'] = [{ address: '93.184.216.35', family: 4 }];
    responses = [
      {
        status: 200,
        body: JSON.stringify({
          openapi: '3.0.0',
          servers: [{ url: 'https://api.example.com/v2' }],
          paths: { '/items': { get: { operationId: 'list', responses: { 200: { description: 'ok' } } } } },
        }),
      },
    ];
    const catalog = await resolveCatalog({} as GitBackedProject, {
      ...BASE_SPEC,
      provider: 'openapi',
      baseUrl: null,
      spec: 'https://specs.example.com/openapi.json',
    });
    expect(catalog.error).toBeUndefined();
    expect(catalog.server).toBe('https://api.example.com/v2');
  });
});
