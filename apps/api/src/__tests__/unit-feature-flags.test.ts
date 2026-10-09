import { describe, expect, test } from 'bun:test';
import { FEATURE_FLAG_KEYS } from '@kortix/api-contract';

import { config } from '../config';
import { FEATURE_DISABLED_CODE, featureDisabledBody } from '../feature-flags/gate';
import {
  REGISTERED_FEATURE_FLAGS,
  buildFeatureFlagCatalog,
  isFeatureFlagKey,
  isOperatorOnlyFeatureFlag,
  resolveFeatureFlag,
  resolveFeatureFlags,
} from '../feature-flags/registry';
import { projectLlmGatewayEnabled } from '../llm-gateway/enablement';

const STABILITIES = ['experimental', 'beta', 'stable'];
const ENFORCEMENTS = ['routes', 'behavioral', 'ui-only'];

function findCatalogFlag(key: string) {
  const flag = buildFeatureFlagCatalog({}).find((f) => f.key === key);
  if (!flag) throw new Error(`Missing feature flag: ${key}`);
  return flag;
}

/** Registered but deliberately not offered as a toggle — see "Hidden flags" in
 *  the registry header. */
const HIDDEN_KEYS = REGISTERED_FEATURE_FLAGS.filter((f) => f.catalogHidden).map((f) => f.key);

