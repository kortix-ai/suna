import { describe, expect, test } from 'bun:test';
import { FEATURE_FLAG_KEYS } from '@kortix/api-contract';

import { config } from '../config';
import { FEATURE_DISABLED_CODE, featureDisabledBody } from '../feature-flags/gate';
import {
  REGISTERED_FEATURE_FLAGS,
  buildFeatureFlagCatalog,
  isFeatureFlagKey,
  resolveFeatureFlag,
  resolveFeatureFlags,
} from '../feature-flags/registry';

const STABILITIES = ['experimental', 'beta', 'stable'];
const ENFORCEMENTS = ['routes', 'behavioral', 'ui-only'];

function findCatalogFlag(key: string) {
  const flag = buildFeatureFlagCatalog({}).find((f) => f.key === key);
  if (!flag) throw new Error(`Missing feature flag: ${key}`);
  return flag;
}

describe('registry ↔ contract', () => {
  // Compared as sets: the registry's order is the Settings display order and is
  // deliberately independent of the contract schema's field order. Membership
  // is the invariant — a flag added to one side and not the other fails here.
  test('the catalog covers exactly the contract key list', () => {
    expect(
      buildFeatureFlagCatalog({})
        .map((f) => f.key)
        .sort(),
    ).toEqual([...FEATURE_FLAG_KEYS].sort());
  });

  test('every registered flag declares a complete, valid definition', () => {
    expect(REGISTERED_FEATURE_FLAGS.length).toBe(FEATURE_FLAG_KEYS.length);
    for (const def of REGISTERED_FEATURE_FLAGS) {
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
      expect(STABILITIES).toContain(def.stability);
      expect(ENFORCEMENTS).toContain(def.enforcement);
      // A flag the server deliberately does not enforce must say why, so
      // "the switch does nothing" is a reviewed decision, not silent drift.
      if (def.enforcement === 'ui-only') {
        expect(typeof def.enforcementNote).toBe('string');
        expect((def.enforcementNote ?? '').length).toBeGreaterThan(0);
      }
    }
  });
});

describe('isFeatureFlagKey', () => {
  test('accepts known keys, rejects others', () => {
    for (const key of FEATURE_FLAG_KEYS) {
      expect(isFeatureFlagKey(key)).toBe(true);
    }
    expect(isFeatureFlagKey('nope')).toBe(false);
    expect(isFeatureFlagKey(undefined)).toBe(false);
    expect(isFeatureFlagKey(null)).toBe(false);
    expect(isFeatureFlagKey(42)).toBe(false);
    // Prototype members are not keys — the lookup uses hasOwnProperty.
    expect(isFeatureFlagKey('toString')).toBe(false);
    expect(isFeatureFlagKey('constructor')).toBe(false);
  });
});

