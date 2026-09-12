import { describe, expect, test } from 'bun:test';
import { serializeBootDescriptor, snapshotSessionEnv } from './descriptor';

const descriptor = {
  url: 'https://bucket.s3.us-east-1.amazonaws.com/o/r/sha/1/project-snapshot-v1/d.tar.gz?X-Amz-Signature=secret',
  delivery: 'presigned' as const,
  auth: 'none' as const,
  expiresAt: new Date('2026-09-12T12:00:00.000Z'),
  sha256: 'd'.repeat(64),
  compression: 'gzip' as const,
  commitSha: 'a'.repeat(40),
  repositoryId: '1296269',
  compressedBytes: 1234,
  expandedBytes: 5678,
  entryCount: 42,
};

describe('boot descriptor', () => {
  test('proxy delivery asks the sandbox for a bearer; presigned never does', async () => {
    const { serializeBootDescriptor: serialize, snapshotSessionEnv: envFor } = await import('./descriptor');
    const proxied = { ...descriptor, delivery: 'proxy' as const, auth: 'bearer' as const };
    expect(serialize(proxied)).toMatchObject({ delivery: 'proxy', auth: 'bearer' });
    expect(envFor('prefer', proxied).KORTIX_REPO_SNAPSHOT_AUTH).toBe('bearer');
    expect(serialize(descriptor)).toMatchObject({ delivery: 'presigned', auth: 'none' });
  });

  test('serializes every field the sandbox verifies, and no bucket name', () => {
    const body = serializeBootDescriptor(descriptor);
    expect(body).toMatchObject({
      format: 'kortix.project-snapshot.v1',
      sha256: descriptor.sha256,
      compression: 'gzip',
      commit_sha: descriptor.commitSha,
      repository_id: descriptor.repositoryId,
      compressed_bytes: 1234,
      expanded_bytes: 5678,
      entry_count: 42,
      expires_at: '2026-09-12T12:00:00.000Z',
    });
    expect(Object.keys(body)).not.toContain('bucket');
    expect(Object.keys(body)).not.toContain('key');
  });

  test('session env is empty when the feature is off or nothing is pinned', () => {
    expect(snapshotSessionEnv('off', descriptor)).toEqual({});
    expect(snapshotSessionEnv('prefer', null)).toEqual({});
  });

  test('session env carries the mode and the pinned revision', () => {
    const env = snapshotSessionEnv('required', descriptor);
    expect(env.KORTIX_REPO_SNAPSHOT_MODE).toBe('required');
    expect(env.KORTIX_REPO_SNAPSHOT_COMMIT_SHA).toBe(descriptor.commitSha);
    expect(env.KORTIX_REPO_SNAPSHOT_SHA256).toBe(descriptor.sha256);
    expect(env.KORTIX_REPO_SNAPSHOT_ENTRY_COUNT).toBe('42');
    // Object storage never receives the Kortix session token.
    expect(env.KORTIX_REPO_SNAPSHOT_AUTH).toBe('none');
    // Every numeric bound reaches the sandbox as a string; the daemon coerces.
    expect(typeof env.KORTIX_REPO_SNAPSHOT_COMPRESSED_BYTES).toBe('string');
  });
});
