/**
 * Materialization mapping — manifest connector/policy specs into the persisted
 * config rows the sync sweep applies.
 */
import { describe, expect, test } from 'bun:test';
import {
  connectorConfig,
  toPolicyRows,
  toProjectPolicyRows,
} from '../executor/materialize';
import { extractConnectors } from '../projects/connectors';
import { extractProjectPolicies } from '../projects/policies';
import { KNOWN_SCHEMA_VERSION, parseManifestString } from '../projects/triggers';

function specFrom(body: string) {
  const m = parseManifestString(`kortix_version = ${KNOWN_SCHEMA_VERSION}\n[project]\nname="t"\n${body}`);
  return extractConnectors(m).specs[0]!;
}

describe('connectorConfig', () => {
  test('openapi folds discovered server + auth into config', () => {
    const spec = specFrom(`
[[connectors]]
slug = "stripe"
name = "Stripe"
provider = "openapi"
spec = "https://x/spec.json"
  [connectors.auth]
  type = "bearer"
`);
    expect(connectorConfig(spec, 'https://api.stripe.com')).toEqual({
      spec: 'https://x/spec.json',
      server: 'https://api.stripe.com',
      auth: { type: 'bearer', in: 'header', name: null, prefix: null },
    });
  });

  test('pipedream config = app + account, no auth secret', () => {
    const spec = specFrom(`
[[connectors]]
slug = "gmail"
provider = "pipedream"
app = "gmail"
account = "work"
`);
    expect(connectorConfig(spec)).toEqual({ app: 'gmail', account: 'work' });
  });

  test('mcp/graphql/http config keeps provider endpoint', () => {
    const mcp = specFrom(`
[[connectors]]
slug = "n"
provider = "mcp"
url = "https://mcp.x/mcp"
`);
    expect(connectorConfig(mcp)).toMatchObject({ url: 'https://mcp.x/mcp' });

    const gql = specFrom(`
[[connectors]]
slug = "g"
provider = "graphql"
endpoint = "https://api/graphql"
`);
    expect(connectorConfig(gql)).toMatchObject({ endpoint: 'https://api/graphql' });

    const http = specFrom(`
[[connectors]]
slug = "h"
provider = "http"
base_url = "https://api.internal"
`);
    expect(connectorConfig(http)).toMatchObject({ baseUrl: 'https://api.internal' });
  });

  test('config keeps auth metadata only; credential resolves server-side', () => {
    const spec = specFrom(`
[[connectors]]
slug = "h"
provider = "http"
base_url = "https://api"
  [connectors.auth]
  type = "custom"
  in = "query"
  name = "key"
`);
    expect((connectorConfig(spec) as any).auth).toEqual({ type: 'custom', in: 'query', name: 'key', prefix: null });
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

describe('toProjectPolicyRows', () => {
  test('top-level [[policies]] preserves order as position', () => {
    const m = parseManifestString(`kortix_version = ${KNOWN_SCHEMA_VERSION}
[project]
name="t"

[[policies]]
match = "*.delete*"
action = "block"

[[policies]]
match = "stripe.*"
action = "require_approval"
`);
    const parsed = extractProjectPolicies(m);
    expect(toProjectPolicyRows(parsed.policies)).toEqual([
      { match: '*.delete*', action: 'block', position: 0 },
      { match: 'stripe.*', action: 'require_approval', position: 1 },
    ]);
  });
});
