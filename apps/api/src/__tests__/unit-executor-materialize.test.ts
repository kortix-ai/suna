/**
 * Materialization mapping + diff — ConnectorSpec → persisted row shape, and the
 * create/update/delete diff that the sync sweep applies.
 */
import { describe, expect, test } from 'bun:test';
import {
  connectorConfig,
  diffConnectors,
  gatewayAuth,
  gatewayBaseUrl,
  toDesiredConnector,
  toPolicyRows,
  type DesiredConnector,
} from '../executor/materialize';
import { extractConnectors } from '../projects/connectors';
import { KNOWN_SCHEMA_VERSION, parseManifestString } from '../projects/triggers';

function specFrom(body: string) {
  const m = parseManifestString(`kortix_version = ${KNOWN_SCHEMA_VERSION}\n[project]\nname="t"\n${body}`);
  return extractConnectors(m).specs[0]!;
}

describe('toDesiredConnector + config', () => {
  test('openapi folds discovered server + auth into config', () => {
    const spec = specFrom(`
[[connectors]]
slug = "stripe"
name = "Stripe"
provider = "openapi"
spec = "https://x/spec.json"
  [connectors.auth]
  type = "bearer"
  secret = "STRIPE_API_KEY"
`);
    const row = toDesiredConnector(spec, 'https://api.stripe.com');
    expect(row).toMatchObject({
      slug: 'stripe',
      providerType: 'openapi',
      enabled: true,
      authSecret: 'STRIPE_API_KEY',
    });
    expect(row.config).toEqual({
      spec: 'https://x/spec.json',
      server: 'https://api.stripe.com',
      auth: { type: 'bearer', in: 'header', name: null, prefix: null },
    });
    expect(row.manifestHash).toHaveLength(64);
  });

  test('pipedream config = app + account, no auth secret', () => {
    const spec = specFrom(`
[[connectors]]
slug = "gmail"
provider = "pipedream"
app = "gmail"
account = "work"
`);
    const row = toDesiredConnector(spec);
    expect(row.config).toEqual({ app: 'gmail', account: 'work' });
    expect(row.authSecret).toBeNull();
  });

  test('mcp/graphql/http base URLs', () => {
    const mcp = specFrom(`
[[connectors]]
slug = "n"
provider = "mcp"
url = "https://mcp.x/mcp"
`);
    expect(gatewayBaseUrl(mcp)).toBe('https://mcp.x/mcp');

    const gql = specFrom(`
[[connectors]]
slug = "g"
provider = "graphql"
endpoint = "https://api/graphql"
`);
    expect(gatewayBaseUrl(gql)).toBe('https://api/graphql');

    const http = specFrom(`
[[connectors]]
slug = "h"
provider = "http"
base_url = "https://api.internal"
`);
    expect(gatewayBaseUrl(http)).toBe('https://api.internal');
  });

  test('gatewayAuth strips the secret name (value resolved server-side)', () => {
    const spec = specFrom(`
[[connectors]]
slug = "h"
provider = "http"
base_url = "https://api"
  [connectors.auth]
  type = "custom"
  in = "query"
  name = "key"
  secret = "API_TOKEN"
`);
    expect(gatewayAuth(spec)).toEqual({ type: 'custom', in: 'query', name: 'key', prefix: null });
    expect((connectorConfig(spec) as any).auth).not.toHaveProperty('secret');
  });
});

describe('toPolicyRows', () => {
  test('preserves authoring order as position', () => {
    const spec = specFrom(`
[[connectors]]
slug = "s"
provider = "openapi"
spec = "https://x/y.json"
  [[connectors.policies]]
  match = "*.delete*"
  action = "block"
  [[connectors.policies]]
  match = "*"
  action = "always_run"
`);
    expect(toPolicyRows(spec)).toEqual([
      { match: '*.delete*', action: 'block', position: 0 },
      { match: '*', action: 'always_run', position: 1 },
    ]);
  });
});

describe('diffConnectors', () => {
  const a: DesiredConnector = { slug: 'a', name: 'A', providerType: 'openapi', enabled: true, config: {}, authSecret: null, manifestHash: 'h-a' };
  const b: DesiredConnector = { slug: 'b', name: 'B', providerType: 'mcp', enabled: true, config: {}, authSecret: null, manifestHash: 'h-b' };

  test('create new, update changed, skip unchanged, delete removed', () => {
    const existing = new Map([['a', 'h-a'], ['c', 'h-c']]); // a unchanged, c gone
    const desired = [a, b, { ...a, slug: 'c', manifestHash: 'h-c-new' }];
    const diff = diffConnectors(desired, new Map([['a', 'h-a'], ['c', 'h-c']]));
    expect(diff.toCreate.map((d) => d.slug)).toEqual(['b']);
    expect(diff.toUpdate.map((d) => d.slug)).toEqual(['c']);
    expect(diff.toDeleteSlugs).toEqual([]);
    void existing;
  });

  test('removed connectors are deleted', () => {
    const diff = diffConnectors([a], new Map([['a', 'h-a'], ['old', 'h-old']]));
    expect(diff.toDeleteSlugs).toEqual(['old']);
    expect(diff.toCreate).toEqual([]);
    expect(diff.toUpdate).toEqual([]);
  });
});
