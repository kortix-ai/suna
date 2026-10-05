/**
 * The capture credential issuer: short-lived S3 credentials that reach exactly
 * one device's folder.
 *
 *   read/write/delete  <bucket>/<prefix>/<device_id>/*  (the engine probes with
 *               PUT, HEAD, DELETE and removes a forgotten range's objects itself)
 *   read        <bucket>/<prefix>/policy.json
 *   list        <bucket> with s3:prefix <prefix>/<device_id>/*  (so a missing key
 *               answers 404, not 403 — learnings 2026-09-14)
 *
 * One interface, so a store without STS can get its own issuer later. Today's
 * one implementation is STS AssumeRole with an inline session policy: on AWS
 * the effective permission is the intersection of the device role's policy and
 * the session policy; MinIO enforces the session policy the same way.
 */
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { config } from '../config';
import { captureRegion, captureStore, deviceEndpoint } from './store';

export interface CaptureCredentials {
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  device_id: string;
  access_key_id: string;
  secret_access_key: string;
  session_token: string;
  expires_at_ms: number;
  /** Path-style URLs (MinIO and most self-hosted S3); false on AWS. */
  path_style: boolean;
}

export interface CaptureCredentialIssuer {
  issue(scope: { prefix: string; deviceId: string }): Promise<CaptureCredentials>;
}

/** The session policy for one device. Exported for its unit test. */
export function deviceSessionPolicy(bucket: string, prefix: string, deviceId: string) {
  const folder = `${prefix}/${deviceId}`;
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'DeviceFolder',
        Effect: 'Allow',
        Action: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'],
        Resource: [`arn:aws:s3:::${bucket}/${folder}/*`],
      },
      {
        Sid: 'AccountPolicy',
        Effect: 'Allow',
        Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${bucket}/${prefix}/policy.json`],
      },
      {
        Sid: 'ListDeviceFolder',
        Effect: 'Allow',
        Action: ['s3:ListBucket'],
        Resource: [`arn:aws:s3:::${bucket}`],
        Condition: { StringLike: { 's3:prefix': [`${folder}/*`] } },
      },
    ],
  };
}

let stsClient: STSClient | null = null;
function sts(): STSClient {
  if (stsClient) return stsClient;
  const endpoint = (config.KORTIX_CAPTURE_STS_ENDPOINT ?? '').trim();
  const accessKeyId = (config.KORTIX_CAPTURE_S3_ACCESS_KEY_ID ?? '').trim();
  const secretAccessKey = (config.KORTIX_CAPTURE_S3_SECRET_ACCESS_KEY ?? '').trim();
  stsClient = new STSClient({
    region: captureRegion(),
    ...(endpoint ? { endpoint } : {}),
    // The explicit pair is the S3-compatible store's (MinIO). On AWS it is unset
    // and the SDK default chain resolves the ECS task role.
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
  return stsClient;
}

const stsIssuer: CaptureCredentialIssuer = {
  async issue({ prefix, deviceId }) {
    const bucket = captureStore.bucket;
    const ttl = Math.min(Math.max(config.KORTIX_CAPTURE_CREDENTIAL_TTL_SECONDS, 900), 3600);
    const out = await sts().send(
      new AssumeRoleCommand({
        RoleArn: config.KORTIX_CAPTURE_STS_ROLE_ARN!,
        RoleSessionName: `capture-${deviceId.replace(/-/g, '').slice(0, 32)}`,
        DurationSeconds: ttl,
        Policy: JSON.stringify(deviceSessionPolicy(bucket, prefix, deviceId)),
      }),
    );
    const creds = out.Credentials;
    if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken || !creds.Expiration) {
      throw new Error('STS AssumeRole returned no credentials');
    }
    return {
      endpoint: deviceEndpoint(),
      bucket,
      region: captureRegion(),
      prefix,
      device_id: deviceId,
      access_key_id: creds.AccessKeyId,
      secret_access_key: creds.SecretAccessKey,
      session_token: creds.SessionToken,
      expires_at_ms: creds.Expiration.getTime(),
      path_style: config.KORTIX_CAPTURE_S3_FORCE_PATH_STYLE,
    };
  },
};

/** The configured issuer, or null when this deployment issues no capture credentials. */
export function captureCredentialIssuer(): CaptureCredentialIssuer | null {
  if (!captureStore.configured || !(config.KORTIX_CAPTURE_STS_ROLE_ARN ?? '').trim()) return null;
  return stsIssuer;
}
