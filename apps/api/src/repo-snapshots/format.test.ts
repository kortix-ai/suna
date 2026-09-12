import { describe, expect, test } from 'bun:test';
import {
  REPO_SNAPSHOT_FORMAT,
  RepoSnapshotIdentityError,
  RepoSnapshotManifestError,
  archiveExtension,
  assertManifestMatchesIdentity,
  manifestKey,
  normalizeRepoSnapshotIdentity,
  parseRepoSnapshotManifest,
  payloadKey,
  serializeRepoSnapshotManifest,
  snapshotPrefix,
  type RepoSnapshotManifest,
} from './format';

const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);

function identity(overrides: Record<string, unknown> = {}) {
  return normalizeRepoSnapshotIdentity({
    repositoryId: '1296269',
    owner: 'octocat',
    repo: 'Hello-World',
    commitSha: SHA,
    ...overrides,
  });
}

function manifest(): RepoSnapshotManifest {
  const id = identity();
  return {
    format: REPO_SNAPSHOT_FORMAT,
    source: {
      provider: 'github',
      repository_id: id.repositoryId,
      owner: id.owner,
      repo: id.repo,
      commit_sha: id.commitSha,
      tree_sha: 'c'.repeat(40),
    },
    payload: {
      key: payloadKey(id, DIGEST, 'gzip'),
      compression: 'gzip',
      sha256: DIGEST,
      compressed_bytes: 10,
      expanded_bytes: 20,
      entry_count: 3,
    },
    checkout: { git_metadata: 'sanitized-shallow', layout_version: 1 },
    producer_version: 'test/1',
  };
}

describe('identity normalization', () => {
  test('lowercases owner/repo, strips .git, and keeps the numeric repository id', () => {
    const id = identity({ owner: 'OctoCat', repo: 'Hello-World.git' });
    expect(id).toEqual({
      provider: 'github',
      repositoryId: '1296269',
      owner: 'octocat',
      repo: 'hello-world',
      commitSha: SHA,
    });
  });

  test('rejects anything that could forge a key', () => {
    expect(() => identity({ repositoryId: 'abc' })).toThrow(RepoSnapshotIdentityError);
    expect(() => identity({ repositoryId: '' })).toThrow(RepoSnapshotIdentityError);
    expect(() => identity({ owner: '../etc' })).toThrow(RepoSnapshotIdentityError);
    expect(() => identity({ repo: '..' })).toThrow(RepoSnapshotIdentityError);
    expect(() => identity({ repo: 'a/b' })).toThrow(RepoSnapshotIdentityError);
    expect(() => identity({ commitSha: 'main' })).toThrow(RepoSnapshotIdentityError);
    expect(() => identity({ commitSha: SHA.slice(0, 39) })).toThrow(RepoSnapshotIdentityError);
    expect(() => identity({ provider: 'gitlab' })).toThrow(RepoSnapshotIdentityError);
  });
});

describe('object layout', () => {
  test('keeps the requested key components in order', () => {
    const id = identity();
    expect(snapshotPrefix(id)).toBe(`octocat/hello-world/${SHA}/1296269/project-snapshot-v1/`);
    expect(manifestKey(id)).toBe(`${snapshotPrefix(id)}manifest.json`);
    expect(payloadKey(id, DIGEST, 'gzip')).toBe(`${snapshotPrefix(id)}${DIGEST}.tar.gz`);
    expect(payloadKey(id, DIGEST, 'zstd')).toBe(`${snapshotPrefix(id)}${DIGEST}.tar.zst`);
  });

  test('the repository id suffix separates two repositories that reused one name', () => {
    const first = manifestKey(identity({ repositoryId: '111' }));
    const second = manifestKey(identity({ repositoryId: '222' }));
    expect(first).not.toBe(second);
  });

  test('the extension always matches the declared codec', () => {
    expect(archiveExtension('gzip')).toBe('tar.gz');
    expect(archiveExtension('zstd')).toBe('tar.zst');
  });
});

describe('manifest validation', () => {
  test('round-trips canonical bytes', () => {
    const document = serializeRepoSnapshotManifest(manifest());
    expect(document.endsWith('\n')).toBe(true);
    expect(parseRepoSnapshotManifest(document)).toEqual(manifest());
    // Canonical: serializing twice produces identical bytes.
    expect(serializeRepoSnapshotManifest(parseRepoSnapshotManifest(document))).toBe(document);
  });

  test('rejects a payload key that does not match its own identity', () => {
    const doc = manifest();
    doc.payload.key = `octocat/hello-world/${SHA}/999/project-snapshot-v1/${DIGEST}.tar.gz`;
    expect(() => parseRepoSnapshotManifest(JSON.stringify(doc))).toThrow(RepoSnapshotManifestError);
  });

  test('rejects unsupported format, codec, layout and malformed digests', () => {
    const base = manifest();
    expect(() => parseRepoSnapshotManifest(JSON.stringify({ ...base, format: 'other' }))).toThrow();
    expect(() =>
      parseRepoSnapshotManifest(JSON.stringify({ ...base, payload: { ...base.payload, compression: 'lz4' } })),
    ).toThrow();
    expect(() =>
      parseRepoSnapshotManifest(
        JSON.stringify({ ...base, checkout: { git_metadata: 'full', layout_version: 1 } }),
      ),
    ).toThrow();
    expect(() =>
      parseRepoSnapshotManifest(
        JSON.stringify({ ...base, checkout: { git_metadata: 'sanitized-shallow', layout_version: 2 } }),
      ),
    ).toThrow();
    expect(() =>
      parseRepoSnapshotManifest(JSON.stringify({ ...base, payload: { ...base.payload, sha256: 'nope' } })),
    ).toThrow();
    expect(() => parseRepoSnapshotManifest('not json')).toThrow(RepoSnapshotManifestError);
    expect(() => parseRepoSnapshotManifest(null)).toThrow(RepoSnapshotManifestError);
  });

  test('carries no project id, timestamp or branch mapping', () => {
    const document = serializeRepoSnapshotManifest(manifest());
    expect(document).not.toMatch(/project_id|session|branch|created_at|expires/i);
  });

  test('binds a manifest to the revision that was asked for', () => {
    const id = identity();
    expect(() => assertManifestMatchesIdentity(manifest(), id)).not.toThrow();
    expect(() => assertManifestMatchesIdentity(manifest(), identity({ repositoryId: '999' }))).toThrow(
      /identity/i,
    );
    expect(() =>
      assertManifestMatchesIdentity(manifest(), identity({ commitSha: 'd'.repeat(40) })),
    ).toThrow(/identity/i);
  });
});
