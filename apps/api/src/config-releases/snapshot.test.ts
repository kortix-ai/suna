import { describe, expect, test } from 'bun:test';
import { configReleaseSnapshot, type ConfigReleaseSnapshotDeps } from './snapshot';

const PROJECT = { projectId: '11111111-1111-4111-8111-111111111111', repoUrl: 'https://example.invalid/repo.git' };
const COMMIT = 'c'.repeat(40);
const READY = {
  snapshotId: 's',
  projectId: PROJECT.projectId,
  ref: 'main',
  commitSha: COMMIT,
  repository: { owner: 'o', name: 'r', externalId: 'x' },
  objectPrefix: 'o/r/c/x/project-snapshot-v2/',
  archiveSha256: 'a'.repeat(64),
  archiveBytes: 40 * 1024 * 1024,
  entryCount: 12,
  blobsSha256: 'b'.repeat(64),
  blobsBytes: 1,
  readyAt: new Date(0),
};

function deps(overrides: Partial<ConfigReleaseSnapshotDeps> = {}) {
  const enqueued: unknown[] = [];
  const presigned: string[] = [];
  const value: ConfigReleaseSnapshotDeps = {
    configured: () => true,
    readReady: async () => READY,
    enqueue: async (input) => {
      enqueued.push(input);
      return 'queued';
    },
    presign: async (key) => {
      presigned.push(key);
      return { url: `https://bucket.invalid/${key}?X-Amz-Signature=s`, expiresAt: new Date('2026-10-08T12:15:00Z') };
    },
    ...overrides,
  };
  return { value, enqueued, presigned };
}

describe('configReleaseSnapshot', () => {
  test('a ready snapshot is presigned for its boot object only', async () => {
    const d = deps();
    const snapshot = await configReleaseSnapshot(PROJECT, 'main', COMMIT, d.value);
    expect(snapshot).toEqual({
      url: `https://bucket.invalid/${READY.objectPrefix}${READY.archiveSha256}.tree.tar.gz?X-Amz-Signature=s`,
      sha256: READY.archiveSha256,
      bytes: READY.archiveBytes,
      entries: 12,
      expires_at: '2026-10-08T12:15:00.000Z',
    });
    expect(d.presigned).toEqual([`${READY.objectPrefix}${READY.archiveSha256}.tree.tar.gz`]);
    expect(d.enqueued).toEqual([]);
  });

  test('a commit with no ready snapshot is queued, and the descriptor carries none', async () => {
    const d = deps({ readReady: async () => null });
    expect(await configReleaseSnapshot(PROJECT, 'main', COMMIT, d.value)).toBeNull();
    expect(d.enqueued).toEqual([{ projectId: PROJECT.projectId, ref: 'main', commitSha: COMMIT, repoUrl: PROJECT.repoUrl }]);
  });

  test('no snapshot storage: no lookup, no snapshot', async () => {
    const d = deps({
      configured: () => false,
      readReady: async () => {
        throw new Error('must not be read');
      },
    });
    expect(await configReleaseSnapshot(PROJECT, 'main', COMMIT, d.value)).toBeNull();
  });

  test('a lookup or signing failure leaves the box its other sources', async () => {
    const d = deps({
      presign: async () => {
        throw new Error('no credentials');
      },
    });
    expect(await configReleaseSnapshot(PROJECT, 'main', COMMIT, d.value)).toBeNull();
  });
});