describe('registry ↔ contract', () => {
  // Compared as sets: the registry's order is the Settings display order and is
  // deliberately independent of the contract schema's field order. Membership
  // is the invariant — a flag added to one side and not the other fails here.
  test('the catalog covers exactly the contract key list, minus hidden flags', () => {
    expect(
      buildFeatureFlagCatalog({})
        .map((f) => f.key)
        .sort(),
    ).toEqual([...FEATURE_FLAG_KEYS].filter((key) => !HIDDEN_KEYS.includes(key)).sort());
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
    expect(resolveFeatureFlag({ experimental: { meta_agent: true } }, 'meta_agent')).toBe(true);
    expect(resolveFeatureFlag({ experimental: { meta_agent: false } }, 'meta_agent')).toBe(false);
  });

  test('agent_principal graduated: no flag, and a stored override is inert', () => {
    // A governed agent always authorizes as itself (spec 2026-09-22 §5): the
    // one-release escape hatch back to the launcher model is gone.
    expect(isFeatureFlagKey('agent_principal')).toBe(false);
    const metadata = { experimental: { agent_principal: false } };
    expect(Object.keys(resolveFeatureFlags(metadata))).not.toContain('agent_principal');
  });

  test('agent_tunnel graduated: computers need no flag and a stored override is inert', () => {
    expect(isFeatureFlagKey('agent_tunnel')).toBe(false);
    const metadata = { experimental: { agent_tunnel: false } };
    expect(Object.keys(resolveFeatureFlags(metadata))).not.toContain('agent_tunnel');
    expect(buildFeatureFlagCatalog(metadata).map((flag) => flag.key)).not.toContain('agent_tunnel');
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
    // Internal-only since 2026-10-06: resolvable, never offered in Settings.
    expect(REGISTERED_FEATURE_FLAGS.find((f) => f.key === 'apps')).toMatchObject({
      name: 'Apps',
      stability: 'stable',
      catalogHidden: true,
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

  test('session_transcript_history graduated: saved history has no off switch and a stored override is inert', () => {
    // Saved history is how web, mobile and the CLI show a session while its
    // computer is off. Projects that stored `false` keep theirs too.
    expect(isFeatureFlagKey('session_transcript_history')).toBe(false);
    const metadata = { experimental: { session_transcript_history: false } };
    expect(Object.keys(resolveFeatureFlags(metadata))).not.toContain('session_transcript_history');
    expect(buildFeatureFlagCatalog(metadata).map((flag) => flag.key)).not.toContain(
      'session_transcript_history',
    );
  });

  test('marketplace defaults ON platform-wide and is turned off only explicitly', () => {
    expect(resolveFeatureFlag({}, 'marketplace')).toBe(true);
    expect(resolveFeatureFlag({ experimental: { marketplace: false } }, 'marketplace')).toBe(false);
  });

  test('teams graduated: every project can connect Teams and a stored override is inert', () => {
    // Projects that turned Teams on or off while it was a flag keep the value
    // in metadata. It must not resurface as a key, a catalog row, or a gate.
    expect(isFeatureFlagKey('teams')).toBe(false);
    const metadata = { experimental: { teams: false } };
    expect(Object.keys(resolveFeatureFlags(metadata))).not.toContain('teams');
    expect(buildFeatureFlagCatalog(metadata).map((flag) => flag.key)).not.toContain('teams');
    expect(config).not.toHaveProperty('TEAMS_CHANNEL_ENABLED');
  });

  test('config_releases graduated: every session runs a config release and a stored override is inert', () => {
    // A project that turned config releases on or off while they were a flag
    // keeps the value in metadata. It must not resurface as a key, a catalog
    // row, or a gate: a stored `false` no longer sends a session back to its
    // workspace config dir.
    expect(isFeatureFlagKey('config_releases')).toBe(false);
    const metadata = { experimental: { config_releases: false } };
    expect(Object.keys(resolveFeatureFlags(metadata))).not.toContain('config_releases');
    expect(buildFeatureFlagCatalog(metadata).map((flag) => flag.key)).not.toContain('config_releases');
  });

  test('connectors_api_discover requires explicit opt-in', () => {
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

  test('llm_gateway is platform-gated and follows the fleet default', () => {
    const available = findCatalogFlag('llm_gateway').available;
    expect(resolveFeatureFlag({}, 'llm_gateway')).toBe(
      available && config.LLM_GATEWAY_DEFAULT_ENABLED,
    );
    expect(resolveFeatureFlag({ experimental: { llm_gateway: true } }, 'llm_gateway')).toBe(
      available,
    );
    expect(resolveFeatureFlag({ experimental: { llm_gateway: false } }, 'llm_gateway')).toBe(false);
    expect(projectLlmGatewayEnabled({ experimental: { llm_gateway: true } })).toBe(available);
  });

  test('llm_gateway fleet default rolls all projects on while the kill switch and project-off override still win', () => {
    const previousEnabled = config.LLM_GATEWAY_ENABLED;
    const previousDefault = config.LLM_GATEWAY_DEFAULT_ENABLED;
    try {
      config.LLM_GATEWAY_ENABLED = false;
      config.LLM_GATEWAY_DEFAULT_ENABLED = true;
      expect(resolveFeatureFlag({}, 'llm_gateway')).toBe(false);
      expect(projectLlmGatewayEnabled({})).toBe(false);

      config.LLM_GATEWAY_ENABLED = true;
      config.LLM_GATEWAY_DEFAULT_ENABLED = false;
      expect(resolveFeatureFlag({}, 'llm_gateway')).toBe(false);

      config.LLM_GATEWAY_DEFAULT_ENABLED = true;
      expect(resolveFeatureFlag({}, 'llm_gateway')).toBe(true);
      expect(projectLlmGatewayEnabled({})).toBe(true);
      expect(resolveFeatureFlag({ experimental: { llm_gateway: false } }, 'llm_gateway')).toBe(
        false,
      );
      expect(projectLlmGatewayEnabled({ experimental: { llm_gateway: false } })).toBe(false);

      // The kill switch also beats an explicit project ON.
      config.LLM_GATEWAY_ENABLED = false;
      expect(resolveFeatureFlag({ experimental: { llm_gateway: true } }, 'llm_gateway')).toBe(
        false,
      );
    } finally {
      config.LLM_GATEWAY_ENABLED = previousEnabled;
      config.LLM_GATEWAY_DEFAULT_ENABLED = previousDefault;
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
      expect(typeof resolveFeatureFlag(metadata, 'meta_agent')).toBe('boolean');
      expect(typeof resolveFeatureFlag(metadata, 'marketplace')).toBe('boolean');
      expect(typeof resolveFeatureFlag(metadata, 'agentmail_email')).toBe('boolean');
    }
  });
});

describe('resolveFeatureFlags', () => {
  test('returns a boolean for every registered key', () => {
    const map = resolveFeatureFlags({ experimental: { meta_agent: true } });
    expect(Object.keys(map).sort()).toEqual([...FEATURE_FLAG_KEYS].sort());
    for (const key of FEATURE_FLAG_KEYS) {
      expect(typeof map[key]).toBe('boolean');
    }
    expect(map.meta_agent).toBe(true);
  });

  test('a stored override for a graduated key is inert', () => {
    // Review Center graduated out of the flag system. Projects that toggled it
    // before graduation still carry `experimental.review_center` in metadata.
    // That value must not resurface as a key, a catalog row, or a gate.
    const metadata = { experimental: { review_center: false, meta_agent: true } };
    expect(isFeatureFlagKey('review_center')).toBe(false);
    expect(Object.keys(resolveFeatureFlags(metadata)).sort()).toEqual([...FEATURE_FLAG_KEYS].sort());
    expect(buildFeatureFlagCatalog(metadata).map((flag) => flag.key)).not.toContain('review_center');
    expect(resolveFeatureFlags(metadata).meta_agent).toBe(true);
  });
});

describe('buildFeatureFlagCatalog', () => {
  test('describes each flag with effective + overridden state', () => {
    const catalog = buildFeatureFlagCatalog({ experimental: { meta_agent: true } });

    const metaAgent = catalog.find((f) => f.key === 'meta_agent');
    if (!metaAgent) throw new Error('Missing Meta Agent flag');
    expect(metaAgent.name).toBeTruthy();
    expect(metaAgent.description).toBeTruthy();
    expect(metaAgent.enabled).toBe(true);
    expect(metaAgent.overridden).toBe(true);
    expect(typeof metaAgent.available).toBe('boolean');

    const email = catalog.find((f) => f.key === 'agentmail_email');
    if (!email) throw new Error('Missing AgentMail Email flag');
    expect(email.name).toBe('AgentMail Email');
    expect(email.stability).toBe('experimental');
    expect(email.enabled).toBe(false);
    expect(email.overridden).toBe(false);
  });

  test('an unavailable flag is never enabled', () => {
    const everythingOn = Object.fromEntries(FEATURE_FLAG_KEYS.map((key) => [key, true]));
    for (const f of buildFeatureFlagCatalog({ experimental: everythingOn })) {
      if (!f.available) expect(f.enabled).toBe(false);
    }
  });
});

/**
 * A hidden flag is RESOLVABLE but UNADVERTISED (registry header, "Hidden
 * flags"). The four properties below are the whole contract, and each one is a
 * different way to get it wrong: `available: () => false` would break (a);
 * dropping the entry from FLAGS would break (b); listing it while off would
 * break (c); hiding it while on would break (c2) and leave agents blind to an
 * enabled surface; filtering `isFeatureFlagKey` through the catalog would
 * break (d) and take the operator lever with it.
 */
describe('catalogHidden', () => {
  test('only the internal-only surface is hidden: apps (it gates every App kind)', () => {
    expect(HIDDEN_KEYS).toEqual(['apps']);
  });

  for (const key of HIDDEN_KEYS) {
    const def = REGISTERED_FEATURE_FLAGS.find((f) => f.key === key);
    if (!def) throw new Error(`Missing registered flag: ${key}`);

    test(`${key}: (a) still resolves to its platform default`, () => {
      // Hidden means "not offered", never "forced off".
      expect(resolveFeatureFlag({}, key)).toBe(def.available() && def.platformDefault());
      expect(resolveFeatureFlags({})[key]).toBe(resolveFeatureFlag({}, key));
    });

    test(`${key}: (b) still honours an explicit project override`, () => {
      expect(resolveFeatureFlag({ experimental: { [key]: false } }, key)).toBe(false);
      expect(resolveFeatureFlag({ experimental: { [key]: true } }, key)).toBe(def.available());
    });

    test(`${key}: (c) is absent from the catalog while off`, () => {
      // An overridden-off hidden flag must not reappear as a row someone can flip.
      expect(buildFeatureFlagCatalog({}).map((f) => f.key)).not.toContain(key);
      expect(buildFeatureFlagCatalog({ experimental: { [key]: false } }).map((f) => f.key)).not.toContain(key);
    });

    test(`${key}: (c2) is listed read-only (operator_only) while on, so agents see it`, () => {
      const row = buildFeatureFlagCatalog({ experimental: { [key]: true } }).find((f) => f.key === key);
      if (!def.available()) {
        // Unavailable on this host: it resolves off, so it stays unlisted.
        expect(row).toBeUndefined();
        return;
      }
      expect(row).toMatchObject({ key, enabled: true, overridden: true, operator_only: true });
    });

    test(`${key}: (d) is a known key, writable only by a platform operator`, () => {
      // The route validates the body with `isFeatureFlagKey`, then refuses an
      // operator-only flag to anyone but a platform operator
      // (project-settings.ts patchFeatureFlagHandler). Flows APP-CVX-1 and
      // AGP-3 cover the HTTP round trip.
      expect(isFeatureFlagKey(key)).toBe(true);
      expect(isOperatorOnlyFeatureFlag(key)).toBe(true);
    });
  }

  test('every offered flag is writable by project admins (operator_only false)', () => {
    for (const f of buildFeatureFlagCatalog({})) {
      expect(f.operator_only).toBe(false);
      expect(isOperatorOnlyFeatureFlag(f.key)).toBe(false);
    }
  });
});

describe('featureDisabledBody', () => {
  test('carries the machine-readable code and the flag key; points at Settings, or at Kortix for a hidden flag', () => {
    for (const key of FEATURE_FLAG_KEYS) {
      const body = featureDisabledBody(key);
      expect(body.code).toBe(FEATURE_DISABLED_CODE);
      expect(body.code).toBe('feature_disabled');
      expect(body.feature).toBe(key);
      expect(typeof body.error).toBe('string');
      // A hidden flag has no toggle in Settings to point at.
      expect(body.error).toContain(HIDDEN_KEYS.includes(key) ? 'Contact Kortix' : 'Settings');
    }
  });
});
