import { describe, expect, test } from 'bun:test';

import { config } from '../../config';
import {
  type SecretAgentGrantConfig,
  buildSecretView,
  secretDeliveryBlockedReason,
  serializeProject,
} from './serializers';

// `metadata` is nullable: packages/db/src/schema/kortix.ts:330 declares
// jsonb('metadata').default({}) with NO .notNull(), which is why
// serializeProject guards it with `?.`.
function projectRow(metadata: Record<string, unknown> | null) {
  return {
    projectId: '11111111-1111-4111-8111-111111111111',
    accountId: '22222222-2222-4222-8222-222222222222',
    name: 'demo',
    repoUrl: 'https://github.com/acme/demo.git',
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    idempotencyKey: null,
    status: 'active' as const,
    secretDefaultStrategy: 'runtime' as const,
    metadata,
    sandboxProviderGeneration: 0,
    lastOpenedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

describe('serializeProject icon', () => {
  test('exposes a valid metadata.icon as a top-level field', () => {
    expect(serializeProject(projectRow({ icon: '🚀' })).icon).toBe('🚀');
  });

  test('is null when metadata has no icon', () => {
    expect(serializeProject(projectRow({})).icon).toBeNull();
  });

  test('is null when metadata.icon is malformed', () => {
    expect(serializeProject(projectRow({ icon: 'not-an-emoji' })).icon).toBeNull();
  });

  test('is null when metadata.icon is oversized', () => {
    expect(serializeProject(projectRow({ icon: 'x'.repeat(5000) })).icon).toBeNull();
  });

  test('is null when metadata itself is null', () => {
    expect(serializeProject(projectRow(null)).icon).toBeNull();
  });

  test('metadata defaults to {} on the serialized project when the row is null', () => {
    expect(serializeProject(projectRow(null)).metadata).toEqual({});
  });
});

describe('serializeProject — icon_glyph', () => {
  test('a stored glyph is exposed as a top-level field', () => {
    const row = projectRow({ icon_glyph: { name: 'Rocket', color: 'blue' } });
    expect(serializeProject(row).icon_glyph).toEqual({ name: 'Rocket', color: 'blue' });
  });

  test('no glyph is null, not undefined', () => {
    // The contract declares it `.nullable()`, matching `icon` and
    // `last_opened_at`. Returning undefined would drop the key from the JSON
    // and break a client that destructures it.
    expect(serializeProject(projectRow({})).icon_glyph).toBeNull();
    expect(serializeProject(projectRow(null)).icon_glyph).toBeNull();
  });

  test('a malformed stored glyph normalizes to null on READ', () => {
    // This is the read-path guarantee: a row hand-edited in the database
    // cannot put an unrenderable value in front of the UI.
    const row = projectRow({ icon_glyph: { name: 'Skull', color: 'red' } });
    expect(serializeProject(row).icon_glyph).toBeNull();
  });

  test('a glyph and an emoji on the same row both serialize', () => {
    // The write paths make this state unreachable, but the serializer must not
    // assume that — a row predating the invariant would otherwise throw.
    const row = projectRow({ icon: '🚀', icon_glyph: { name: 'Star', color: 'red' } });
    const out = serializeProject(row);
    expect(out.icon).toBe('🚀');
    expect(out.icon_glyph).toEqual({ name: 'Star', color: 'red' });
  });
});

// ─── delivery_blocked_reason: the agent-grant axis ──────────────────────────
// An `egress`/`broker` secret reaches a session only when some agent's
// `secrets:` list is an explicit array naming its IDENTIFIER
// (apps/api/src/secrets/strategy.ts:475-507). `delivery_status` never looked at
// that, so a project whose manifest grants nothing still reported 'available'
// while every boot withheld the value as `agent_grant_unscoped`.

function secretRow(overrides: Record<string, unknown> = {}): any {
  return {
    secretId: 's-1',
    projectId: '33333333-3333-4333-8333-333333333333',
    identifier: 'BOUNDARY_TEST',
    name: 'BOUNDARY_TEST',
    valueEnc: 'enc',
    scope: 'runtime',
    strategy: 'egress',
    consumer: 'network',
    egressPolicy: {
      rules: [{ host: 'postman-echo.com' }],
      inject: { kind: 'header', name: 'authorization' },
    },
    handlePrefix: null,
    description: null,
    rotatedAt: new Date('2026-01-02T00:00:00Z'),
    strategyLocked: false,
    ownerUserId: null,
    active: true,
    createdBy: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** A declarative config — the manifest parsed, so its `agents:` declarations
 *  are the complete grant set and the answer is certain. */
function declarative(env: Array<string[] | 'all' | undefined>): SecretAgentGrantConfig {
  return {
    agent_discovery: 'declarative',
    agents: env.map((scopeEnv, i) => ({
      name: `agent-${i}`,
      path: `.opencode/agent/agent-${i}.md`,
      description: null,
      mode: null,
      source: 'kortix.yaml' as const,
      enabled: true,
      ...(scopeEnv === undefined
        ? {}
        : { scope: { env: scopeEnv, connectors: 'all' as const, kortix_cli: 'all' as const } }),
    })),
  };
}

describe('secretDeliveryBlockedReason', () => {
  test('an explicit identifier grant clears the block', () => {
    expect(
      secretDeliveryBlockedReason('BOUNDARY_TEST', 'egress', declarative([['BOUNDARY_TEST']])),
    ).toBeNull();
  });

  test('matching is case-insensitive, like listAdmits', () => {
    expect(
      secretDeliveryBlockedReason('BOUNDARY_TEST', 'egress', declarative([['boundary_test']])),
    ).toBeNull();
  });

  test('any one agent granting it is enough', () => {
    const config = declarative([['OTHER_KEY'], 'all', ['BOUNDARY_TEST']]);
    expect(secretDeliveryBlockedReason('BOUNDARY_TEST', 'egress', config)).toBeNull();
  });

  test('a grant that excludes the identifier blocks delivery', () => {
    expect(
      secretDeliveryBlockedReason('BOUNDARY_TEST', 'egress', declarative([['OTHER_KEY']])),
    ).toBe('no_agent_grant');
  });

  test("'all' is not a grant for a non-runtime secret", () => {
    // strategy.ts withholds it as `agent_grant_unscoped` — the same outcome as
    // an absent list, which is exactly why 'all' cannot clear the block.
    expect(secretDeliveryBlockedReason('BOUNDARY_TEST', 'egress', declarative(['all']))).toBe(
      'no_agent_grant',
    );
  });

  test('an agent with no scope at all blocks delivery', () => {
    expect(secretDeliveryBlockedReason('BOUNDARY_TEST', 'egress', declarative([undefined]))).toBe(
      'no_agent_grant',
    );
  });

  test('a declarative config with zero agents is ambiguous, so it reports null', () => {
    // `resolveConfigAgents` only reaches 'declarative' with an empty list when the
    // manifest FAILED to parse (specs empty, errors present) or every agent is
    // disabled. Neither proves the absence of a grant, and warning on a manifest
    // we could not read is worse than not warning at all.
    expect(secretDeliveryBlockedReason('BOUNDARY_TEST', 'egress', declarative([]))).toBeNull();
  });

  test('broker secrets take the same rule as egress', () => {
    expect(secretDeliveryBlockedReason('BOUNDARY_TEST', 'broker', declarative([['OTHER']]))).toBe(
      'no_agent_grant',
    );
    expect(
      secretDeliveryBlockedReason('BOUNDARY_TEST', 'broker', declarative([['BOUNDARY_TEST']])),
    ).toBeNull();
  });

  test('runtime and denied secrets never carry the reason', () => {
    // A null grant delivers a runtime secret, and `denied` is a policy
    // statement about the secret, not about who may read it.
    expect(secretDeliveryBlockedReason('BOUNDARY_TEST', 'runtime', declarative([]))).toBeNull();
    expect(secretDeliveryBlockedReason('BOUNDARY_TEST', 'denied', declarative([]))).toBeNull();
  });

  // The commonest broken setup, and the one that sent a real user hunting for
  // hours: an egress secret on a project whose manifest declares no `agents:`.
  // `resolveConfigAgents` reports 'opencode' only when the manifest produced no
  // specs AND no errors, so this state is certain, not unknown.
  test('opencode discovery means no manifest grant exists, which is certain', () => {
    const config: SecretAgentGrantConfig = { agent_discovery: 'opencode', agents: [] };
    expect(secretDeliveryBlockedReason('BOUNDARY_TEST', 'egress', config)).toBe('no_agent_grant');
  });

  test('a native opencode agent does not rescue an egress secret', () => {
    // Grants come only from manifest specs. A discovered `.opencode/agent/*.md`
    // carries none, so it cannot make an egress secret deliverable.
    const config: SecretAgentGrantConfig = {
      agent_discovery: 'opencode',
      agents: [
        {
          name: 'build',
          description: null,
          mode: null,
          path: '.opencode/agent/build.md',
          source: 'opencode',
          enabled: true,
        },
      ],
    };
    expect(secretDeliveryBlockedReason('BOUNDARY_TEST', 'egress', config)).toBe('no_agent_grant');
  });

  test('runtime secrets are unaffected by opencode discovery', () => {
    const config: SecretAgentGrantConfig = { agent_discovery: 'opencode', agents: [] };
    expect(secretDeliveryBlockedReason('BOUNDARY_TEST', 'runtime', config)).toBeNull();
  });

  // A caller may hand over a config it only partly resolved. Reading `agents`
  // off it threw a TypeError and turned GET /secrets into a 500, so the shape is
  // checked rather than trusted.
  test.each([
    ['an empty object', {}],
    ['a missing agents array', { agent_discovery: 'declarative' }],
    ['a non-array agents field', { agent_discovery: 'declarative', agents: null }],
    ['an unknown discovery mode', { agent_discovery: 'something-else', agents: [] }],
  ])('survives %s and reports null', (_label, config) => {
    expect(
      secretDeliveryBlockedReason('BOUNDARY_TEST', 'egress', config as SecretAgentGrantConfig),
    ).toBeNull();
  });

  test('no config at all reports null', () => {
    expect(secretDeliveryBlockedReason('BOUNDARY_TEST', 'egress', null)).toBeNull();
    expect(secretDeliveryBlockedReason('BOUNDARY_TEST', 'egress', undefined)).toBeNull();
  });

  test('authorization is by IDENTIFIER, never by the env-var name', () => {
    // Two identifiers may share one name, so a grant naming the KEY authorizes
    // nothing. GMAPS-primary and GMAPS-backup are both GOOGLE_MAPS_API_KEY.
    expect(
      secretDeliveryBlockedReason('GMAPS-primary', 'egress', declarative([['GMAPS-primary']])),
    ).toBeNull();
    expect(
      secretDeliveryBlockedReason(
        'GMAPS-primary',
        'egress',
        declarative([['GOOGLE_MAPS_API_KEY']]),
      ),
    ).toBe('no_agent_grant');
  });
});

/**
 * `network_boundary_available` and `delivery_status` are what the web control
 * and the CLI read to decide whether this mode can be offered at all. Both are
 * computed from an OPTIONAL `projectMetadata` argument, so a caller that simply
 * forgot to pass the project still typechecks and silently reports the old
 * Platinum-only answer. That is exactly the regression these tests catch.
 */
describe('buildSecretView — the per-project boundary flag reaches the view', () => {
  const boundaryView = (projectMetadata?: unknown) =>
    buildSecretView({
      identifier: 'BOUNDARY_TEST',
      name: 'BOUNDARY_TEST',
      shared: secretRow(),
      canManageShared: true,
      agentGrants: declarative([['BOUNDARY_TEST']]),
      projectMetadata,
    });

  test('a project with the flag on reports boundary delivery available', () => {
    const view = boundaryView({ experimental: { network_boundary_shim: true } });
    expect(view.network_boundary_available).toBe(true);
    expect(view.delivery_status).toBe('available');
  });

  test('an omitted project cannot widen the gate', () => {
    // Without Platinum the answer must be the closed one — never a default-open
    // guess made on a caller's behalf.
    const view = boundaryView(undefined);
    expect(view.network_boundary_available).toBe(config.isPlatinumEnabled());
  });

  test('an explicit off is not read as "unset"', () => {
    const view = boundaryView({ experimental: { network_boundary_shim: false } });
    expect(view.network_boundary_available).toBe(config.isPlatinumEnabled());
  });
});

describe('buildSecretView — delivery_blocked_reason', () => {
  test('an ungranted egress secret is flagged while delivery_status stays available', () => {
    const view = buildSecretView({
      identifier: 'BOUNDARY_TEST',
      name: 'BOUNDARY_TEST',
      shared: secretRow(),
      canManageShared: true,
      agentGrants: declarative([['OTHER_KEY']]),
    });
    expect(view.delivery_blocked_reason).toBe('no_agent_grant');
    // The two axes are independent: 'available' still means "the deployment
    // supports this mode", which the CLI and the web chip both key off.
    expect(view.delivery_status).toBe(
      view.network_boundary_available ? 'available' : 'unavailable',
    );
  });

  test('a granted egress secret carries no reason', () => {
    const view = buildSecretView({
      identifier: 'BOUNDARY_TEST',
      name: 'BOUNDARY_TEST',
      shared: secretRow(),
      canManageShared: true,
      agentGrants: declarative([['BOUNDARY_TEST']]),
    });
    expect(view.delivery_blocked_reason).toBeNull();
  });

  test('the identifier decides, not the env-var key', () => {
    const shared = secretRow({ identifier: 'GMAPS-primary', name: 'GOOGLE_MAPS_API_KEY' });
    const byIdentifier = buildSecretView({
      identifier: 'GMAPS-primary',
      name: 'GOOGLE_MAPS_API_KEY',
      shared,
      canManageShared: true,
      agentGrants: declarative([['GMAPS-primary']]),
    });
    const byName = buildSecretView({
      identifier: 'GMAPS-primary',
      name: 'GOOGLE_MAPS_API_KEY',
      shared,
      canManageShared: true,
      agentGrants: declarative([['GOOGLE_MAPS_API_KEY']]),
    });
    expect(byIdentifier.delivery_blocked_reason).toBeNull();
    expect(byName.delivery_blocked_reason).toBe('no_agent_grant');
  });

  test('omitting agentGrants leaves every pre-existing field unchanged', () => {
    const shared = secretRow();
    const before = buildSecretView({
      identifier: 'BOUNDARY_TEST',
      name: 'BOUNDARY_TEST',
      shared,
      canManageShared: true,
    });
    const after = buildSecretView({
      identifier: 'BOUNDARY_TEST',
      name: 'BOUNDARY_TEST',
      shared,
      canManageShared: true,
      agentGrants: declarative([['OTHER_KEY']]),
    });
    expect(before.delivery_blocked_reason).toBeNull();
    const { delivery_blocked_reason: _omitted, ...beforeRest } = before;
    const { delivery_blocked_reason: _flagged, ...afterRest } = after;
    expect(beforeRest).toEqual(afterRest);
  });

  test('a runtime secret is never flagged, whatever the manifest grants', () => {
    const view = buildSecretView({
      identifier: 'PLAIN_KEY',
      name: 'PLAIN_KEY',
      shared: secretRow({
        identifier: 'PLAIN_KEY',
        name: 'PLAIN_KEY',
        strategy: 'runtime',
        consumer: 'sandbox',
        egressPolicy: null,
      }),
      canManageShared: true,
      agentGrants: declarative([['OTHER_KEY']]),
    });
    expect(view.delivery_blocked_reason).toBeNull();
    expect(view.delivery_status).toBe('available');
  });
});
