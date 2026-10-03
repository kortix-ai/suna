/**
 * The capture bucket, through the API's one object store (object-store/s3.ts).
 * Devices write; the API reads (ingestion), writes `policy.json`, and signs
 * short-lived media URLs. Unset bucket ⇒ `captureStoreConfigured()` is false.
 */
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../config';
import { ObjectStore } from '../object-store/s3';

export const captureStore = new ObjectStore(() => ({
  name: 'capture',
  bucket: config.KORTIX_CAPTURE_S3_BUCKET ?? '',
  region: config.KORTIX_CAPTURE_S3_REGION,
  endpoint: config.KORTIX_CAPTURE_S3_ENDPOINT,
  publicEndpoint: config.KORTIX_CAPTURE_S3_PUBLIC_ENDPOINT,
  forcePathStyle: config.KORTIX_CAPTURE_S3_FORCE_PATH_STYLE,
  accessKeyId: config.KORTIX_CAPTURE_S3_ACCESS_KEY_ID,
  secretAccessKey: config.KORTIX_CAPTURE_S3_SECRET_ACCESS_KEY,
}));

export function captureStoreConfigured(): boolean {
  return captureStore.configured;
}

export function captureRegion(): string {
  return (config.KORTIX_CAPTURE_S3_REGION ?? '').trim() || process.env.AWS_REGION || 'us-east-1';
}

/** The S3 endpoint a device talks to. AWS: the regional endpoint. */
export function deviceEndpoint(): string {
  const explicit = (config.KORTIX_CAPTURE_S3_PUBLIC_ENDPOINT || config.KORTIX_CAPTURE_S3_ENDPOINT || '').trim();
  return explicit || `https://s3.${captureRegion()}.amazonaws.com`;
}

/** Write (or overwrite) one object. Server-side encryption is the bucket default. */
export async function putCaptureObject(key: string, body: string, contentType: string): Promise<void> {
  await captureStore
    .client()
    .send(new PutObjectCommand({ Bucket: captureStore.bucket, Key: key, Body: body, ContentType: contentType }));
}

export type ConditionalRead =
  | { status: 'missing' }
  | { status: 'unchanged' }
  | { status: 'ok'; body: Uint8Array; etag: string | null };

/** GET with `If-None-Match`: the body only when the object changed since `etag`. */
export async function getCaptureObjectIfChanged(key: string, etag: string | null): Promise<ConditionalRead> {
  try {
    const out = await captureStore.client().send(
      new GetObjectCommand({ Bucket: captureStore.bucket, Key: key, ...(etag ? { IfNoneMatch: etag } : {}) }),
    );
    const body = out.Body ? await out.Body.transformToByteArray() : new Uint8Array();
    return { status: 'ok', body, etag: out.ETag ?? null };
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    const name = (error as { name?: string }).name;
    if (status === 304 || name === 'NotModified') return { status: 'unchanged' };
    if (status === 404 || name === 'NoSuchKey' || name === 'NotFound') return { status: 'missing' };
    throw error;
  }
}
