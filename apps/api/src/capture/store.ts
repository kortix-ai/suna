/**
 * Kortix Capture object store: the shared ObjectStore bound to the
 * `KORTIX_CAPTURE_S3_*` settings, plus the key layout. One mp4 per chunk.
 */
import { config } from '../config';
import { ObjectStore } from '../object-store/s3';

/** Same ceiling as the local bucket's `file_size_limit` (migration). */
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
export const UPLOAD_URL_TTL_SECONDS = 3600;
export const VIDEO_URL_TTL_SECONDS = 600;

export const captureStore = new ObjectStore(() => ({
  name: 'capture',
  bucket: config.KORTIX_CAPTURE_S3_BUCKET,
  region: config.KORTIX_CAPTURE_S3_REGION,
  endpoint: config.KORTIX_CAPTURE_S3_ENDPOINT,
  publicEndpoint: config.KORTIX_CAPTURE_S3_PUBLIC_ENDPOINT,
  forcePathStyle: config.KORTIX_CAPTURE_S3_FORCE_PATH_STYLE,
  accessKeyId: config.KORTIX_CAPTURE_S3_ACCESS_KEY_ID,
  secretAccessKey: config.KORTIX_CAPTURE_S3_SECRET_ACCESS_KEY,
}));

/** `<prefix>capture/<account>/<user>/<yyyy>/<mm>/<dd>/<chunk>.mp4`, date in UTC. */
export function captureVideoKey(input: { accountId: string; userId: string; startedAt: Date; chunkId: string }): string {
  const prefix = config.KORTIX_CAPTURE_S3_PREFIX.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  const d = input.startedAt.toISOString();
  return (
    `${prefix ? `${prefix}/` : ''}capture/${input.accountId}/${input.userId}/` +
    `${d.slice(0, 4)}/${d.slice(5, 7)}/${d.slice(8, 10)}/${input.chunkId}.mp4`
  );
}
