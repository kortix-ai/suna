import { describe, expect, mock, test } from 'bun:test';
import { config } from '../config';
import { PROJECT_SNAPSHOT_FORMAT } from './project-snapshot-store';

const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const DIGEST2 = 'c'.repeat(64);

describe('session snapshot pin', () => {
  test('returns the ready archive pin and encoded descriptor without waiting for object verification', async () => {
    const bucket = config.KORTIX_PROJECT_SNAPSHOT_S3_BUCKET;
    const row = {
      snapshotId: 'snapshot-test', projectId: 'project-test', ref: 'main', commitSha: SHA,
      repoOwner: 'owner', repoName: 'repo', externalRepoId: 'repo-test',
      status: 'ready', format: PROJECT_SNAPSHOT_FORMAT,
      objectPrefix: `owner/repo/${SHA}/repo-test/${PROJECT_SNAPSHOT_FORMAT}/`,
      archiveSha256: DIGEST, archiveBytes: 12, entryCount: 3,
      blobsSha256: DIGEST2, blobsBytes: 7, readyAt: new Date('2026-01-01T00:00:00Z'),
    };
    const select = mock(() => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }));
    const head = mock(() => new Promise<null>(() => {}));
    const expiresAt = new Date('2026-01-01T01:00:00Z');
    const presign = mock(async (key: string) => ({ url: `https://example.invalid/${key}`, expiresAt }));
    mock.module('../shared/db', () => ({ db: { select } }));
    mock.module('./project-snapshot-store', () => ({
      PROJECT_SNAPSHOT_FORMAT,
      projectSnapshotStorageConfigured: () => Boolean(config.KORTIX_PROJECT_SNAPSHOT_S3_BUCKET.trim()),
      headObject: head,
      presignProjectSnapshotDownload: presign,
    }));
    const { resolveProjectSnapshotPinForSession } = await import('./project-snapshot-ledger');
    const input = { projectId: row.projectId, ref: row.ref, commitSha: SHA, repoUrl: 'https://example.invalid/owner/repo' };
    try {
      (config as { KORTIX_PROJECT_SNAPSHOT_S3_BUCKET: string }).KORTIX_PROJECT_SNAPSHOT_S3_BUCKET = 'test-bucket';
      const result = await resolveProjectSnapshotPinForSession(input);
      expect(result.cache).toBe('hit');
      expect(result.pin).toBe(`${SHA}:${DIGEST}:12`);
      expect(JSON.parse(Buffer.from(result.descriptor!, 'base64').toString())).toEqual({
        format: PROJECT_SNAPSHOT_FORMAT, commit_sha: SHA, ref: 'main',
        repository: { owner: 'owner', name: 'repo', external_id: 'repo-test' },
        tree: { url: `https://example.invalid/${row.objectPrefix}${DIGEST}.tree.tar.gz`, sha256: DIGEST, bytes: 12, entries: 3, expires_at: expiresAt.toISOString() },
        blobs: { url: `https://example.invalid/${row.objectPrefix}${DIGEST2}.blobs.pack`, sha256: DIGEST2, bytes: 7, expires_at: expiresAt.toISOString() },
      });
      expect(select).toHaveBeenCalledTimes(1);
      expect(presign).toHaveBeenCalledTimes(2);
      expect(head).toHaveBeenCalledTimes(2);

      select.mockClear();
      (config as { KORTIX_PROJECT_SNAPSHOT_S3_BUCKET: string }).KORTIX_PROJECT_SNAPSHOT_S3_BUCKET = '';
      expect(await resolveProjectSnapshotPinForSession(input)).toEqual({ pin: null, descriptor: null, cache: 'unconfigured' });
      (config as { KORTIX_PROJECT_SNAPSHOT_S3_BUCKET: string }).KORTIX_PROJECT_SNAPSHOT_S3_BUCKET = 'test-bucket';
      expect(await resolveProjectSnapshotPinForSession({ ...input, commitSha: undefined })).toEqual({ pin: null, descriptor: null, cache: 'no-sha' });
      expect(await resolveProjectSnapshotPinForSession({ ...input, commitSha: 'invalid' })).toEqual({ pin: null, descriptor: null, cache: 'no-sha' });
      expect(select).not.toHaveBeenCalled();
    } finally {
      (config as { KORTIX_PROJECT_SNAPSHOT_S3_BUCKET: string }).KORTIX_PROJECT_SNAPSHOT_S3_BUCKET = bucket;
      mock.restore();
    }
  });
});
