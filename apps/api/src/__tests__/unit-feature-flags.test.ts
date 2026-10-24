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

const STABILITIES = ['experimental', 'beta', 'stable'];
const ENFORCEMENTS = ['routes', 'behavioral', 'ui-only'];

function findCatalogFlag(key: string) {
  const flag = buildFeatureFlagCatalog({}).find((f) => f.key === key);
  if (!flag) throw new Error(`Missing feature flag: ${key}`);
  return flag;
}

/** Registered but deliberately not offered as a toggle — see "Hidden flags" in
 *  the registry header. */
// Flags derived from the project's Volumes flag are hidden too, but are not
// choices of their own: they are covered by integration-volumes-feature-flag.test.ts.
const HIDDEN_KEYS = REGISTERED_FEATURE_FLAGS.filter((f) => f.catalogHidden && !f.derivedFrom).map((f) => f.key);

describe('registry ↔ contract', () => {
  // Compared as sets: the registry's order is the Settings display order and is
  // deliberately independent of the contract schema's field order. Membership
  // is the invariant — a flag added to one side and not the other fails here.
  test('the catalog covers exactly the contract key list, minus hidden flags that are off', () => {
    expect(
      buildFeatureFlagCatalog({})
        .map((f) => f.key)
        .sort(),
    ).toEqual(
      [...FEATURE_FLAG_KEYS]
        .filter((key) => {
          const def = REGISTERED_FEATURE_FLAGS.find((f) => f.key === key);
          // A hidden flag is listed (read-only) only while it resolves on.
          return !def?.derivedFrom && (!def?.catalogHidden || resolveFeatureFlag({}, key));
        })
        .sort(),
    );
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

  test('warm sessions require explicit opt-in before spending idle compute', () => {
    for (const metadata of [undefined, null, {}, { experimental: {} }, { experimental: { warm_sessions: 'true' } }]) {
      expect(resolveFeatureFlag(metadata, 'warm_sessions')).toBe(false);
    }
    expect(resolveFeatureFlags({}).warm_sessions).toBe(false);
    expect(findCatalogFlag('warm_sessions')).toMatchObject({
      available: true,
      enabled: false,
      overridden: false,
    });
    expect(resolveFeatureFlag({ experimental: { warm_sessions: true } }, 'warm_sessions')).toBe(true);
    expect(resolveFeatureFlag({ experimental: { warm_sessions: false } }, 'warm_sessions')).toBe(false);
  });

  test('email_channel is an explicit opt-in', () => {
    // The Resend inbox channel ships behind its own flag; the retired
    // `agentmail_email` key stays graduated and inert.
    expect(resolveFeatureFlag({}, 'email_channel')).toBe(false);
    expect(resolveFeatureFlag({ experimental: { email_channel: true } }, 'email_channel')).toBe(true);
    expect(findCatalogFlag('email_channel')).toMatchObject({ stability: 'experimental', enabled: false });
  });

  test('agentmail_email graduated: every project can connect email and a stored override is inert', () => {
    // 2026-10-24: the email channel is on for every project. Turning it on
    // never created an inbox (only an explicit connect does), so graduating
    // provisions nothing. A stored `experimental.agentmail_email` stays in
    // metadata; it must not resurface as a key, a catalog row, or a gate.
    expect(isFeatureFlagKey('agentmail_email')).toBe(false);
    const metadata = { experimental: { agentmail_email: false } };
    expect(Object.keys(resolveFeatureFlags(metadata))).not.toContain('agentmail_email');
    expect(buildFeatureFlagCatalog(metadata).map((flag) => flag.key)).not.toContain('agentmail_email');
  });

  test('apps graduated: Apps is generally available and a stored override is inert', () => {
    // Apps went GA (2026-10-14, spec §28): every project can create and deploy
    // Apps — no flag, no Settings row, no operator lever, no 403. A project
    // that stored `experimental.apps` while it was a flag keeps the value in
    // metadata; it must not resurface as a key, a catalog row, or a gate.
    expect(isFeatureFlagKey('apps')).toBe(false);
    const metadata = { experimental: { apps: false } };
    expect(Object.keys(resolveFeatureFlags(metadata))).not.toContain('apps');
    expect(buildFeatureFlagCatalog(metadata).map((flag) => flag.key)).not.toContain('apps');
  });

  test('llm_gateway graduated: the gateway is the only model path and a stored override is inert', () => {
    // 2026-10-20: no flag, no native OpenCode provider mode, no operator lever.
    // A project that stored `experimental.llm_gateway` keeps the value in
    // metadata; it must not resurface as a key or a catalog row.
    expect(isFeatureFlagKey('llm_gateway')).toBe(false);
    const metadata = { experimental: { llm_gateway: false } };
    expect(Object.keys(resolveFeatureFlags(metadata))).not.toContain('llm_gateway');
    expect(buildFeatureFlagCatalog(metadata).map((flag) => flag.key)).not.toContain('llm_gateway');
  });

  test('event_triggers is a beta flag, on by default everywhere, that a project can turn off', () => {
    expect(findCatalogFlag('event_triggers')).toMatchObject({
      name: 'Connector event triggers',
      stability: 'beta',
      enabled: true,
      operator_only: false,
    });
    const def = REGISTERED_FEATURE_FLAGS.find((f) => f.key === 'event_triggers')!;
    expect(def.enforcement).toBe('routes');
    expect(def.available()).toBe(true);
    expect(def.platformDefault()).toBe(true);
    expect(resolveFeatureFlag({}, 'event_triggers')).toBe(true);
    expect(resolveFeatureFlag({ experimental: { event_triggers: true } }, 'event_triggers')).toBe(true);
    expect(resolveFeatureFlag({ experimental: { event_triggers: false } }, 'event_triggers')).toBe(false);
  });

  test('connectors_v2 and connectors_api_discover graduated: one catalog for every project, a stored override is inert', () => {
    // 2026-10-24: the Kortix catalog (MCP apps, integrations.sh, Composio) is the
    // only connectors path. Projects that stored either key keep the value in
    // metadata; it must not resurface as a key, a catalog row, or a gate.
    for (const key of ['connectors_v2', 'connectors_api_discover']) {
      expect(isFeatureFlagKey(key)).toBe(false);
      const metadata = { experimental: { [key]: false } };
      expect(Object.keys(resolveFeatureFlags(metadata))).not.toContain(key);
      expect(buildFeatureFlagCatalog(metadata).map((flag) => flag.key)).not.toContain(key);
    }
  });

  test('project_channels is an experimental, explicit opt-in flag offered everywhere', () => {
    expect(findCatalogFlag('project_channels')).toMatchObject({
      stability: 'experimental',
      enabled: false,
      operator_only: false,
    });
    expect(resolveFeatureFlag({}, 'project_channels')).toBe(false);
    expect(resolveFeatureFlag({ experimental: { project_channels: true } }, 'project_channels')).toBe(true);
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


  test('session_log_restore follows the deployment default while a stored project value wins', () => {
    const previous = config.SESSION_LOG_RESTORE_DEFAULT_ENABLED;
    try {
      config.SESSION_LOG_RESTORE_DEFAULT_ENABLED = false;
      expect(resolveFeatureFlag({}, 'session_log_restore')).toBe(false);
      expect(resolveFeatureFlag({ experimental: { session_log_restore: true } }, 'session_log_restore')).toBe(true);

      config.SESSION_LOG_RESTORE_DEFAULT_ENABLED = true;
      expect(resolveFeatureFlag({}, 'session_log_restore')).toBe(true);
      expect(resolveFeatureFlag({ experimental: { session_log_restore: false } }, 'session_log_restore')).toBe(false);
    } finally {
      config.SESSION_LOG_RESTORE_DEFAULT_ENABLED = previous;
    }
  });

  test('non-boolean stored values are treated as "no override"', () => {
    for (const garbage of ['true', 1, 0, null, [], {}, 'yes']) {
      expect(resolveFeatureFlag({ experimental: { marketplace: garbage } }, 'marketplace')).toBe(
        resolveFeatureFlag({}, 'marketplace'),
      );
    }
  });

  test('a malformed experimental subtree never throws', () => {
    for (const metadata of [null, undefined, {}, { experimental: null }, { experimental: 'x' }, []]) {
      expect(typeof resolveFeatureFlag(metadata, 'meta_agent')).toBe('boolean');
      expect(typeof resolveFeatureFlag(metadata, 'marketplace')).toBe('boolean');
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
  test('only internal-only surfaces are hidden: session_log_restore (the boot restore from the session log) and workspace_volume (stateless sandboxes)', () => {
    // `apps` graduated (2026-10-14) and `session_log` (2026-10-22): neither is a flag.
    expect(HIDDEN_KEYS).toEqual(['session_log_restore', 'workspace_volume']);
  });

  test('workspace_volume is a behavioral flag that defaults off and needs Platinum', () => {
    const def = REGISTERED_FEATURE_FLAGS.find((f) => f.key === 'workspace_volume');
    expect(def?.enforcement).toBe('behavioral');
    expect(resolveFeatureFlag({}, 'workspace_volume')).toBe(false);
  });

  test('session_log_restore is a behavioral flag that defaults off', () => {
    const def = REGISTERED_FEATURE_FLAGS.find((f) => f.key === 'session_log_restore');
    expect(def?.enforcement).toBe('behavioral');
    expect(resolveFeatureFlag({}, 'session_log_restore')).toBe(false);
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
      if (!resolveFeatureFlag({}, key)) expect(buildFeatureFlagCatalog({}).map((f) => f.key)).not.toContain(key);
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

  test('every offered flag is a project flag writable by project admins (operator_only false); a hidden flag that is on is listed read-only', () => {
    for (const f of buildFeatureFlagCatalog({})) {
      expect(f.scope).toBe('project');
      const hidden = HIDDEN_KEYS.includes(f.key);
      expect(f.operator_only).toBe(hidden);
      expect(isOperatorOnlyFeatureFlag(f.key)).toBe(hidden);
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
      // A flag derived from Volumes points at the Volumes toggle, and a hidden
      // flag has no toggle in Settings to point at. No message names an organization.
      const derived = REGISTERED_FEATURE_FLAGS.find((f) => f.key === key)?.derivedFrom;
      expect(body.error).toContain(derived ? 'Turn on Volumes' : HIDDEN_KEYS.includes(key) ? 'Contact Kortix' : 'Settings');
      expect(body.error).not.toContain('organization');
    }
  });
});
