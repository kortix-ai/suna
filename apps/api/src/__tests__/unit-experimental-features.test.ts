import { describe, expect, test } from 'bun:test';

import {
  resolveExperimentalFeature,
  resolveExperimentalFeatures,
  buildExperimentalCatalog,
  applyExperimentalOverride,
  isExperimentalFeatureKey,
  EXPERIMENTAL_FEATURE_KEYS,
} from '../experimental/features';

describe('isExperimentalFeatureKey', () => {
  test('accepts known keys, rejects others', () => {
    expect(isExperimentalFeatureKey('apps')).toBe(true);
    expect(isExperimentalFeatureKey('agent_tunnel')).toBe(true);
    expect(isExperimentalFeatureKey('nope')).toBe(false);
    expect(isExperimentalFeatureKey(undefined)).toBe(false);
    expect(isExperimentalFeatureKey(42)).toBe(false);
  });
});

describe('resolveExperimentalFeature — explicit override wins', () => {
  test('per-project experimental map overrides the default', () => {
    expect(resolveExperimentalFeature({ experimental: { apps: true } }, 'apps')).toBe(true);
    expect(resolveExperimentalFeature({ experimental: { apps: false } }, 'apps')).toBe(false);
  });

  test('legacy top-level apps_enabled is honored for apps', () => {
    expect(resolveExperimentalFeature({ apps_enabled: true }, 'apps')).toBe(true);
    expect(resolveExperimentalFeature({ apps_enabled: false }, 'apps')).toBe(false);
  });

  test('experimental map takes precedence over the legacy field', () => {
    expect(
      resolveExperimentalFeature({ apps_enabled: false, experimental: { apps: true } }, 'apps'),
    ).toBe(true);
  });

  test('agent_tunnel respects explicit per-project choice', () => {
    expect(resolveExperimentalFeature({ experimental: { agent_tunnel: true } }, 'agent_tunnel')).toBe(true);
    expect(resolveExperimentalFeature({ experimental: { agent_tunnel: false } }, 'agent_tunnel')).toBe(false);
  });

  test('null/empty metadata falls back to the operator default (no throw)', () => {
    expect(typeof resolveExperimentalFeature(null, 'apps')).toBe('boolean');
    expect(typeof resolveExperimentalFeature(undefined, 'agent_tunnel')).toBe('boolean');
    expect(typeof resolveExperimentalFeature({}, 'apps')).toBe('boolean');
  });
});

describe('resolveExperimentalFeatures', () => {
  test('returns an entry for every registered key', () => {
    const map = resolveExperimentalFeatures({ experimental: { apps: true } });
    for (const key of EXPERIMENTAL_FEATURE_KEYS) {
      expect(typeof map[key]).toBe('boolean');
    }
    expect(map.apps).toBe(true);
  });
});

describe('buildExperimentalCatalog', () => {
  test('describes each feature with effective + overridden flags', () => {
    const catalog = buildExperimentalCatalog({ experimental: { apps: true } });
    expect(catalog.length).toBe(EXPERIMENTAL_FEATURE_KEYS.length);

    const apps = catalog.find((f) => f.key === 'apps')!;
    expect(apps.name).toBeTruthy();
    expect(apps.description).toBeTruthy();
    expect(apps.enabled).toBe(true);
    expect(apps.overridden).toBe(true);
    expect(typeof apps.available).toBe('boolean');

    const tunnel = catalog.find((f) => f.key === 'agent_tunnel')!;
    expect(tunnel.overridden).toBe(false); // no explicit choice made
  });

  test('an unavailable feature is never enabled', () => {
    // We can only assert the invariant relative to availability.
    for (const f of buildExperimentalCatalog({ experimental: { apps: true, agent_tunnel: true } })) {
      if (!f.available) expect(f.enabled).toBe(false);
    }
  });
});

describe('applyExperimentalOverride', () => {
  test('sets a boolean into metadata.experimental', () => {
    const next = applyExperimentalOverride({}, 'agent_tunnel', true);
    expect(next).toEqual({ experimental: { agent_tunnel: true } });
  });

  test('merges with existing overrides without clobbering', () => {
    const next = applyExperimentalOverride(
      { experimental: { apps: true }, name: 'keep-me' },
      'agent_tunnel',
      false,
    );
    expect(next.experimental).toEqual({ apps: true, agent_tunnel: false });
    expect(next.name).toBe('keep-me');
  });

  test('null clears the override; empty map is removed', () => {
    const next = applyExperimentalOverride({ experimental: { apps: true } }, 'apps', null);
    expect(next.experimental).toBeUndefined();
  });

  test('clears the legacy apps_enabled mirror when writing apps', () => {
    const next = applyExperimentalOverride({ apps_enabled: true }, 'apps', false);
    expect((next as Record<string, unknown>).apps_enabled).toBeUndefined();
    expect(next.experimental).toEqual({ apps: false });
  });

  test('writing apps:null also drops legacy apps_enabled', () => {
    const next = applyExperimentalOverride({ apps_enabled: true }, 'apps', null);
    expect((next as Record<string, unknown>).apps_enabled).toBeUndefined();
    expect(next.experimental).toBeUndefined();
  });
});
