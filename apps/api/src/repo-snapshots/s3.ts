/**
 * Minimal S3 access for repository snapshots: signed GET/PUT/HEAD plus a
 * presigned GET the sandbox can use directly.
 *
 * Hand-signed SigV4 over `fetch`, exactly like `lib/email/providers/ses.ts`
 * already does for SES — the API keeps no AWS SDK client dependency, only the
 * credential provider that is already installed, and only when no static key
 * pair is configured (ECS task role / EKS web identity).
 *
 * Capabilities deliberately NOT implemented here: bucket listing and delete.
 * The sandbox is only ever handed an object-scoped presigned GET.
 */
import { createHash, createHmac } from 'node:crypto';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { config } from '../config';

const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface RepoSnapshotBucket {
  bucket: string;
  region: string;
  /** Custom endpoint origin (MinIO, LocalStack, S3-compatible). */
  endpoint?: string;
  /** Path-style addressing. Forced on for a custom endpoint. */
  forcePathStyle: boolean;
  /** Environment-scoped key prefix, normalized to end with `/` or be empty. */
  prefix: string;
}

export class RepoSnapshotStorageNotConfiguredError extends Error {
  constructor(missing: string) {
    super(`repository snapshot storage is not configured: ${missing} is unset`);
    this.name = 'RepoSnapshotStorageNotConfiguredError';
  }
}

export class S3RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'S3RequestError';
  }
  /** The object (or the precondition target) is not there. */
  get notFound(): boolean {
    return this.status === 404;
  }
  /**
   * The caller may not ask this question — NOT a statement about the object.
   *
   * On AWS, a HEAD or GET for a key that does not exist answers 403, not 404,
   * unless the principal also holds `s3:ListBucket` on the bucket
   * (https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html).
   * A caller that treated 403 as "absent" would be wrong in exactly the case
   * that matters, so absence is never inferred from this.
   */
  get accessDenied(): boolean {
    return this.status === 403;
  }
  /** A conditional create lost: another publisher already wrote this key. */
  get preconditionFailed(): boolean {
    return this.status === 412 || this.status === 409;
  }
  /** Worth another attempt with a fresh signature. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export function resolveRepoSnapshotBucket(): RepoSnapshotBucket | null {
  const bucket = (config.KORTIX_REPO_SNAPSHOT_BUCKET ?? '').trim();
  if (!bucket) return null;
  const endpoint = (config.KORTIX_REPO_SNAPSHOT_ENDPOINT ?? '').trim() || undefined;
  const rawPrefix = (config.KORTIX_REPO_SNAPSHOT_PREFIX ?? '').trim();
  const prefix = rawPrefix ? `${rawPrefix.replace(/^\/+|\/+$/g, '')}/` : '';
  return {
    bucket,
    region: (config.KORTIX_REPO_SNAPSHOT_REGION ?? '').trim() || 'us-east-1',
    endpoint,
    forcePathStyle: !!endpoint || config.KORTIX_REPO_SNAPSHOT_PATH_STYLE === true,
    prefix,
  };
}

export function requireRepoSnapshotBucket(): RepoSnapshotBucket {
  const resolved = resolveRepoSnapshotBucket();
  if (!resolved) throw new RepoSnapshotStorageNotConfiguredError('KORTIX_REPO_SNAPSHOT_BUCKET');
  return resolved;
}

let cachedCredentials: { value: S3Credentials; expiresAt: number } | null = null;

/**
 * Static key pair when configured, else the ambient AWS credential chain.
 * Chain credentials are cached for 5 minutes: they are refreshed by the
 * provider itself and the publisher signs many requests per build.
 */
export async function resolveS3Credentials(now = Date.now()): Promise<S3Credentials> {
  const accessKeyId = (config.KORTIX_REPO_SNAPSHOT_ACCESS_KEY_ID ?? '').trim();
  const secretAccessKey = (config.KORTIX_REPO_SNAPSHOT_SECRET_ACCESS_KEY ?? '').trim();
  if (accessKeyId && secretAccessKey) return { accessKeyId, secretAccessKey };
  if (cachedCredentials && cachedCredentials.expiresAt > now) return cachedCredentials.value;
  const resolved = await defaultProvider()();
  const value: S3Credentials = {
    accessKeyId: resolved.accessKeyId,
    secretAccessKey: resolved.secretAccessKey,
    ...(resolved.sessionToken ? { sessionToken: resolved.sessionToken } : {}),
  };
  cachedCredentials = { value, expiresAt: now + 5 * 60_000 };
  return value;
}

