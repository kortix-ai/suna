/**
 * Config-release storage settings: the archive bucket is its own setting,
 * apart from the project-snapshot bucket.
 */
import { describe, expect, test } from 'bun:test';
import { config } from '../config';
import { projectSnapshotStorageConfigured } from '../git-proxy/project-snapshot-store';

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
      expect(projectSnapshotStorageConfigured()).toBe(false);
    } finally {
      asMutable.KORTIX_PROJECT_SNAPSHOT_S3_BUCKET = snapshotBucket;
      asMutable.KORTIX_CONFIG_ARCHIVE_S3_BUCKET = configBucket;
    }
  });
});