describe('resolveFeatureFlag — explicit override wins', () => {
  test('per-project map overrides the platform default', () => {
    expect(resolveFeatureFlag({ experimental: { review_center: true } }, 'review_center')).toBe(
      true,
    );
    expect(resolveFeatureFlag({ experimental: { review_center: false } }, 'review_center')).toBe(
      false,
    );
  });

  test('agent_tunnel respects an explicit choice but stays AND-gated on availability', () => {
    const available = findCatalogFlag('agent_tunnel').available;
    expect(resolveFeatureFlag({ experimental: { agent_tunnel: true } }, 'agent_tunnel')).toBe(
      available,
    );
    expect(resolveFeatureFlag({ experimental: { agent_tunnel: false } }, 'agent_tunnel')).toBe(
      false,
    );
  });

  test('agentmail_email is explicit opt-in', () => {
    expect(resolveFeatureFlag({}, 'agentmail_email')).toBe(false);
    expect(
      resolveFeatureFlag({ experimental: { agentmail_email: true } }, 'agentmail_email'),
    ).toBe(true);
    expect(
      resolveFeatureFlag({ experimental: { agentmail_email: false } }, 'agentmail_email'),
    ).toBe(false);
  });

  test('apps is a STABLE flag and still explicit opt-in', () => {
    // Apps is no longer labelled experimental on any surface. Stability is a
    // badge, not a gate: the flag stays off until a project opts in, exactly
    // as before. `experimental` here is the metadata STORAGE key, which the
    // registry pins as a stable storage detail.
    expect(resolveFeatureFlag({}, 'apps')).toBe(false);
    expect(resolveFeatureFlag({ experimental: { apps: true } }, 'apps')).toBe(true);
    expect(resolveFeatureFlag({ experimental: { apps: false } }, 'apps')).toBe(false);
    expect(findCatalogFlag('apps')).toMatchObject({
      name: 'Apps',
      stability: 'stable',
      available: true,
      enabled: false,
    });
  });

  test('monitors is explicit opt-in and gated on Platinum availability', () => {
    const available = Boolean(config.PLATINUM_API_KEY);
    expect(findCatalogFlag('monitors')).toMatchObject({
      name: 'Monitors',
      stability: 'experimental',
      available,
      enabled: false,
    });
    // Off by default everywhere; a project's explicit opt-in wins only where
    // the platform can actually run a persistent box (Platinum configured).
    expect(resolveFeatureFlag({}, 'monitors')).toBe(false);
    expect(resolveFeatureFlag({ experimental: { monitors: true } }, 'monitors')).toBe(available);
    expect(resolveFeatureFlag({ experimental: { monitors: false } }, 'monitors')).toBe(false);
  });

  test('marketplace defaults ON platform-wide and is turned off only explicitly', () => {
    expect(resolveFeatureFlag({}, 'marketplace')).toBe(true);
    expect(resolveFeatureFlag({ experimental: { marketplace: false } }, 'marketplace')).toBe(false);
  });

  test('teams is explicit opt-in and needs no operator env var', () => {
    expect(resolveFeatureFlag({}, 'teams')).toBe(false);
    expect(resolveFeatureFlag({ experimental: { teams: true } }, 'teams')).toBe(true);
    expect(resolveFeatureFlag({ experimental: { teams: false } }, 'teams')).toBe(false);
    // The channel is always listable — server bot credentials only decide
    // whether the MANAGED install path is offered, never whether a project may
    // hold an opinion (bring-your-own works without them).
    expect(findCatalogFlag('teams').available).toBe(true);
    expect(config).not.toHaveProperty('TEAMS_CHANNEL_ENABLED');
  });

  test('connectors_api_discover is explicit opt-in', () => {
    expect(resolveFeatureFlag({}, 'connectors_api_discover')).toBe(false);
    expect(
      resolveFeatureFlag(
        { experimental: { connectors_api_discover: true } },
        'connectors_api_discover',
      ),
    ).toBe(true);
    expect(
      resolveFeatureFlag(
        { experimental: { connectors_api_discover: false } },
        'connectors_api_discover',
      ),
    ).toBe(false);
  });

  test('llm_gateway is not a feature flag — gateway mode is the only session mode', () => {
    // A flag that selects a provider/runtime MODE is a broken branch, not a
    // flag. The registry must not carry it, so the PATCH route 400s it and the
    // catalog never emits a row for it. A stale stored override is inert:
    // resolveFeatureFlags iterates the registry, not the stored map.
    expect(REGISTERED_FEATURE_FLAGS.map((f) => f.key)).not.toContain('llm_gateway');
    expect(isFeatureFlagKey('llm_gateway')).toBe(false);
    expect(buildFeatureFlagCatalog({ experimental: { llm_gateway: true } }).map((f) => f.key)).not.toContain(
      'llm_gateway',
    );
    expect(resolveFeatureFlags({ experimental: { llm_gateway: false } })).not.toHaveProperty(
      'llm_gateway',
    );
    // The operator kill switch for /v1/llm is config, not a flag; flipping it
    // must not add or remove any catalog row.
    const previousEnabled = config.LLM_GATEWAY_ENABLED;
    try {
      config.LLM_GATEWAY_ENABLED = false;
      const offKeys = buildFeatureFlagCatalog({}).map((f) => f.key);
      config.LLM_GATEWAY_ENABLED = true;
      const onKeys = buildFeatureFlagCatalog({}).map((f) => f.key);
      expect(offKeys).toEqual(onKeys);
    } finally {
      config.LLM_GATEWAY_ENABLED = previousEnabled;
    }
  });

  test('non-boolean stored values are treated as "no override"', () => {
    for (const garbage of ['true', 1, 0, null, [], {}, 'yes']) {
      expect(resolveFeatureFlag({ experimental: { apps: garbage } }, 'apps')).toBe(
        resolveFeatureFlag({}, 'apps'),
      );
      expect(resolveFeatureFlag({ experimental: { marketplace: garbage } }, 'marketplace')).toBe(
        resolveFeatureFlag({}, 'marketplace'),
      );
    }
  });

  test('a malformed experimental subtree never throws', () => {
    for (const metadata of [null, undefined, {}, { experimental: null }, { experimental: 'x' }, []]) {
      expect(typeof resolveFeatureFlag(metadata, 'review_center')).toBe('boolean');
      expect(typeof resolveFeatureFlag(metadata, 'marketplace')).toBe('boolean');
      expect(typeof resolveFeatureFlag(metadata, 'agent_tunnel')).toBe('boolean');
    }
  });
});