export function __resetS3CredentialCacheForTests(): void {
  cachedCredentials = null;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** RFC 3986 encoding. S3 canonical URIs encode every reserved character. */
function uriEncode(value: string, encodeSlash: boolean): string {
  let out = '';
  for (const char of Buffer.from(value, 'utf8')) {
    const c = String.fromCharCode(char);
    if (/[A-Za-z0-9_.~-]/.test(c)) out += c;
    else if (c === '/') out += encodeSlash ? '%2F' : '/';
    else out += `%${char.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

export interface S3ObjectLocation {
  url: URL;
  host: string;
  canonicalUri: string;
}

/** Absolute key = configured prefix + the format's key. */
export function scopedKey(bucket: RepoSnapshotBucket, key: string): string {
  return `${bucket.prefix}${key.replace(/^\/+/, '')}`;
}

export function objectLocation(bucket: RepoSnapshotBucket, key: string): S3ObjectLocation {
  const absolute = scopedKey(bucket, key);
  const encoded = uriEncode(absolute, false);
  if (bucket.endpoint || bucket.forcePathStyle) {
    const base = bucket.endpoint ?? `https://s3.${bucket.region}.amazonaws.com`;
    const origin = new URL(base);
    const canonicalUri = `/${bucket.bucket}/${encoded}`;
    return {
      url: new URL(`${origin.origin}${canonicalUri}`),
      host: origin.host,
      canonicalUri,
    };
  }
  const host = `${bucket.bucket}.s3.${bucket.region}.amazonaws.com`;
  return { url: new URL(`https://${host}/${encoded}`), host, canonicalUri: `/${encoded}` };
}

interface SignInput {
  method: 'GET' | 'PUT' | 'HEAD';
  location: S3ObjectLocation;
  region: string;
  credentials: S3Credentials;
  payloadHash: string;
  extraHeaders?: Record<string, string>;
  now?: Date;
}

function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function signingKey(secret: string, dateStamp: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), 's3'), 'aws4_request');
}

