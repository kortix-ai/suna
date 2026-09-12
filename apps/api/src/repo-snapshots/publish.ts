/**
 * Publish a built snapshot to S3.
 *
 * Order is load-bearing: the archive is uploaded and verified BEFORE the
 * manifest exists. A manifest is therefore a promise that the payload it names
 * is already durable, which is what makes a crash between the two steps safe —
 * the retry re-uploads identical bytes under the same digest-named key and
 * publishes the manifest afterwards.
 *
 * Both objects are written with `If-None-Match: *`. A concurrent publisher that
 * loses the race reads the winner and validates it instead of overwriting it;
 * an already-ready mapping is never replaced.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { logger } from '../lib/logger';
import {
  type RepoSnapshotIdentity,
  type RepoSnapshotManifest,
  assertManifestMatchesIdentity,
  manifestKey,
  parseRepoSnapshotManifest,
  serializeRepoSnapshotManifest,
} from './format';
import {
  type RepoSnapshotBucket,
  S3RequestError,
  s3GetObjectText,
  s3HeadObject,
  s3PutObject,
} from './s3';

export const REPO_SNAPSHOT_MANIFEST_CONTENT_TYPE = 'application/json';
export const REPO_SNAPSHOT_ARCHIVE_CONTENT_TYPE = 'application/octet-stream';

export class RepoSnapshotPublishConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoSnapshotPublishConflictError';
  }
}

export interface PublishedRepoSnapshot {
  manifest: RepoSnapshotManifest;
  manifestKey: string;
  /** True when this call wrote the manifest, false when it adopted a winner. */
  created: boolean;
}

/**
 * Upload the archive unless an object with the same digest-named key is already
 * there. The key IS the content digest, so an existing object of the same
 * length is by construction the same bytes — re-uploading buys nothing and a
 * conditional create makes the race explicit.
 */
async function ensureArchiveUploaded(
  bucket: RepoSnapshotBucket,
  manifest: RepoSnapshotManifest,
  archivePath: string,
): Promise<'created' | 'present'> {
  const existing = await s3HeadObject(bucket, manifest.payload.key);
  if (existing && existing.contentLength === manifest.payload.compressed_bytes) return 'present';
  const body = await readFile(archivePath);
  const digest = createHash('sha256').update(body).digest('hex');
  if (digest !== manifest.payload.sha256) {
    // The archive changed on disk between hashing and upload.
    throw new Error('snapshot archive digest changed before upload');
  }
  try {
    await s3PutObject(bucket, manifest.payload.key, body, {
      contentType: REPO_SNAPSHOT_ARCHIVE_CONTENT_TYPE,
      ifNoneMatch: true,
    });
    return 'created';
  } catch (error) {
    if (error instanceof S3RequestError && error.preconditionFailed) return 'present';
    throw error;
  }
}

/**
 * Read back a manifest another publisher wrote and prove it describes the same
 * revision. A winner that disagrees is a genuine identity failure — a
 * repository whose owner/name was reused, or a producer bug — and must never be
 * silently adopted.
 */
async function adoptExistingManifest(
  bucket: RepoSnapshotBucket,
  key: string,
  identity: RepoSnapshotIdentity,
): Promise<RepoSnapshotManifest> {
  const raw = await s3GetObjectText(bucket, key);
  const winner = parseRepoSnapshotManifest(raw);
  assertManifestMatchesIdentity(winner, identity);
  const payload = await s3HeadObject(bucket, winner.payload.key);
  if (!payload) {
    throw new RepoSnapshotPublishConflictError(
      'published manifest names a payload that is not in the bucket',
    );
  }
  return winner;
}

export async function publishRepoSnapshot(input: {
  bucket: RepoSnapshotBucket;
  identity: RepoSnapshotIdentity;
  manifest: RepoSnapshotManifest;
  archivePath: string;
}): Promise<PublishedRepoSnapshot> {
  const { bucket, identity, manifest } = input;
  assertManifestMatchesIdentity(manifest, identity);
  const key = manifestKey(identity);

  const archive = await ensureArchiveUploaded(bucket, manifest, input.archivePath);
  const document = serializeRepoSnapshotManifest(manifest);
  try {
    await s3PutObject(bucket, key, Buffer.from(document, 'utf8'), {
      contentType: REPO_SNAPSHOT_MANIFEST_CONTENT_TYPE,
      ifNoneMatch: true,
    });
    logger.info('[repo-snapshot] published', {
      repositoryId: identity.repositoryId,
      commitSha: identity.commitSha,
      archive,
      compressedBytes: manifest.payload.compressed_bytes,
    });
    return { manifest, manifestKey: key, created: true };
  } catch (error) {
    if (!(error instanceof S3RequestError) || !error.preconditionFailed) throw error;
    const winner = await adoptExistingManifest(bucket, key, identity);
    logger.info('[repo-snapshot] adopted concurrent publication', {
      repositoryId: identity.repositoryId,
      commitSha: identity.commitSha,
      sha256: winner.payload.sha256,
    });
    return { manifest: winner, manifestKey: key, created: false };
  }
}

/** Read a published manifest, or null when the revision was never published. */
export async function readPublishedManifest(
  bucket: RepoSnapshotBucket,
  identity: RepoSnapshotIdentity,
): Promise<RepoSnapshotManifest | null> {
  try {
    return await adoptExistingManifest(bucket, manifestKey(identity), identity);
  } catch (error) {
    if (error instanceof S3RequestError && error.notFound) return null;
    throw error;
  }
}
