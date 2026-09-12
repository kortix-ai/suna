/**
 * Object storage for prebuilt project snapshot archives (the S3 config
 * provider's producer side). One thin layer over `@aws-sdk/client-s3`: the SDK
 * owns credentials (explicit pair from config, else its default chain — env,
 * shared config, ECS/EKS task role), signing, retries and presigning. Nothing
 * here hand-signs a request or caches a credential.
 *
 * Layout (immutable, content-addressed archive under a revision-addressed
 * prefix — see `projectSnapshotObjectPrefix`):
 *
 *   <prefix><owner>/<repo>/<full-commit-sha>/<external-repo-id>/project-snapshot-v1/
 *     manifest.json
 *     <archive-sha256>.tar.gz
 *
 * Publication order is archive first, manifest second, both with
 * `If-None-Match: *` so a concurrent producer never overwrites a published
 * object and a reader never sees a manifest whose archive is still uploading.
 */
import { createReadStream } from 'node:fs';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type PutObjectCommandInput,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config';

export const PROJECT_SNAPSHOT_FORMAT = 'project-snapshot-v1';
export const PROJECT_SNAPSHOT_MANIFEST_NAME = 'manifest.json';
export const PROJECT_SNAPSHOT_ARCHIVE_CONTENT_TYPE = 'application/gzip';

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
  archive: {
    key: string;
    sha256: string;
    bytes: number;
    entries: number;
    container: 'tar';
    compression: 'gzip';
    content_type: typeof PROJECT_SNAPSHOT_ARCHIVE_CONTENT_TYPE;
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

export function projectSnapshotArchiveKey(prefix: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('project snapshot archive digest must be 64 hex');
  return `${prefix}${sha256}.tar.gz`;
}

export function projectSnapshotManifestKey(prefix: string): string {
  return `${prefix}${PROJECT_SNAPSHOT_MANIFEST_NAME}`;
}

let client: S3Client | null = null;
let presignClient: S3Client | null = null;

function buildClient(endpoint: string): S3Client {
  const region =
    config.KORTIX_PROJECT_SNAPSHOT_S3_REGION.trim() ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    'us-east-1';
  const options: S3ClientConfig = {
    region,
    forcePathStyle: config.KORTIX_PROJECT_SNAPSHOT_S3_FORCE_PATH_STYLE,
    ...(endpoint ? { endpoint } : {}),
  };
  const accessKeyId = config.KORTIX_PROJECT_SNAPSHOT_S3_ACCESS_KEY_ID.trim();
  const secretAccessKey = config.KORTIX_PROJECT_SNAPSHOT_S3_SECRET_ACCESS_KEY.trim();
  if (accessKeyId && secretAccessKey) options.credentials = { accessKeyId, secretAccessKey };
  return new S3Client(options);
}

/** The client the API uses to read/write objects (its own network path). */
export function projectSnapshotS3Client(): S3Client {
  if (!client) client = buildClient(config.KORTIX_PROJECT_SNAPSHOT_S3_ENDPOINT.trim());
  return client;
}

/**
 * The client that SIGNS download URLs: identical, except it targets the
 * endpoint the sandbox reaches (SigV4 signs the host). Same object on AWS.
 */
export function projectSnapshotPresignClient(): S3Client {
  const publicEndpoint = config.KORTIX_PROJECT_SNAPSHOT_S3_PUBLIC_ENDPOINT.trim();
  if (!publicEndpoint) return projectSnapshotS3Client();
  if (!presignClient) presignClient = buildClient(publicEndpoint);
  return presignClient;
}

export function __resetProjectSnapshotS3ClientForTests(): void {
  client = null;
  presignClient = null;
}

function httpStatus(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

function errorName(err: unknown): string {
  return (err as { name?: string })?.name ?? '';
}

export type PutOutcome = 'created' | 'exists';

/**
 * Conditional publish: the object is written only when no object exists at
 * `key`. A 412 means another producer already published it — the caller reads
 * that object back as the truth instead of overwriting.
 */
export async function putObjectIfAbsent(input: {
  key: string;
  body: string | Buffer | { path: string; bytes: number };
  contentType: string;
}): Promise<PutOutcome> {
  let Body: PutObjectCommandInput['Body'];
  let ContentLength: number | undefined;
  if (typeof input.body === 'string' || Buffer.isBuffer(input.body)) {
    Body = input.body;
  } else {
    Body = createReadStream(input.body.path);
    ContentLength = input.body.bytes;
  }
  try {
    await projectSnapshotS3Client().send(
      new PutObjectCommand({
        Bucket: projectSnapshotBucket(),
        Key: input.key,
        Body,
        ContentLength,
        ContentType: input.contentType,
        IfNoneMatch: '*',
      }),
    );
    return 'created';
  } catch (err) {
    if (errorName(err) === 'PreconditionFailed' || httpStatus(err) === 412) return 'exists';
    throw err;
  }
}

export async function headObject(key: string): Promise<{ bytes: number; etag: string | null } | null> {
  try {
    const res = await projectSnapshotS3Client().send(
      new HeadObjectCommand({ Bucket: projectSnapshotBucket(), Key: key }),
    );
    return { bytes: res.ContentLength ?? 0, etag: res.ETag ?? null };
  } catch (err) {
    if (errorName(err) === 'NotFound' || errorName(err) === 'NoSuchKey' || httpStatus(err) === 404) return null;
    throw err;
  }
}

export async function getObjectText(key: string): Promise<string | null> {
  try {
    const res = await projectSnapshotS3Client().send(
      new GetObjectCommand({ Bucket: projectSnapshotBucket(), Key: key }),
    );
    return res.Body ? await res.Body.transformToString() : '';
  } catch (err) {
    if (errorName(err) === 'NoSuchKey' || errorName(err) === 'NotFound' || httpStatus(err) === 404) return null;
    throw err;
  }
}

/** Short-lived, read-only download URL for one archive object. */
export async function presignProjectSnapshotDownload(
  key: string,
  ttlSeconds = config.KORTIX_PROJECT_SNAPSHOT_DOWNLOAD_TTL_SECONDS,
): Promise<{ url: string; expiresAt: Date }> {
  const expiresIn = Math.max(60, Math.min(ttlSeconds, 7 * 24 * 3600));
  const url = await getSignedUrl(
    projectSnapshotPresignClient(),
    new GetObjectCommand({ Bucket: projectSnapshotBucket(), Key: key }),
    { expiresIn },
  );
  return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) };
}
