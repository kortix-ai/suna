/**
 * Parser-level tests for `[[connectors]]` in kortix.toml.
 * Exercises every provider, every auth shape, connector-scoped policies,
 * and the rejection paths.
 */
import { describe, expect, test } from 'bun:test';
import {
  extractConnectors,
  manifestHashForConnector,
} from '../projects/connectors';
import {
  KNOWN_SCHEMA_VERSION,
  parseManifestString,
} from '../projects/triggers';

const MIN_PROJECT = `
[project]
name = "test"
`;

function manifestWith(body: string): string {
  return [`kortix_version = ${KNOWN_SCHEMA_VERSION}`, MIN_PROJECT, body].join('\n');
}

function parseAndExtract(body: string) {
  return extractConnectors(parseManifestString(manifestWith(body)));
}

describe('[[connectors]] — happy paths per provider', () => {
  test('pipedream — app + account', () => {
    const { specs, errors } = parseAndExtract(`
[[connectors]]
slug = "gmail-work"
provider = "pipedream"
app = "gmail"
account = "work"
`);
    expect(errors).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      slug: 'gmail-work',
      name: 'gmail-work',
      provider: 'pipedream',
      enabled: true,
      app: 'gmail',
      account: 'work',
      auth: { type: 'none' },
      policies: [],
    });
    expect(specs[0]!.path).toBe('kortix.toml#connectors.gmail-work');
  });

  test('pipedream — account defaults to slug', () => {
    const { specs, errors } = parseAndExtract(`
[[connectors]]
slug = "slack"
provider = "pipedream"
app = "slack"
`);
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({ app: 'slack', account: 'slack' });
  });

  test('openapi by URL with bearer auth', () => {
    const { specs, errors } = parseAndExtract(`
[[connectors]]
slug = "stripe"
name = "Stripe API"
provider = "openapi"
spec = "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json"

  [connectors.auth]
  type = "bearer"
`);
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({
      slug: 'stripe',
      name: 'Stripe API',
      provider: 'openapi',
      spec: 'https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json',
      auth: { type: 'bearer', in: 'header', name: null, prefix: null },
    });
  });

  test('openapi by repo file path', () => {
    const { specs, errors } = parseAndExtract(`
[[connectors]]
slug = "internal-rest"
provider = "openapi"
spec = ".kortix/executor/internal.openapi.json"
`);
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({ spec: '.kortix/executor/internal.openapi.json', auth: { type: 'none' } });
  });

  test('graphql — endpoint, optional spec, bearer', () => {
    const { specs, errors } = parseAndExtract(`
[[connectors]]
slug = "internal-graph"
provider = "graphql"
endpoint = "https://api.internal/graphql"

  [connectors.auth]
  type = "bearer"
`);
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({
      provider: 'graphql',
      endpoint: 'https://api.internal/graphql',
      spec: null,
      auth: { type: 'bearer' },
    });
  });

  test('mcp — url + transport + custom header auth', () => {
    const { specs, errors } = parseAndExtract(`
[[connectors]]
slug = "notion"
provider = "mcp"
url = "https://mcp.notion.com/mcp"
transport = "sse"

  [connectors.auth]
  type = "custom"
  name = "X-API-Key"
`);
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({
      provider: 'mcp',
      url: 'https://mcp.notion.com/mcp',
      transport: 'sse',
      auth: { type: 'custom', in: 'header', name: 'X-API-Key' },
    });
  });

  test('mcp — transport defaults to http', () => {
    const { specs } = parseAndExtract(`
[[connectors]]
slug = "ctx7"
provider = "mcp"
url = "https://mcp.example.com"
`);
    expect(specs[0]).toMatchObject({ transport: 'http' });
  });

  test('http — base_url + custom query auth + prefix', () => {
    const { specs, errors } = parseAndExtract(`
[[connectors]]
slug = "internal-http"
provider = "http"
base_url = "https://api.internal"
spec = ".kortix/executor/internal.http.toml"

  [connectors.auth]
  type = "custom"
  in = "query"
  name = "api_key"
  prefix = "tok_"
`);
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({
      provider: 'http',
      baseUrl: 'https://api.internal',
      spec: '.kortix/executor/internal.http.toml',
      auth: { type: 'custom', in: 'query', name: 'api_key', prefix: 'tok_' },
    });
  });
});

