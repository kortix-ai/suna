/**
 * The `config_releases` flag resolution (docs/specs/config-releases.md,
 * "Feature flag"): default ON, an explicit project override wins, and the
 * operator kill switch beats both.
 */
import { describe, expect, test } from 'bun:test';
import { config } from '../config';
import { buildFeatureFlagCatalog, featureFlagDef } from '../feature-flags/registry';
import { CONFIG_RELEASES_FLAG, configReleasesEnabled } from './enabled';

describe('config_releases flag', () => {
  test('is ON for a project that made no choice', () => {
    expect(configReleasesEnabled({})).toBe(true);
    expect(configReleasesEnabled(null)).toBe(true);
    expect(configReleasesEnabled({ experimental: {} })).toBe(true);
  });

  test('an explicit project override wins in both directions', () => {
    expect(configReleasesEnabled({ experimental: { config_releases: false } })).toBe(false);
    expect(configReleasesEnabled({ experimental: { config_releases: true } })).toBe(true);
  });

  test('the operator kill switch forces off even when the project enabled it', () => {
    const def = featureFlagDef(CONFIG_RELEASES_FLAG);
    const original = config.CONFIG_RELEASES_ENABLED;
    try {
      (config as { CONFIG_RELEASES_ENABLED: boolean }).CONFIG_RELEASES_ENABLED = false;
      expect(def.available()).toBe(false);
      expect(configReleasesEnabled({ experimental: { config_releases: true } })).toBe(false);
      expect(configReleasesEnabled({})).toBe(false);
      // The Settings row disappears with it.
      const view = buildFeatureFlagCatalog({ experimental: { config_releases: true } }).find(
        (f) => f.key === CONFIG_RELEASES_FLAG,
      );
      expect(view).toMatchObject({ available: false, enabled: false });
    } finally {
      (config as { CONFIG_RELEASES_ENABLED: boolean }).CONFIG_RELEASES_ENABLED = original;
    }
  });

  test('the registry entry declares the flag ON by default and names its kill switch', () => {
    const def = featureFlagDef(CONFIG_RELEASES_FLAG);
    expect(def.platformDefault()).toBe(true);
    expect(def.stability).toBe('experimental');
    expect(def.enforcement).toBe('routes');
    expect(def.enforcementNote).toContain('feature_disabled');
  });
});
