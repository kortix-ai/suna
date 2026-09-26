/**
 * Object storage for prebuilt project snapshot archives (the S3 config
 * provider's producer side).
 *
 * This module owns the snapshot LAYOUT and its settings. Every byte it moves
 * goes through the API's one object store (`../object-store/s3.ts`), which
 * owns the S3 client, credentials, signing, presigning and publish-once
 * semantics. There is no second way to put an object.
 *
 * Layout (immutable, content-addressed archive under a revision-addressed
 * prefix — see `projectSnapshotObjectPrefix`):
 *
 *   <prefix><owner>/<repo>/<full-commit-sha>/<external-repo-id>/project-snapshot-v1/
 *     manifest.json
 *     <archive-sha256>.tar.gz
 *
 * Publication order is archive first, manifest second, both publish-once, so
 * a concurrent producer never overwrites a published object and a reader
 * never sees a manifest whose archive is still uploading.
 */
import type { S3Client } from '@aws-sdk/client-s3';
import { config } from '../config';
import { ObjectStore, type ObjectBody, type PutOutcome, resolvePresignTarget } from '../object-store/s3';

export { resolvePresignTarget };
export type { PutOutcome };

export const PROJECT_SNAPSHOT_FORMAT = 'project-snapshot-v2';
export const PROJECT_SNAPSHOT_MANIFEST_NAME = 'manifest.json';
export const PROJECT_SNAPSHOT_ARCHIVE_CONTENT_TYPE = 'application/gzip';
export const PROJECT_SNAPSHOT_BLOBS_CONTENT_TYPE = 'application/x-git-pack';

export interface ProjectSnapshotRepository {
  owner: string;
  name: string;
  /** Provider repository id from the git connection, else `kortix-<projectId>`. */
  externalId: string;
}

export interface ProjectSnapshotManifest {
  format: typeof PROJECT_SNAPSHOT_FORMAT;
  repository: { owner: string; name: string; external_id: string };
  ref: string;
  commit_sha: string;
  tree: {
    key: string;
    sha256: string;
    bytes: number;
    entries: number;
    container: 'tar';
    compression: 'gzip';
    content_type: typeof PROJECT_SNAPSHOT_ARCHIVE_CONTENT_TYPE;
  };
  blobs: {
    key: string;
    sha256: string;
    bytes: number;
    container: 'git-pack';
    content_type: typeof PROJECT_SNAPSHOT_BLOBS_CONTENT_TYPE;
  };
  limits: { max_archive_bytes: number };
  produced_at: string;
}

export function projectSnapshotStorageConfigured(): boolean {
  return config.KORTIX_PROJECT_SNAPSHOT_S3_BUCKET.trim().length > 0;
}

export function projectSnapshotBucket(): string {
  const bucket = config.KORTIX_PROJECT_SNAPSHOT_S3_BUCKET.trim();
  if (!bucket) throw new Error('KORTIX_PROJECT_SNAPSHOT_S3_BUCKET is not configured');
  return bucket;
}

const KEY_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

function keySegment(value: string, label: string): string {
  if (!KEY_SEGMENT_RE.test(value) || value === '.' || value === '..') {
    throw new Error(`project snapshot ${label} is not a valid object key segment`);
  }
  return value;
}

/** `<prefix><owner>/<repo>/<sha>/<external-repo-id>/project-snapshot-v1/` */
export function projectSnapshotObjectPrefix(
  repository: ProjectSnapshotRepository,
  commitSha: string,
): string {
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error('project snapshot commit sha must be 40 hex');
  const configured = config.KORTIX_PROJECT_SNAPSHOT_S3_PREFIX.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  const prefix = configured ? `${configured}/` : '';
  return (
    `${prefix}${keySegment(repository.owner, 'owner')}/${keySegment(repository.name, 'repo')}/` +
    `${commitSha}/${keySegment(repository.externalId, 'repository id')}/${PROJECT_SNAPSHOT_FORMAT}/`
  );
}

/** The boot object (working tree + blobless `.git`). */
export function projectSnapshotTreeKey(prefix: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('project snapshot archive digest must be 64 hex');
  return `${prefix}${sha256}.tree.tar.gz`;
}

/** The hydration object (the tip's blob pack). */
export function projectSnapshotBlobsKey(prefix: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('project snapshot blob pack digest must be 64 hex');
  return `${prefix}${sha256}.blobs.pack`;
}

export function projectSnapshotManifestKey(prefix: string): string {
  return `${prefix}${PROJECT_SNAPSHOT_MANIFEST_NAME}`;
}

/**
 * The snapshot store: the shared object store bound to the snapshot settings.
 * The target is re-read on every call, so a test that swaps a setting (see
 * `__tests__/integration-project-snapshot.test.ts`) takes effect at once.
 */
const store = new ObjectStore(() => ({
  name: 'project snapshot',
  bucket: config.KORTIX_PROJECT_SNAPSHOT_S3_BUCKET,
  region: config.KORTIX_PROJECT_SNAPSHOT_S3_REGION,
  endpoint: config.KORTIX_PROJECT_SNAPSHOT_S3_ENDPOINT,
  publicEndpoint: config.KORTIX_PROJECT_SNAPSHOT_S3_PUBLIC_ENDPOINT,
  forcePathStyle: config.KORTIX_PROJECT_SNAPSHOT_S3_FORCE_PATH_STYLE,
  accelerate: config.KORTIX_PROJECT_SNAPSHOT_S3_ACCELERATE,
  accessKeyId: config.KORTIX_PROJECT_SNAPSHOT_S3_ACCESS_KEY_ID,
  secretAccessKey: config.KORTIX_PROJECT_SNAPSHOT_S3_SECRET_ACCESS_KEY,
}));

export function projectSnapshotStore(): ObjectStore {
  return store;
}

/** The client the API uses to read/write objects (its own network path). */
export function projectSnapshotS3Client(): S3Client {
  return store.client();
}

/** The client that SIGNS download URLs — see `resolvePresignTarget`. */
export function projectSnapshotPresignClient(): S3Client {
  return store.presignClient();
}

export function __resetProjectSnapshotS3ClientForTests(): void {
  store.reset();
}

/**
 * Publish once: the object is written only when no object exists at `key`.
 * `exists` means another producer already published it — the caller reads
 * that object back as the truth instead of overwriting.
 */
export function putObjectIfAbsent(input: {
  key: string;
  body: ObjectBody;
  contentType: string;
}): Promise<PutOutcome> {
  return store.putIfAbsent(input);
}

export function headObject(key: string): Promise<{ bytes: number; etag: string | null } | null> {
  return store.head(key);
}

export function getObjectText(key: string): Promise<string | null> {
  return store.getText(key);
}

/** Short-lived, read-only download URL for one archive object. */
export function presignProjectSnapshotDownload(
  key: string,
  ttlSeconds = config.KORTIX_PROJECT_SNAPSHOT_DOWNLOAD_TTL_SECONDS,
): Promise<{ url: string; expiresAt: Date }> {
  return store.presignDownload(key, ttlSeconds);
}
