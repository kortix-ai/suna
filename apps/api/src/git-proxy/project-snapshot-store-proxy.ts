import type { OpenAPIHono } from '@hono/zod-openapi';
import { config } from '../config';
import { mountBucketProxy } from '../object-store/bucket-proxy';

/**
 * `/<snapshot bucket>/*` to the bundled store, when `KORTIX_PROJECT_SNAPSHOT_S3_PROXY_TARGET`
 * and the bucket are set (self-host without a domain): a sandbox downloads its
 * presigned snapshot URL on the API origin. See object-store/bucket-proxy.ts.
 */
export function registerProjectSnapshotStoreProxy(app: OpenAPIHono): void {
  mountBucketProxy(app, { target: config.KORTIX_PROJECT_SNAPSHOT_S3_PROXY_TARGET, bucket: config.KORTIX_PROJECT_SNAPSHOT_S3_BUCKET, publicEndpoint: config.KORTIX_PROJECT_SNAPSHOT_S3_PUBLIC_ENDPOINT, name: 'project snapshot' });
}
