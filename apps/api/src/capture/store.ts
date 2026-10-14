/**
 * The capture bucket, through the API's one object store (object-store/s3.ts).
 * Devices write; the API reads (ingestion), writes `policy.json`, and signs
 * short-lived media URLs. Unset bucket ⇒ `captureStoreConfigured()` is false.
 */
import { CreateBucketCommand, HeadBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';
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
  return (config.KORTIX_CAPTURE_S3_REGION ?? '').trim() || 'us-east-1';
}

/** The S3 endpoint a device talks to. AWS: the regional endpoint. */
export function deviceEndpoint(): string {
  const explicit = (config.KORTIX_CAPTURE_S3_PUBLIC_ENDPOINT || config.KORTIX_CAPTURE_S3_ENDPOINT || '').trim();
  return explicit || `https://s3.${captureRegion()}.amazonaws.com`;
}

/** Write (or overwrite) one object. Server-side encryption is the bucket default. */
export async function putCaptureObject(key: string, body: string | Uint8Array, contentType: string): Promise<void> {
  await captureStore
    .client()
    .send(new PutObjectCommand({ Bucket: captureStore.bucket, Key: key, Body: body, ContentType: contentType }));
}

/**
 * Creates the bucket when `KORTIX_CAPTURE_S3_CREATE_BUCKET` is on (self-host's
 * bundled store, which starts empty). Idempotent: a bucket that exists, or that
 * a second replica created first, is left alone. AWS: Terraform owns the bucket.
 */
export async function ensureCaptureBucket(): Promise<void> {
  if (!config.KORTIX_CAPTURE_S3_CREATE_BUCKET || !captureStore.configured) return;
  const client = captureStore.client();
  try {
    await client.send(new HeadBucketCommand({ Bucket: captureStore.bucket }));
    return;
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode !== 404) throw error;
  }
  try {
    await client.send(new CreateBucketCommand({ Bucket: captureStore.bucket }));
  } catch (error) {
    if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes((error as { name?: string })?.name ?? '')) throw error;
  }
}
