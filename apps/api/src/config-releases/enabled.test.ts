/**
 * The `config_releases` flag resolution (docs/specs/config-releases.md,
 * "Feature flag"): default ON, an explicit project override wins, and the
 * operator kill switch beats both.
 */
import { describe, expect, test } from 'bun:test';
import { config } from '../config';
import { buildFeatureFlagCatalog, featureFlagDef } from '../feature-flags/registry';
import { projectSnapshotStorageConfigured } from '../git-proxy/project-snapshot-store';
import { CONFIG_RELEASES_FLAG, configReleasesEnabled } from './enabled';
import { configArchiveStorageConfigured } from './store';

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

describe('config-release storage is decoupled from the snapshot producer', () => {
  test('naming a config archive bucket never starts the project-snapshot producer', () => {
    // The two features share ONE object store implementation and may share one
    // physical bucket, but they read SEPARATE settings on purpose: the
    // snapshot bucket setting is what gates the producer worker
    // (git-proxy/project-snapshot-worker.ts), so sharing it would start the
    // leader worker in every environment that only wants config archives.
    const asMutable = config as unknown as Record<string, string>;
    const snapshotBucket = asMutable.KORTIX_PROJECT_SNAPSHOT_S3_BUCKET;
    const configBucket = asMutable.KORTIX_CONFIG_ARCHIVE_S3_BUCKET;
    try {
      asMutable.KORTIX_PROJECT_SNAPSHOT_S3_BUCKET = '';
      asMutable.KORTIX_CONFIG_ARCHIVE_S3_BUCKET = 'kortix-config-releases';
      expect(configArchiveStorageConfigured()).toBe(true);
      expect(projectSnapshotStorageConfigured()).toBe(false);
    } finally {
      asMutable.KORTIX_PROJECT_SNAPSHOT_S3_BUCKET = snapshotBucket;
      asMutable.KORTIX_CONFIG_ARCHIVE_S3_BUCKET = configBucket;
    }
  });
});
