/**
 * The API's ONE object store.
 *
 * Every object the API writes to a bucket goes through this module: project
 * snapshot archives (`git-proxy/project-snapshot-store.ts`) and config release
 * archives (`config-releases/store.ts`). One thin layer over
 * `@aws-sdk/client-s3` — the SDK owns credentials (an explicit pair, else its
 * default chain: env, shared config, ECS/EKS task role), signing, retries and
 * presigning. Nothing here hand-signs a request, hand-rolls an HTTP call,
 * caches a credential, or creates a bucket. Buckets are infrastructure:
 * Terraform on AWS, a database migration on Supabase Storage.
 *
 * One store instance = one target (bucket + endpoint + credentials). A caller
 * adds its own key layout on top; this module never invents keys.
 */
import { readFile } from 'node:fs/promises';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type PutObjectCommandInput,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface ObjectStoreTarget {
  /** Short label used in log lines and errors, e.g. `project snapshot`. */
  name: string;
  bucket: string;
  region?: string;
  /** S3-compatible endpoint. Empty = the AWS regional endpoint. */
  endpoint?: string;
  /** Endpoint the CONSUMER reaches, when it differs from the API's. */
  publicEndpoint?: string;
  forcePathStyle?: boolean;
  accelerate?: boolean;
  /** Explicit pair. Both empty = the AWS SDK default credential chain. */
  accessKeyId?: string;
  secretAccessKey?: string;
}

export type PutOutcome = 'created' | 'exists';

/** How `putIfAbsent` keeps the first write on this endpoint. */
export type PublishOnceMode = 'if-none-match' | 'head-then-put';

export interface ObjectSummary {
  key: string;
  bytes: number;
  lastModified: Date | null;
}

export interface ListOptions {
  /** Keys per request. */
  pageSize?: number;
  /** Hard bound on requests, so one call can never walk an unbounded prefix. */
  maxPages?: number;
}

/**
 * Whether the endpoint honours `If-None-Match: *` on PutObject.
 *
 * MEASURED, not assumed:
 * - AWS S3 (no endpoint override) enforces it and answers `412
 *   PreconditionFailed` on a second write. Conditional writes, since 2024-08.
 * - Supabase Storage's S3 protocol endpoint (`…/storage/v1/s3`) ACCEPTS the
 *   header, ignores it, and overwrites. Probed against local Supabase
 *   (storage-api) on 2026-09-24: a second `PutObject` of one key with
 *   `IfNoneMatch: '*'` answered 200 and the object read back as the second
 *   body. Sending the header there would claim a guarantee that does not
 *   exist, so that endpoint gets head-then-put instead.
 * - Any other S3-compatible endpoint (MinIO) is treated as conditional; it
 *   answers 412 when it supports the header, which this module maps to
 *   `exists`.
 */
export function publishOnceMode(endpoint: string | undefined): PublishOnceMode {
  const path = (endpoint ?? '').trim().replace(/\/+$/, '');
  return /\/storage\/v1\/s3$/.test(path) ? 'head-then-put' : 'if-none-match';
}

/**
 * Where the CONSUMER downloads from, derived from the store settings. Pure so
 * the three cases are unit-testable without a client:
 *   - custom public endpoint (MinIO behind a tunnel, self-host): that
 *     endpoint, path-style as configured, never accelerated (there is no edge
 *     in front of it);
 *   - Transfer Acceleration on AWS: the regional endpoint is swapped for
 *     <bucket>.s3-accelerate.amazonaws.com; the SDK refuses path-style there;
 *   - plain AWS: the API's own regional client signs the URLs.
 */
export function resolvePresignTarget(input: {
  publicEndpoint: string;
  accelerate: boolean;
  forcePathStyle: boolean;
}): { endpoint: string; useAccelerateEndpoint: boolean; forcePathStyle: boolean; sameAsApiClient: boolean } {
  const publicEndpoint = input.publicEndpoint.trim();
  if (publicEndpoint) {
    return { endpoint: publicEndpoint, useAccelerateEndpoint: false, forcePathStyle: input.forcePathStyle, sameAsApiClient: false };
  }
  if (input.accelerate) {
    return { endpoint: '', useAccelerateEndpoint: true, forcePathStyle: false, sameAsApiClient: false };
  }
  return { endpoint: '', useAccelerateEndpoint: false, forcePathStyle: input.forcePathStyle, sameAsApiClient: true };
}