function signRequest(input: SignInput): Record<string, string> {
  const now = input.now ?? new Date();
  const { amzDate, dateStamp } = amzDates(now);
  const headers: Record<string, string> = {
    host: input.location.host,
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': amzDate,
    ...(input.credentials.sessionToken
      ? { 'x-amz-security-token': input.credentials.sessionToken }
      : {}),
    ...Object.fromEntries(
      Object.entries(input.extraHeaders ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    ),
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    input.method,
    input.location.canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const signature = createHmac('sha256', signingKey(input.credentials.secretAccessKey, dateStamp, input.region))
    .update(stringToSign, 'utf8')
    .digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

async function s3Error(response: Response, method: string, key: string): Promise<S3RequestError> {
  const body = await response.text().catch(() => '');
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? response.statusText ?? 'S3Error';
  // The key is safe to log; the signed query string never is, and is not in scope here.
  return new S3RequestError(response.status, code, `S3 ${method} ${key} failed: ${response.status} ${code}`);
}

export interface S3GetResult {
  body: ReadableStream<Uint8Array>;
  contentLength: number | null;
  etag: string | null;
}

/** Streaming GET. The caller owns backpressure and cancellation. */
export async function s3GetObjectStream(
  bucket: RepoSnapshotBucket,
  key: string,
  options: { signal?: AbortSignal } = {},
): Promise<S3GetResult> {
  const location = objectLocation(bucket, key);
  const credentials = await resolveS3Credentials();
  const headers = signRequest({
    method: 'GET',
    location,
    region: bucket.region,
    credentials,
    payloadHash: EMPTY_SHA256,
  });
  const response = await fetch(location.url, { method: 'GET', headers, signal: options.signal });
  if (!response.ok || !response.body) throw await s3Error(response, 'GET', key);
  const declared = Number(response.headers.get('content-length'));
  return {
    body: response.body as ReadableStream<Uint8Array>,
    contentLength: Number.isFinite(declared) ? declared : null,
    etag: response.headers.get('etag'),
  };
}

export async function s3GetObjectText(
  bucket: RepoSnapshotBucket,
  key: string,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  const location = objectLocation(bucket, key);
  const credentials = await resolveS3Credentials();
  const headers = signRequest({
    method: 'GET',
    location,
    region: bucket.region,
    credentials,
    payloadHash: EMPTY_SHA256,
  });
  const response = await fetch(location.url, { method: 'GET', headers, signal: options.signal });
  if (!response.ok) throw await s3Error(response, 'GET', key);
  return response.text();
}

/**
 * HEAD an object.
 *
 * `null` means the store said 404 — the object is genuinely absent. It does NOT
 * cover 403: without `s3:ListBucket`, AWS answers 403 for a missing key, and
 * collapsing that into `null` would make every first publication look like a
 * successful absence check. A 403 therefore throws, and callers that need to
 * decide existence must use a conditional write instead. See
 * `publish.ts:ensureArchiveUploaded`.
 */
export async function s3HeadObject(
  bucket: RepoSnapshotBucket,
  key: string,
): Promise<{ contentLength: number | null; etag: string | null } | null> {
  const location = objectLocation(bucket, key);
  const credentials = await resolveS3Credentials();
  const headers = signRequest({
    method: 'HEAD',
    location,
    region: bucket.region,
    credentials,
    payloadHash: EMPTY_SHA256,
  });
  const response = await fetch(location.url, { method: 'HEAD', headers });
  if (response.status === 404) return null;
  if (!response.ok) throw await s3Error(response, 'HEAD', key);
  const declared = Number(response.headers.get('content-length'));
  return {
    contentLength: Number.isFinite(declared) ? declared : null,
    etag: response.headers.get('etag'),
  };
}

export interface S3PutOptions {
  contentType?: string;
  /** `If-None-Match: *` — create only. The loser gets 412 and reads the winner. */
  ifNoneMatch?: boolean;
  signal?: AbortSignal;
}

/**
 * Single-shot PUT of an already-materialized body. Snapshot archives are
 * bounded by `maxCompressedBytes`, so a multipart upload buys nothing here and
 * would add an abort/cleanup path for no gain.
 */
export async function s3PutObject(
  bucket: RepoSnapshotBucket,
  key: string,
  body: Uint8Array,
  options: S3PutOptions = {},
): Promise<{ etag: string | null }> {
  const location = objectLocation(bucket, key);
  const credentials = await resolveS3Credentials();
  const payloadHash = createHash('sha256').update(body).digest('hex');
  const extraHeaders: Record<string, string> = {
    'content-length': String(body.byteLength),
    ...(options.contentType ? { 'content-type': options.contentType } : {}),
    ...(options.ifNoneMatch ? { 'if-none-match': '*' } : {}),
  };
  const headers = signRequest({
    method: 'PUT',
    location,
    region: bucket.region,
    credentials,
    payloadHash,
    extraHeaders,
  });
  // The request body IS file data, by design: this is the archive upload, and
  // the bytes come from an archive this process just built from a repository
  // checkout — never from a request, a URL, or user-supplied path. The
  // destination is not influenced by the body at all: `location` is derived
  // from the configured bucket and a content-addressed key, and the request is
  // SigV4-signed over that exact key, so the bytes cannot redirect the write.
  const response = await fetch(location.url, {
    method: 'PUT',
    headers,
    body: body as unknown as BodyInit,
    signal: options.signal,
  });
  if (!response.ok) throw await s3Error(response, 'PUT', key);
  return { etag: response.headers.get('etag') };
}

/**
 * Query-string SigV4 for an object-scoped GET.
 *
 * The URL grants read on exactly one key for `expiresInSeconds`. It carries a
 * credential in its query string, so it is never logged, never persisted, and
 * only ever handed to the sandbox that already authenticated for this session.
 */
export async function presignRepoSnapshotGet(
  bucket: RepoSnapshotBucket,
  key: string,
  expiresInSeconds: number,
  now: Date = new Date(),
): Promise<{ url: string; expiresAt: Date }> {
  const expires = Math.max(60, Math.min(Math.floor(expiresInSeconds), 7 * 24 * 3600));
  const location = objectLocation(bucket, key);
  const credentials = await resolveS3Credentials();
  const { amzDate, dateStamp } = amzDates(now);
  const scope = `${dateStamp}/${bucket.region}/s3/aws4_request`;
  const signedHeaders = 'host';
  const query: Array<[string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${credentials.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expires)],
    ['X-Amz-SignedHeaders', signedHeaders],
  ];
  if (credentials.sessionToken) query.push(['X-Amz-Security-Token', credentials.sessionToken]);
  const canonicalQuery = query
    .map(([k, v]) => [uriEncode(k, true), uriEncode(v, true)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [
    'GET',
    location.canonicalUri,
    canonicalQuery,
    `host:${location.host}\n`,
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(credentials.secretAccessKey, dateStamp, bucket.region))
    .update(stringToSign, 'utf8')
    .digest('hex');
  return {
    url: `${location.url.origin}${location.canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    expiresAt: new Date(now.getTime() + expires * 1000),
  };
}

/** Exported for the signing unit tests only. */
export const __internal = { uriEncode, signRequest, objectLocation, EMPTY_SHA256 };