describe('resolveFeatureFlags', () => {
  test('returns a boolean for every registered key', () => {
    const map = resolveFeatureFlags({ experimental: { review_center: true } });
    expect(Object.keys(map).sort()).toEqual([...FEATURE_FLAG_KEYS].sort());
    for (const key of FEATURE_FLAG_KEYS) {
      expect(typeof map[key]).toBe('boolean');
    }
    expect(map.review_center).toBe(true);
  });
});

describe('buildFeatureFlagCatalog', () => {
  test('describes each flag with effective + overridden state', () => {
    const catalog = buildFeatureFlagCatalog({ experimental: { review_center: true } });

    const reviewCenter = catalog.find((f) => f.key === 'review_center');
    if (!reviewCenter) throw new Error('Missing Review Center flag');
    expect(reviewCenter.name).toBeTruthy();
    expect(reviewCenter.description).toBeTruthy();
    expect(reviewCenter.enabled).toBe(true);
    expect(reviewCenter.overridden).toBe(true);
    expect(typeof reviewCenter.available).toBe('boolean');

    const teams = catalog.find((f) => f.key === 'teams');
    if (!teams) throw new Error('Missing Microsoft Teams flag');
    expect(teams.name).toBe('Microsoft Teams');
    expect(teams.stability).toBe('experimental');
    expect(teams.enabled).toBe(false);
    expect(teams.overridden).toBe(false);

    const tunnel = catalog.find((f) => f.key === 'agent_tunnel');
    if (!tunnel) throw new Error('Missing Agent Computer Tunnel flag');
    expect(tunnel.overridden).toBe(false);
  });

  test('an unavailable flag is never enabled', () => {
    const everythingOn = Object.fromEntries(FEATURE_FLAG_KEYS.map((key) => [key, true]));
    for (const f of buildFeatureFlagCatalog({ experimental: everythingOn })) {
      if (!f.available) expect(f.enabled).toBe(false);
    }
  });
});

describe('featureDisabledBody', () => {
  test('carries the machine-readable code, the flag key, and points at Settings', () => {
    for (const key of FEATURE_FLAG_KEYS) {
      const body = featureDisabledBody(key);
      expect(body.code).toBe(FEATURE_DISABLED_CODE);
      expect(body.code).toBe('feature_disabled');
      expect(body.feature).toBe(key);
      expect(typeof body.error).toBe('string');
      expect(body.error).toContain('Settings');
    }
  });
});