function httpStatus(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

function errorName(err: unknown): string {
  return (err as { name?: string })?.name ?? '';
}

function isMissing(err: unknown): boolean {
  const name = errorName(err);
  return name === 'NotFound' || name === 'NoSuchKey' || httpStatus(err) === 404;
}

/** The body of one object: bytes in hand, or a file that is read whole. */
export type ObjectBody = string | Buffer | { path: string; bytes: number };

export class ObjectStore {
  private apiClient: S3Client | null = null;
  private presigningClient: S3Client | null = null;
  private modeLogged = false;

  /**
   * `target` is re-read on every call so a setting change (tests, hot config)
   * takes effect without rebuilding the store. The clients are memoized.
   */
  constructor(
    private readonly target: () => ObjectStoreTarget,
    private readonly overrides: { client?: S3Client; presignClient?: S3Client } = {},
  ) {}

  get name(): string {
    return this.target().name;
  }

  get bucket(): string {
    const { bucket, name } = this.target();
    const trimmed = bucket.trim();
    if (!trimmed) throw new Error(`${name} object store bucket is not configured`);
    return trimmed;
  }

  get configured(): boolean {
    return this.target().bucket.trim().length > 0;
  }

  publishOnce(): PublishOnceMode {
    return publishOnceMode(this.target().endpoint);
  }

  private build(endpoint: string, opts: { useAccelerateEndpoint?: boolean; forcePathStyle?: boolean } = {}): S3Client {
    const t = this.target();
    const region = (t.region ?? '').trim() || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
    const options: S3ClientConfig = {
      region,
      forcePathStyle: opts.forcePathStyle ?? Boolean(t.forcePathStyle),
      ...(endpoint ? { endpoint } : {}),
      ...(opts.useAccelerateEndpoint ? { useAccelerateEndpoint: true } : {}),
    };
    const accessKeyId = (t.accessKeyId ?? '').trim();
    const secretAccessKey = (t.secretAccessKey ?? '').trim();
    if (accessKeyId && secretAccessKey) options.credentials = { accessKeyId, secretAccessKey };
    return new S3Client(options);
  }

  /** The client the API reads and writes with (its own network path). */
  client(): S3Client {
    if (this.overrides.client) return this.overrides.client;
    if (!this.apiClient) this.apiClient = this.build((this.target().endpoint ?? '').trim());
    return this.apiClient;
  }

  /**
   * The client that SIGNS download URLs: identical, except it targets the
   * endpoint the consumer reaches (SigV4 signs the host). Same object either
   * way on plain AWS.
   */
  presignClient(): S3Client {
    if (this.overrides.presignClient) return this.overrides.presignClient;
    if (this.overrides.client) return this.overrides.client;
    const t = this.target();
    const resolved = resolvePresignTarget({
      publicEndpoint: t.publicEndpoint ?? '',
      accelerate: Boolean(t.accelerate),
      forcePathStyle: Boolean(t.forcePathStyle),
    });
    if (resolved.sameAsApiClient) return this.client();
    if (!this.presigningClient) {
      this.presigningClient = this.build(resolved.endpoint, {
        useAccelerateEndpoint: resolved.useAccelerateEndpoint,
        forcePathStyle: resolved.forcePathStyle,
      });
    }
    return this.presigningClient;
  }

  /** Drop the memoized clients. Tests, and any settings change. */
  reset(): void {
    this.apiClient = null;
    this.presigningClient = null;
    this.modeLogged = false;
  }

  private logMode(): void {
    if (this.modeLogged) return;
    this.modeLogged = true;
    const t = this.target();
    const endpoint = (t.endpoint ?? '').trim() || 'aws';
    const mode = this.publishOnce();
    const why =
      mode === 'if-none-match'
        ? 'the endpoint enforces If-None-Match: * and answers 412 on a second write'
        : 'the endpoint ignores If-None-Match, so an existing key is read first and never rewritten';
    console.log(`[object-store] ${t.name} bucket=${t.bucket} endpoint=${endpoint} publish-once=${mode} (${why})`);
  }

  private async resolveBody(body: ObjectBody): Promise<{ Body: PutObjectCommandInput['Body']; ContentLength?: number }> {
    if (typeof body === 'string' || Buffer.isBuffer(body)) return { Body: body };
    // Whole-file Buffer, not `createReadStream`: on the API image's Bun
    // (`BUN_VERSION=1.2`, 1.2.23) a PutObject with a Node ReadStream body
    // never completes and pins a core (scripts/project-snapshot-s3-probe.ts
    // reproduces it; a Buffer body of the same bytes finishes in ~30 ms).
    // ponytail: archives are capped by the caller (512 MiB for snapshots,
    // 4 MiB for config archives) and are single-digit MB in practice; switch
    // to @aws-sdk/lib-storage multipart if that ceiling is ever approached.
    const buffer = await readFile(body.path);
    if (buffer.byteLength !== body.bytes) {
      throw new Error(`archive changed on disk: expected ${body.bytes} bytes, read ${buffer.byteLength}`);
    }
    return { Body: buffer, ContentLength: body.bytes };
  }

  /**
   * Publish once: the object is written only when no object exists at `key`.
   * `exists` means another producer published it — the caller reads that
   * object back as the truth instead of overwriting.
   *
   * Two mechanisms, one per endpoint capability (see {@link publishOnceMode}):
   * atomic `If-None-Match: *`, or head-then-put. head-then-put is NOT atomic:
   * two concurrent producers can both write. Every caller keys objects by a
   * digest of their content, so the loser writes identical bytes.
   */
  async putIfAbsent(input: { key: string; body: ObjectBody; contentType: string }): Promise<PutOutcome> {
    this.logMode();
    const conditional = this.publishOnce() === 'if-none-match';
    if (!conditional && (await this.head(input.key))) return 'exists';
    const { Body, ContentLength } = await this.resolveBody(input.body);
    try {
      await this.client().send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: input.key,
          Body,
          ContentLength,
          ContentType: input.contentType,
          ...(conditional ? { IfNoneMatch: '*' } : {}),
        }),
      );
      return 'created';
    } catch (err) {
      if (conditional && (errorName(err) === 'PreconditionFailed' || httpStatus(err) === 412)) return 'exists';
      throw err;
    }
  }

  async head(key: string): Promise<{ bytes: number; etag: string | null } | null> {
    try {
      const res = await this.client().send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { bytes: res.ContentLength ?? 0, etag: res.ETag ?? null };
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async getText(key: string): Promise<string | null> {
    try {
      const res = await this.client().send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return res.Body ? await res.Body.transformToString() : '';
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  /** Short-lived, read-only download URL for one object. */
  async presignDownload(key: string, ttlSeconds: number): Promise<{ url: string; expiresAt: Date }> {
    const expiresIn = Math.max(60, Math.min(ttlSeconds, 7 * 24 * 3600));
    const url = await getSignedUrl(this.presignClient(), new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn,
    });
    return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }

  /** Every object under `prefix`, bounded by `maxPages` requests. */
  async list(prefix: string, options: ListOptions = {}): Promise<ObjectSummary[]> {
    const pageSize = options.pageSize ?? 1000;
    const maxPages = options.maxPages ?? 10;
    const found: ObjectSummary[] = [];
    let token: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.client().send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, MaxKeys: pageSize, ContinuationToken: token }),
      );
      for (const item of res.Contents ?? []) {
        if (item.Key) found.push({ key: item.Key, bytes: item.Size ?? 0, lastModified: item.LastModified ?? null });
      }
      if (!res.IsTruncated || !res.NextContinuationToken) break;
      token = res.NextContinuationToken;
    }
    return found;
  }

  /** Delete objects by key. Returns how many the store reported deleted. */
  async remove(keys: string[]): Promise<number> {
    let deleted = 0;
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      const res = await this.client().send(
        new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: batch.map((Key) => ({ Key })) } }),
      );
      deleted += res.Deleted?.length ?? 0;
    }
    return deleted;
  }
}