describe('[[connectors]] — credential mode', () => {
  test('defaults: pipedream → per_user, others → shared', () => {
    const pd = parseAndExtract(`
[[connectors]]
slug = "gmail"
provider = "pipedream"
app = "gmail"
`).specs[0]!;
    expect(pd.credentialMode).toBe('per_user');
    const oa = parseAndExtract(`
[[connectors]]
slug = "petstore"
provider = "openapi"
spec = "https://x/y.json"
`).specs[0]!;
    expect(oa.credentialMode).toBe('shared');
  });

  test('explicit override via credential =', () => {
    const { specs } = parseAndExtract(`
[[connectors]]
slug = "gmail"
provider = "pipedream"
app = "gmail"
credential = "shared"
`);
    expect(specs[0]!.credentialMode).toBe('shared');
  });

  test('rejects bad credential mode', () => {
    const { errors } = parseAndExtract(`
[[connectors]]
slug = "x"
provider = "openapi"
spec = "https://x/y.json"
credential = "team"
`);
    expect(errors[0]!.error).toContain('credential must be');
  });
});

describe('[[connectors]] — connector-scoped policies', () => {
  test('parses policies in order, all three actions', () => {
    const { specs, errors } = parseAndExtract(`
[[connectors]]
slug = "stripe"
provider = "openapi"
spec = "https://example.com/spec.json"

  [connectors.auth]
  type = "bearer"

  [[connectors.policies]]
  match = "*.delete*"
  action = "block"

  [[connectors.policies]]
  match = "charges.create"
  action = "require_approval"

  [[connectors.policies]]
  match = "*"
  action = "always_run"
`);
    expect(errors).toEqual([]);
    expect(specs[0]!.policies).toEqual([
      { match: '*.delete*', action: 'block' },
      { match: 'charges.create', action: 'require_approval' },
      { match: '*', action: 'always_run' },
    ]);
  });

  test('rejects bad policy action', () => {
    const { errors } = parseAndExtract(`
[[connectors]]
slug = "stripe"
provider = "openapi"
spec = "https://example.com/spec.json"

  [[connectors.policies]]
  match = "*"
  action = "yolo"
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toContain('action');
  });

  test('rejects policy missing match', () => {
    const { errors } = parseAndExtract(`
[[connectors]]
slug = "stripe"
provider = "openapi"
spec = "https://example.com/spec.json"

  [[connectors.policies]]
  action = "block"
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toContain('match');
  });
});

describe('[[connectors]] — rejection paths', () => {
  test('single bracket [connectors] is rejected', () => {
    const { specs, errors } = parseAndExtract(`
[connectors]
slug = "x"
`);
    expect(specs).toEqual([]);
    expect(errors[0]!.error).toContain('array of tables');
  });

  test('missing slug', () => {
    const { errors } = parseAndExtract(`
[[connectors]]
provider = "openapi"
spec = "https://x/y.json"
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toContain('missing a slug');
  });

  test('bad slug', () => {
    const { errors } = parseAndExtract(`
[[connectors]]
slug = "Bad Slug"
provider = "openapi"
spec = "https://x/y.json"
`);
    expect(errors[0]!.error).toContain('Invalid slug');
  });

  test('unknown provider', () => {
    const { errors } = parseAndExtract(`
[[connectors]]
slug = "x"
provider = "soap"
`);
    expect(errors[0]!.error).toContain('provider must be one of');
  });

  test('openapi missing spec', () => {
    const { errors } = parseAndExtract(`
[[connectors]]
slug = "x"
provider = "openapi"
`);
    expect(errors[0]!.error).toContain('requires `spec`');
  });

  test('mcp missing url', () => {
    const { errors } = parseAndExtract(`
[[connectors]]
slug = "x"
provider = "mcp"
`);
    expect(errors[0]!.error).toContain('requires `url`');
  });

  test('http missing base_url', () => {
    const { errors } = parseAndExtract(`
[[connectors]]
slug = "x"
provider = "http"
`);
    expect(errors[0]!.error).toContain('requires `base_url`');
  });

  test('http baseUrl camelCase alias is rejected', () => {
    const { specs, errors } = parseAndExtract(`
[[connectors]]
slug = "x"
provider = "http"
baseUrl = "https://api.internal"
`);
    expect(specs).toEqual([]);
    expect(errors[0]!.error).toContain('requires `base_url`');
  });

  test('pipedream missing app', () => {
    const { errors } = parseAndExtract(`
[[connectors]]
slug = "x"
provider = "pipedream"
`);
    expect(errors[0]!.error).toContain('requires `app`');
  });

  test('enabled must be a boolean', () => {
    const { specs, errors } = parseAndExtract(`
[[connectors]]
slug = "x"
provider = "openapi"
spec = "https://x/y.json"
enabled = "false"
`);
    expect(specs).toEqual([]);
    expect(errors[0]!.error).toContain('enabled must be a boolean');
  });

  test('auth type custom without name', () => {
    const { errors } = parseAndExtract(`
[[connectors]]
slug = "x"
provider = "openapi"
spec = "https://x/y.json"

  [connectors.auth]
  type = "custom"
`);
    expect(errors[0]!.error).toContain('requires `name`');
  });

  test('auth type bearer WITHOUT secret is now accepted (credentials are separate)', () => {
    const { specs, errors } = parseAndExtract(`
[[connectors]]
slug = "x"
provider = "openapi"
spec = "https://x/y.json"

  [connectors.auth]
  type = "bearer"
`);
    expect(errors).toEqual([]);
    expect(specs[0]!.auth).toMatchObject({ type: 'bearer' });
  });

  test('auth secret is rejected', () => {
    const { errors } = parseAndExtract(`
[[connectors]]
slug = "x"
provider = "openapi"
spec = "https://x/y.json"

  [connectors.auth]
  type = "bearer"
  secret = "API_TOKEN"
`);
    expect(errors[0]!.error).toContain('secret is no longer supported');
  });

  test('pipedream with auth table is rejected', () => {
    const { errors } = parseAndExtract(`
[[connectors]]
slug = "x"
provider = "pipedream"
app = "gmail"

  [connectors.auth]
  type = "bearer"
`);
    expect(errors[0]!.error).toContain('connected account');
  });

  test('duplicate slugs', () => {
    const { specs, errors } = parseAndExtract(`
[[connectors]]
slug = "dup"
provider = "openapi"
spec = "https://x/y.json"

[[connectors]]
slug = "dup"
provider = "mcp"
url = "https://m"
`);
    expect(specs).toHaveLength(1);
    expect(errors.some((e) => e.error.includes('Duplicate connector slug'))).toBe(true);
  });

  test('good and bad entries coexist (permissive parser)', () => {
    const { specs, errors } = parseAndExtract(`
[[connectors]]
slug = "good"
provider = "openapi"
spec = "https://x/y.json"

[[connectors]]
slug = "bad"
provider = "mcp"
`);
    expect(specs.map((s) => s.slug)).toEqual(['good']);
    expect(errors.map((e) => e.slug)).toEqual(['bad']);
  });
});

describe('manifestHashForConnector', () => {
  test('stable across name changes, changes with config', () => {
    const a = parseAndExtract(`
[[connectors]]
slug = "x"
name = "Name A"
provider = "openapi"
spec = "https://x/y.json"
`).specs[0]!;
    const b = { ...a, name: 'Name B' };
    const c = { ...a, spec: 'https://x/z.json' };
    expect(manifestHashForConnector(a)).toBe(manifestHashForConnector(b));
    expect(manifestHashForConnector(a)).not.toBe(manifestHashForConnector(c));
  });
});
