/**
 * Parser-level tests for `connectors:` in kortix.yaml.
 * Exercises every provider, every auth shape, connector-scoped policies,
 * the round-trip (spec → manifest entry → re-parse), and the rejection paths.
 */
import { describe, expect, test } from 'bun:test';
import {
  connectorSpecToTomlEntry,
  extractConnectors,
  manifestHashForConnector,
  type ConnectorSpec,
} from '../projects/connectors';
import {
  KNOWN_SCHEMA_VERSION,
  parseManifestString,
  serializeManifest,
} from '../projects/triggers';

const MIN_PROJECT = `project:
  name: test
`;

function manifestWith(body: string): string {
  return [`kortix_version: ${KNOWN_SCHEMA_VERSION}`, MIN_PROJECT, body].join('\n');
}

function parseAndExtract(body: string) {
  return extractConnectors(parseManifestString(manifestWith(body), 'yaml', 'kortix.yaml'));
}

describe('connectors: — happy paths per provider', () => {
  test('pipedream — app + account', () => {
    const { specs, errors } = parseAndExtract(`
connectors:
  - slug: gmail-work
    provider: pipedream
    app: gmail
    account: work
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
    expect(specs[0]!.path).toBe('kortix.yaml#connectors.gmail-work');
  });

  test('pipedream — account defaults to slug', () => {
    const { specs, errors } = parseAndExtract(`
connectors:
  - slug: slack
    provider: pipedream
    app: slack
`);
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({ app: 'slack', account: 'slack' });
  });

  test('openapi by URL with bearer auth', () => {
    const { specs, errors } = parseAndExtract(`
connectors:
  - slug: stripe
    name: Stripe API
    provider: openapi
    spec: https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json
    auth:
      type: bearer
      secret: STRIPE_API_KEY
`);
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({
      slug: 'stripe',
      name: 'Stripe API',
      provider: 'openapi',
      spec: 'https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json',
      auth: { type: 'bearer', in: 'header', name: null, prefix: null, secret: 'STRIPE_API_KEY' },
    });
  });

  test('openapi by repo file path', () => {
    const { specs, errors } = parseAndExtract(`
connectors:
  - slug: internal-rest
    provider: openapi
    spec: .kortix/executor/internal.openapi.json
`);
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({ spec: '.kortix/executor/internal.openapi.json', auth: { type: 'none' } });
  });

  test('graphql — endpoint, optional spec, bearer', () => {
    const { specs, errors } = parseAndExtract(`
connectors:
  - slug: internal-graph
    provider: graphql
    endpoint: https://api.internal/graphql
    auth:
      type: bearer
      secret: INTERNAL_GRAPH_TOKEN
`);
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({
      provider: 'graphql',
      endpoint: 'https://api.internal/graphql',
      spec: null,
      auth: { type: 'bearer', secret: 'INTERNAL_GRAPH_TOKEN' },
    });
  });

  test('mcp — url + transport + custom header auth', () => {
    const { specs, errors } = parseAndExtract(`
connectors:
  - slug: notion
    provider: mcp
    url: https://mcp.notion.com/mcp
    transport: sse
    auth:
      type: custom
      name: X-API-Key
      secret: NOTION_MCP_TOKEN
`);
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({
      provider: 'mcp',
      url: 'https://mcp.notion.com/mcp',
      transport: 'sse',
      auth: { type: 'custom', in: 'header', name: 'X-API-Key', secret: 'NOTION_MCP_TOKEN' },
    });
  });

  test('mcp — transport defaults to http', () => {
    const { specs } = parseAndExtract(`
connectors:
  - slug: ctx7
    provider: mcp
    url: https://mcp.example.com
`);
    expect(specs[0]).toMatchObject({ transport: 'http' });
  });

  test('http — base_url + custom query auth + prefix', () => {
    const { specs, errors } = parseAndExtract(`
connectors:
  - slug: internal-http
    provider: http
    base_url: https://api.internal
    spec: .kortix/executor/internal.http.toml
    auth:
      type: custom
      in: query
      name: api_key
      prefix: tok_
      secret: INTERNAL_API_TOKEN
`);
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({
      provider: 'http',
      baseUrl: 'https://api.internal',
      spec: '.kortix/executor/internal.http.toml',
      auth: { type: 'custom', in: 'query', name: 'api_key', prefix: 'tok_', secret: 'INTERNAL_API_TOKEN' },
    });
  });
});

describe('connectors: — agent_scope is retired (connector-side agent gate removed)', () => {
  test('a legacy agent_scope key is ignored — parses fine, never round-trips back', () => {
    const { specs, errors } = parseAndExtract(`
connectors:
  - slug: github
    provider: http
    base_url: https://api.github.com
    agent_scope:
      - pr-bot
      - release-bot
`);
    expect(errors).toEqual([]);
    expect(specs[0]).not.toHaveProperty('agentScope');
    // Never re-emitted — the only remaining agent gate is `agents:.connectors`.
    expect(connectorSpecToTomlEntry(specs[0]!)).not.toHaveProperty('agent_scope');
  });
});

// `per_user` (each member brings their own) was removed 2026-07-05
// (docs/specs/2026-07-05-agent-first-config-unification.md §2.5) — `shared`
// is now the only mode, for every provider, including pipedream (whose
// default used to be `per_user`).
describe('connectors: — credential mode', () => {
  test('defaults: every provider → shared, including pipedream', () => {
    const pd = parseAndExtract(`
connectors:
  - slug: gmail
    provider: pipedream
    app: gmail
`).specs[0]!;
    expect(pd.credentialMode).toBe('shared');
    const oa = parseAndExtract(`
connectors:
  - slug: petstore
    provider: openapi
    spec: https://x/y.json
`).specs[0]!;
    expect(oa.credentialMode).toBe('shared');
  });

  test('explicit `credential = "shared"` is a no-op (already the default)', () => {
    const { specs } = parseAndExtract(`
connectors:
  - slug: gmail
    provider: pipedream
    app: gmail
    credential: shared
`);
    expect(specs[0]!.credentialMode).toBe('shared');
  });

  test('legacy `credential = "per_user"` is tolerated and resolves to shared', () => {
    const { specs, errors } = parseAndExtract(`
connectors:
  - slug: gmail
    provider: pipedream
    app: gmail
    credential: per_user
`);
    expect(errors).toEqual([]);
    expect(specs[0]!.credentialMode).toBe('shared');
  });

  test('rejects bad credential mode', () => {
    const { errors } = parseAndExtract(`
connectors:
  - slug: x
    provider: openapi
    spec: https://x/y.json
    credential: team
`);
    expect(errors[0]!.error).toContain('credential must be');
  });
});

describe('connectors: — connector-scoped policies', () => {
  test('parses policies in order, all three actions', () => {
    const { specs, errors } = parseAndExtract(`
connectors:
  - slug: stripe
    provider: openapi
    spec: https://example.com/spec.json
    auth:
      type: bearer
      secret: STRIPE_API_KEY
    policies:
      - match: "*.delete*"
        action: block
      - match: charges.create
        action: require_approval
      - match: "*"
        action: always_run
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
connectors:
  - slug: stripe
    provider: openapi
    spec: https://example.com/spec.json
    policies:
      - match: "*"
        action: yolo
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toContain('action');
  });

  test('rejects policy missing match', () => {
    const { errors } = parseAndExtract(`
connectors:
  - slug: stripe
    provider: openapi
    spec: https://example.com/spec.json
    policies:
      - action: block
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toContain('match');
  });
});

describe('connectors: — rejection paths', () => {
  test('top-level `connectors` as a mapping (not a list) is rejected', () => {
    const { specs, errors } = parseAndExtract(`
connectors:
  slug: x
`);
    expect(specs).toEqual([]);
    expect(errors[0]!.error).toContain('array of tables');
  });

  test('missing slug', () => {
    const { errors } = parseAndExtract(`
connectors:
  - provider: openapi
    spec: https://x/y.json
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toContain('missing a slug');
  });

  test('bad slug', () => {
    const { errors } = parseAndExtract(`
connectors:
  - slug: "Bad Slug"
    provider: openapi
    spec: https://x/y.json
`);
    expect(errors[0]!.error).toContain('Invalid slug');
  });

  test('unknown provider', () => {
    const { errors } = parseAndExtract(`
connectors:
  - slug: x
    provider: soap
`);
    expect(errors[0]!.error).toContain('provider must be one of');
  });

  test('openapi missing spec', () => {
    const { errors } = parseAndExtract(`
connectors:
  - slug: x
    provider: openapi
`);
    expect(errors[0]!.error).toContain('requires `spec`');
  });

  test('mcp missing url', () => {
    const { errors } = parseAndExtract(`
connectors:
  - slug: x
    provider: mcp
`);
    expect(errors[0]!.error).toContain('requires `url`');
  });

  test('http missing base_url', () => {
    const { errors } = parseAndExtract(`
connectors:
  - slug: x
    provider: http
`);
    expect(errors[0]!.error).toContain('requires `base_url`');
  });

  test('pipedream missing app', () => {
    const { errors } = parseAndExtract(`
connectors:
  - slug: x
    provider: pipedream
`);
    expect(errors[0]!.error).toContain('requires `app`');
  });

  test('auth type custom without name', () => {
    const { errors } = parseAndExtract(`
connectors:
  - slug: x
    provider: openapi
    spec: https://x/y.json
    auth:
      type: custom
      secret: TOK
`);
    expect(errors[0]!.error).toContain('requires `name`');
  });

  test('auth type bearer WITHOUT secret is now accepted (credentials are separate)', () => {
    const { specs, errors } = parseAndExtract(`
connectors:
  - slug: x
    provider: openapi
    spec: https://x/y.json
    auth:
      type: bearer
`);
    expect(errors).toEqual([]);
    expect(specs[0]!.auth).toMatchObject({ type: 'bearer', secret: null });
  });

  test('auth secret with invalid name', () => {
    const { errors } = parseAndExtract(`
connectors:
  - slug: x
    provider: openapi
    spec: https://x/y.json
    auth:
      type: bearer
      secret: lowercase-bad
`);
    expect(errors[0]!.error).toContain('project-secret name');
  });

  test('pipedream with auth table is rejected', () => {
    const { errors } = parseAndExtract(`
connectors:
  - slug: x
    provider: pipedream
    app: gmail
    auth:
      type: bearer
      secret: TOK
`);
    expect(errors[0]!.error).toContain('connected account');
  });

  test('duplicate slugs', () => {
    const { specs, errors } = parseAndExtract(`
connectors:
  - slug: dup
    provider: openapi
    spec: https://x/y.json
  - slug: dup
    provider: mcp
    url: https://m
`);
    expect(specs).toHaveLength(1);
    expect(errors.some((e) => e.error.includes('Duplicate connector slug'))).toBe(true);
  });

  test('good and bad entries coexist (permissive parser)', () => {
    const { specs, errors } = parseAndExtract(`
connectors:
  - slug: good
    provider: openapi
    spec: https://x/y.json
  - slug: bad
    provider: mcp
`);
    expect(specs.map((s) => s.slug)).toEqual(['good']);
    expect(errors.map((e) => e.slug)).toEqual(['bad']);
  });
});

describe('connectors: — round-trip', () => {
  function roundTrip(spec: ConnectorSpec): ConnectorSpec {
    const manifest = parseManifestString(manifestWith(''), 'yaml', 'kortix.yaml');
    manifest.raw.connectors = [connectorSpecToTomlEntry(spec)];
    const yamlText = serializeManifest(manifest);
    const { specs, errors } = extractConnectors(parseManifestString(yamlText, 'yaml', 'kortix.yaml'));
    expect(errors).toEqual([]);
    expect(specs).toHaveLength(1);
    return specs[0]!;
  }

  test('openapi + bearer + policies survives a serialize→parse round-trip', () => {
    const original = parseAndExtract(`
connectors:
  - slug: stripe
    name: Stripe API
    provider: openapi
    spec: https://example.com/spec.json
    auth:
      type: bearer
      secret: STRIPE_API_KEY
    policies:
      - match: "*.delete*"
        action: block
`).specs[0]!;
    expect(roundTrip(original)).toEqual(original);
  });

  test('pipedream survives round-trip', () => {
    const original = parseAndExtract(`
connectors:
  - slug: gmail-work
    provider: pipedream
    app: gmail
    account: work
`).specs[0]!;
    expect(roundTrip(original)).toEqual(original);
  });

  test('mcp + custom auth survives round-trip', () => {
    const original = parseAndExtract(`
connectors:
  - slug: notion
    provider: mcp
    url: https://mcp.notion.com/mcp
    transport: sse
    auth:
      type: custom
      in: query
      name: X-Key
      prefix: Bearer
      secret: NOTION_MCP_TOKEN
`).specs[0]!;
    expect(roundTrip(original)).toEqual(original);
  });
});

describe('manifestHashForConnector', () => {
  test('stable across name changes, changes with config', () => {
    const a = parseAndExtract(`
connectors:
  - slug: x
    name: Name A
    provider: openapi
    spec: https://x/y.json
`).specs[0]!;
    const b = { ...a, name: 'Name B' };
    const c = { ...a, spec: 'https://x/z.json' };
    expect(manifestHashForConnector(a)).toBe(manifestHashForConnector(b));
    expect(manifestHashForConnector(a)).not.toBe(manifestHashForConnector(c));
  });
});

/**
 * Drift guard: the runtime parser (this module) and the canonical schema gate
 * (@kortix/manifest-schema, run on CR-merge) must agree on which providers a
 * kortix.yaml may declare. They drifted once — `channel` was added here and to
 * channel-manifest.ts (which WRITES it into the manifest) but not to the schema,
 * so the merge gate rejected manifests the platform itself produced. Keep them
 * locked together: a provider one side accepts the other must not reject.
 */
describe('connectors: — runtime parser ⇄ schema gate provider agreement', () => {
  const { validateManifest } = require('@kortix/manifest-schema') as typeof import('@kortix/manifest-schema');

  function schemaConnectorErrors(body: string): string[] {
    return validateManifest(manifestWith(body), 'yaml')
      .issues.filter((i) => i.severity === 'error' && i.path.startsWith('connectors['))
      .map((i) => i.path);
  }

  const cases: Array<{ name: string; body: string; accept: boolean }> = [
    { name: 'pipedream', accept: true, body: `connectors:\n  - slug: c\n    provider: pipedream\n    app: gmail` },
    { name: 'mcp', accept: true, body: `connectors:\n  - slug: c\n    provider: mcp\n    url: https://e.com` },
    { name: 'openapi', accept: true, body: `connectors:\n  - slug: c\n    provider: openapi\n    spec: https://e.com/o.json` },
    { name: 'graphql', accept: true, body: `connectors:\n  - slug: c\n    provider: graphql\n    endpoint: https://e.com/graphql` },
    { name: 'http', accept: true, body: `connectors:\n  - slug: c\n    provider: http\n    base_url: https://e.com` },
    { name: 'channel', accept: true, body: `connectors:\n  - slug: kortix_slack\n    provider: channel\n    platform: slack` },
    { name: 'computer (synth-only)', accept: false, body: `connectors:\n  - slug: computer\n    provider: computer` },
    { name: 'unknown provider', accept: false, body: `connectors:\n  - slug: c\n    provider: made-up` },
  ];

  for (const { name, body, accept } of cases) {
    test(`${name}: parser and schema agree (accept=${accept})`, () => {
      const runtimeOk = parseAndExtract(body).errors.length === 0;
      const schemaOk = schemaConnectorErrors(body).length === 0;
      expect(runtimeOk).toBe(accept);
      expect(schemaOk).toBe(accept);
    });
  }

  // Table-tests below iterate the SCHEMA package's own exported constants
  // (rather than a hand-copied list here) so a platform/reserved-slug added
  // to `@kortix/manifest-schema` — or to this module's own `RESERVED_SLUG_PROVIDERS`
  // — is automatically covered without anyone remembering to add a case.
  const {
    CHANNEL_PLATFORMS: SCHEMA_CHANNEL_PLATFORMS,
    RESERVED_SLUG_PROVIDERS: SCHEMA_RESERVED_SLUG_PROVIDERS,
  } = require('@kortix/manifest-schema') as typeof import('@kortix/manifest-schema');

  describe('every CHANNEL_PLATFORMS value materializes a valid `channel` connector on both sides', () => {
    for (const platform of SCHEMA_CHANNEL_PLATFORMS) {
      test(`platform="${platform}"`, () => {
        const body = `connectors:\n  - slug: kortix_${platform}\n    provider: channel\n    platform: ${platform}`;
        expect(parseAndExtract(body).errors).toEqual([]);
        expect(schemaConnectorErrors(body)).toEqual([]);
      });
    }
  });

  describe('every RESERVED_SLUG_PROVIDERS pair: the matching provider is accepted, a mismatched one is rejected on both sides', () => {
    for (const [slug, provider] of Object.entries(SCHEMA_RESERVED_SLUG_PROVIDERS)) {
      const matchingBody =
        provider === 'channel'
          ? `connectors:\n  - slug: ${slug}\n    provider: channel\n    platform: slack`
          : `connectors:\n  - slug: ${slug}\n    provider: ${provider}`;
      const mismatchedBody = `connectors:\n  - slug: ${slug}\n    provider: pipedream\n    app: x`;

      test(`slug="${slug}" + provider="${provider}" (matching) is accepted`, () => {
        // `provider="computer"` is itself always rejected (synth-only) —
        // the reserved-slug/provider PAIRING still agrees on both sides even
        // though the overall connector is invalid for the unrelated reason.
        const runtimeErrors = parseAndExtract(matchingBody).errors;
        const schemaErrors = schemaConnectorErrors(matchingBody);
        if (provider === 'computer') {
          expect(runtimeErrors.length > 0).toBe(true);
          expect(schemaErrors.length > 0).toBe(true);
        } else {
          expect(runtimeErrors).toEqual([]);
          expect(schemaErrors).toEqual([]);
        }
      });

      test(`slug="${slug}" + a mismatched provider is rejected on both sides`, () => {
        expect(parseAndExtract(mismatchedBody).errors.length > 0).toBe(true);
        expect(schemaConnectorErrors(mismatchedBody).length > 0).toBe(true);
      });
    }
  });
});
