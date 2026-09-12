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
  projectSnapshotArchiveKey,
  projectSnapshotManifestKey,
  projectSnapshotObjectPrefix,
} from './project-snapshot-store';

const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);

describe('object layout', () => {
  test('is <owner>/<repo>/<sha>/<external-id>/project-snapshot-v1/', () => {
    const prefix = projectSnapshotObjectPrefix({ owner: 'kortix-ai', name: 'suna', externalId: '424242' }, SHA);
    expect(prefix).toBe(`kortix-ai/suna/${SHA}/424242/project-snapshot-v1/`);
    expect(projectSnapshotArchiveKey(prefix, DIGEST)).toBe(`${prefix}${DIGEST}.tar.gz`);
    expect(projectSnapshotManifestKey(prefix)).toBe(`${prefix}manifest.json`);
  });

  test('applies the configured bucket prefix once, normalized', () => {
    const before = config.KORTIX_PROJECT_SNAPSHOT_S3_PREFIX;
    try {
      (config as { KORTIX_PROJECT_SNAPSHOT_S3_PREFIX: string }).KORTIX_PROJECT_SNAPSHOT_S3_PREFIX = '/dev//';
      expect(projectSnapshotObjectPrefix({ owner: 'o', name: 'r', externalId: 'kortix-p1' }, SHA)).toBe(
        `dev/o/r/${SHA}/kortix-p1/project-snapshot-v1/`,
      );
    } finally {
      (config as { KORTIX_PROJECT_SNAPSHOT_S3_PREFIX: string }).KORTIX_PROJECT_SNAPSHOT_S3_PREFIX = before;
    }
  });

  test('refuses segments that would break out of the layout', () => {
    expect(() => projectSnapshotObjectPrefix({ owner: '..', name: 'r', externalId: '1' }, SHA)).toThrow();
    expect(() => projectSnapshotObjectPrefix({ owner: 'o/x', name: 'r', externalId: '1' }, SHA)).toThrow();
    expect(() => projectSnapshotObjectPrefix({ owner: 'o', name: 'r', externalId: '1' }, 'not-a-sha')).toThrow();
    expect(() => projectSnapshotArchiveKey('p/', 'zz')).toThrow();
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
    archive: { key: `o/r/${SHA}/1/project-snapshot-v1/${DIGEST}.tar.gz`, sha256: DIGEST, bytes: 12, entries: 3 },
  };

  test('accepts a manifest for the expected commit', () => {
    expect(parseManifest(JSON.stringify(manifest), SHA).archive.sha256).toBe(DIGEST);
  });

  test('rejects another commit, a bad digest, or garbage', () => {
    expect(() => parseManifest(JSON.stringify(manifest), 'c'.repeat(40))).toThrow(/does not describe/);
    expect(() => parseManifest(JSON.stringify({ ...manifest, archive: { ...manifest.archive, sha256: 'xx' } }), SHA)).toThrow();
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
