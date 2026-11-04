import type { OpenAPIHono } from '@hono/zod-openapi';
import { config } from '../config';
import { mountBucketProxy } from '../object-store/bucket-proxy';

/**
 * `/<capture bucket>/*` to the bundled store, when `KORTIX_CAPTURE_S3_PROXY_TARGET`
 * and the bucket are set (self-host without a domain). See object-store/bucket-proxy.ts.
 */
export function registerCaptureStoreProxy(app: OpenAPIHono): void {
  mountBucketProxy(app, { target: config.KORTIX_CAPTURE_S3_PROXY_TARGET, bucket: config.KORTIX_CAPTURE_S3_BUCKET, publicEndpoint: config.KORTIX_CAPTURE_S3_PUBLIC_ENDPOINT, name: 'capture' });
}
