/**
 * Hermetic unit tests for the project snapshot producer's pure pieces: the
 * immutable object layout, ref normalization, manifest parsing, retry
 * schedule, and the per-project mode override. Storage and DB are covered by
 * `__tests__/integration-project-snapshot.test.ts` against real MinIO + Postgres.
 */
import { describe, expect, test } from 'bun:test';
import { config } from '../config';
import {
  PROJECT_SNAPSHOT_MAX_ATTEMPTS,
  normalizeSnapshotRef,
  parseManifest,
  projectSnapshotRetryDelayMs,
  resolveProjectSnapshotMode,
} from './project-snapshot';
import {
  PROJECT_SNAPSHOT_FORMAT,
  projectSnapshotBlobsKey,
  projectSnapshotManifestKey,
  projectSnapshotObjectPrefix,
  projectSnapshotTreeKey,
} from './project-snapshot-store';

const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const DIGEST2 = 'c'.repeat(64);

describe('object layout', () => {
  test('is <owner>/<repo>/<sha>/<external-id>/project-snapshot-v2/ with a tree object and a blob pack', () => {
    const prefix = projectSnapshotObjectPrefix({ owner: 'kortix-ai', name: 'suna', externalId: '424242' }, SHA);
    expect(prefix).toBe(`kortix-ai/suna/${SHA}/424242/project-snapshot-v2/`);
    expect(projectSnapshotTreeKey(prefix, DIGEST)).toBe(`${prefix}${DIGEST}.tree.tar.gz`);
    expect(projectSnapshotBlobsKey(prefix, DIGEST2)).toBe(`${prefix}${DIGEST2}.blobs.pack`);
    expect(projectSnapshotManifestKey(prefix)).toBe(`${prefix}manifest.json`);
  });

  test('applies the configured bucket prefix once, normalized', () => {
    const before = config.KORTIX_PROJECT_SNAPSHOT_S3_PREFIX;
    try {
      (config as { KORTIX_PROJECT_SNAPSHOT_S3_PREFIX: string }).KORTIX_PROJECT_SNAPSHOT_S3_PREFIX = '/dev//';
      expect(projectSnapshotObjectPrefix({ owner: 'o', name: 'r', externalId: 'kortix-p1' }, SHA)).toBe(
        `dev/o/r/${SHA}/kortix-p1/project-snapshot-v2/`,
      );
    } finally {
      (config as { KORTIX_PROJECT_SNAPSHOT_S3_PREFIX: string }).KORTIX_PROJECT_SNAPSHOT_S3_PREFIX = before;
    }
  });

  test('refuses segments that would break out of the layout', () => {
    expect(() => projectSnapshotObjectPrefix({ owner: '..', name: 'r', externalId: '1' }, SHA)).toThrow();
    expect(() => projectSnapshotObjectPrefix({ owner: 'o/x', name: 'r', externalId: '1' }, SHA)).toThrow();
    expect(() => projectSnapshotObjectPrefix({ owner: 'o', name: 'r', externalId: '1' }, 'not-a-sha')).toThrow();
    expect(() => projectSnapshotTreeKey('p/', 'zz')).toThrow();
    expect(() => projectSnapshotBlobsKey('p/', 'zz')).toThrow();
  });
});

describe('ref normalization', () => {
  test('main and refs/heads/main are one identity', () => {
    expect(normalizeSnapshotRef('main')).toBe('main');
    expect(normalizeSnapshotRef('refs/heads/main')).toBe('main');
    expect(normalizeSnapshotRef(' refs/heads/release/2026 ')).toBe('release/2026');
  });
});

describe('manifest parsing', () => {
  const manifest = {
    format: PROJECT_SNAPSHOT_FORMAT,
    repository: { owner: 'o', name: 'r', external_id: '1' },
    ref: 'main',
    commit_sha: SHA,
    tree: { key: `o/r/${SHA}/1/project-snapshot-v2/${DIGEST}.tree.tar.gz`, sha256: DIGEST, bytes: 12, entries: 3 },
    blobs: { key: `o/r/${SHA}/1/project-snapshot-v2/${DIGEST2}.blobs.pack`, sha256: DIGEST2, bytes: 7 },
  };

  test('accepts a manifest for the expected commit', () => {
    const parsed = parseManifest(JSON.stringify(manifest), SHA);
    expect(parsed.tree.sha256).toBe(DIGEST);
    expect(parsed.blobs.sha256).toBe(DIGEST2);
  });

  test('rejects another commit, a bad digest, a missing object, an older format, or garbage', () => {
    expect(() => parseManifest(JSON.stringify(manifest), 'c'.repeat(40))).toThrow(/does not describe/);
    expect(() => parseManifest(JSON.stringify({ ...manifest, tree: { ...manifest.tree, sha256: 'xx' } }), SHA)).toThrow();
    expect(() => parseManifest(JSON.stringify({ ...manifest, blobs: undefined }), SHA)).toThrow(/does not describe/);
    expect(() => parseManifest(JSON.stringify({ ...manifest, format: 'project-snapshot-v1' }), SHA)).toThrow(/does not describe/);
    expect(() => parseManifest('{', SHA)).toThrow(/valid JSON/);
  });
});

describe('retry schedule', () => {
  test('backs off exponentially from 30s and caps at one hour', () => {
    expect(projectSnapshotRetryDelayMs(1)).toBe(30_000);
    expect(projectSnapshotRetryDelayMs(2)).toBe(60_000);
    expect(projectSnapshotRetryDelayMs(3)).toBe(120_000);
    expect(projectSnapshotRetryDelayMs(20)).toBe(3_600_000);
    expect(PROJECT_SNAPSHOT_MAX_ATTEMPTS).toBe(5);
  });
});

describe('mode resolution', () => {
  test('platform env by default, per-project metadata override wins, garbage ignored', () => {
    expect(resolveProjectSnapshotMode({})).toBe(config.KORTIX_PROJECT_SNAPSHOT_MODE);
    expect(resolveProjectSnapshotMode(null)).toBe(config.KORTIX_PROJECT_SNAPSHOT_MODE);
    expect(resolveProjectSnapshotMode({ project_snapshot_mode: 'require-s3' })).toBe('require-s3');
    expect(resolveProjectSnapshotMode({ project_snapshot_mode: 'git' })).toBe('git');
    expect(resolveProjectSnapshotMode({ project_snapshot_mode: 'bogus' })).toBe(config.KORTIX_PROJECT_SNAPSHOT_MODE);
  });
});
