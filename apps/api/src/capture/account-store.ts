/**
 * Per-account resolution of the Capture store and credential issuer.
 *
 * An account in `kortix` mode uses the deployment-default store and issuer
 * (`store.ts`, `credentials.ts`) — the path is byte-identical to before this
 * feature. An account in `s3` mode uses its own S3-compatible bucket:
 *
 *   - role_arn  → STS AssumeRole. The server reads with account-prefix temp
 *     credentials (the SDK refreshes them); a device gets per-device scoped
 *     credentials, exactly like the managed store.
 *   - static keys → the server and the device use the account's own keys
 *     directly. Static keys CANNOT be scoped per device, so a device gets
 *     account-wide credentials. Prefer role_arn when per-device scoping matters.
 *
 * Switching stores never migrates old recordings; they stay in the previous
 * store. The server reads whichever store the account points at now.
 */
import { createHash } from 'node:crypto';
import { type S3ClientConfig } from '@aws-sdk/client-s3';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { ObjectStore } from '../object-store/s3';
import { captureCredentialIssuer, deviceSessionPolicy, type CaptureCredentialIssuer, type CaptureCredentials } from './credentials';
import { accountPrefix } from './format';
import { captureStore } from './store';
import { readResolvedStorage, type ResolvedStorage } from './storage-config';

type S3Config = Extract<ResolvedStorage, { mode: 's3' }>;

/** One hour, STS's longest role-session without a raised maximum. */
const ROLE_DURATION_SECONDS = 3600;

const regionOf = (s: S3Config) => s.region || 'us-east-1';
/** The S3 endpoint a device (and the server) talk to. Empty endpoint ⇒ the AWS regional endpoint. */
const endpointOf = (s: S3Config) => s.endpoint.trim() || `https://s3.${regionOf(s)}.amazonaws.com`;

/** A full-account session policy so the server can read, write policy.json, and apply retention. */
function serverSessionPolicy(bucket: string, prefix: string) {
  return {
    Version: '2012-10-17',
    Statement: [
      { Sid: 'Objects', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: [`arn:aws:s3:::${bucket}/${prefix}/*`] },
      { Sid: 'List', Effect: 'Allow', Action: ['s3:ListBucket'], Resource: [`arn:aws:s3:::${bucket}`], Condition: { StringLike: { 's3:prefix': [`${prefix}/*`] } } },
    ],
  };
}

function stsFor(s: S3Config): STSClient {
  // The role is in the ACCOUNT's AWS; its own default credential chain (the ECS
  // task role) is used to assume it. A static endpoint override targets a
  // MinIO/S3-compatible STS; AWS uses the regional default.
  const endpoint = s.endpoint.trim();
  return new STSClient({ region: regionOf(s), ...(endpoint && !isAwsHost(endpoint) ? { endpoint } : {}) });
}

/** Whether `endpoint`'s HOST is AWS (a substring match would accept any URL that merely mentions it). */
function isAwsHost(endpoint: string): boolean {
  try {
    const host = new URL(endpoint.includes('://') ? endpoint : `https://${endpoint}`).hostname.toLowerCase();
    return host === 'amazonaws.com' || host.endsWith('.amazonaws.com');
  } catch {
    return false;
  }
}

/** The `credentials` for the server's own ObjectStore: static keys, or a refreshing AssumeRole provider. */
function serverCredentials(accountId: string, s: S3Config): S3ClientConfig['credentials'] | undefined {
  if (!s.roleArn) return s.accessKeyId && s.secretAccessKey ? { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey } : undefined;
  const sts = stsFor(s);
  const prefix = accountPrefix(accountId);
  return async () => {
    const out = await sts.send(
      new AssumeRoleCommand({
        RoleArn: s.roleArn,
        RoleSessionName: `capture-srv-${accountId.replace(/-/g, '').slice(0, 24)}`,
        DurationSeconds: ROLE_DURATION_SECONDS,
        Policy: JSON.stringify(serverSessionPolicy(s.bucket, prefix)),
      }),
    );
    const c = out.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) throw new Error('STS AssumeRole returned no credentials (capture server store)');
    return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration };
  };
}

function buildStore(accountId: string, s: S3Config): ObjectStore {
  return new ObjectStore(() => ({
    name: 'capture',
    bucket: s.bucket,
    region: regionOf(s),
    endpoint: s.endpoint.trim(),
    forcePathStyle: s.forcePathStyle,
    credentials: serverCredentials(accountId, s),
  }));
}

// replica-local: per-account capture store, keyed by a hash of the resolved config so a
// config change rebuilds it. Each store memoizes its own S3 clients (object-store/s3.ts).
const storeCache = new Map<string, ObjectStore>();

function cachedStore(accountId: string, s: S3Config): ObjectStore {
  const key = `${accountId}:${createHash('sha256').update(JSON.stringify(s)).digest('hex').slice(0, 16)}`;
  let store = storeCache.get(key);
  if (!store) {
    store = buildStore(accountId, s);
    storeCache.clear(); // one account's config changes rarely; no need to grow the map per account.
    storeCache.set(key, store);
  }
  return store;
}

/** The ObjectStore for an account: its own bucket in `s3` mode, else the deployment default. */
export async function captureStoreForAccount(accountId: string): Promise<ObjectStore> {
  const s = await readResolvedStorage(accountId);
  return s.mode === 's3' ? cachedStore(accountId, s) : captureStore;
}

/** Write (or overwrite) one object in the account's store. Server-side encryption is the bucket default. */
export async function putAccountObject(accountId: string, key: string, body: string | Uint8Array, contentType: string): Promise<void> {
  await (await captureStoreForAccount(accountId)).put(key, body, contentType);
}

// ─── credential issuers for a device ─────────────────────────────────────────

function deviceCredentials(s: S3Config, prefix: string, deviceId: string, extra: Partial<CaptureCredentials>): CaptureCredentials {
  return {
    endpoint: endpointOf(s),
    bucket: s.bucket,
    region: regionOf(s),
    prefix,
    device_id: deviceId,
    access_key_id: '',
    secret_access_key: '',
    expires_at_ms: 0,
    path_style: s.forcePathStyle,
    ...extra,
  };
}

function accountStsIssuer(s: S3Config): CaptureCredentialIssuer {
  const sts = stsFor(s);
  return {
    async issue({ prefix, deviceId }) {
      const out = await sts.send(
        new AssumeRoleCommand({
          RoleArn: s.roleArn,
          RoleSessionName: `capture-${deviceId.replace(/-/g, '').slice(0, 32)}`,
          DurationSeconds: ROLE_DURATION_SECONDS,
          Policy: JSON.stringify(deviceSessionPolicy(s.bucket, prefix, deviceId)),
        }),
      );
      const c = out.Credentials;
      if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) throw new Error('STS AssumeRole returned no credentials');
      return deviceCredentials(s, prefix, deviceId, {
        access_key_id: c.AccessKeyId,
        secret_access_key: c.SecretAccessKey,
        session_token: c.SessionToken,
        expires_at_ms: c.Expiration.getTime(),
      });
    },
  };
}

function accountStaticIssuer(s: S3Config): CaptureCredentialIssuer {
  return {
    // Static keys are account-wide, not per-device scoped. A short expiry makes the
    // device re-fetch, so a storage change or revoke reaches it within the hour.
    async issue({ prefix, deviceId }) {
      return deviceCredentials(s, prefix, deviceId, {
        access_key_id: s.accessKeyId,
        secret_access_key: s.secretAccessKey,
        expires_at_ms: Date.now() + ROLE_DURATION_SECONDS * 1000,
      });
    },
  };
}

/** The credential issuer for an account's devices: the account's own store in `s3` mode, else the deployment default. */
export async function captureIssuerForAccount(accountId: string): Promise<CaptureCredentialIssuer | null> {
  const s = await readResolvedStorage(accountId);
  if (s.mode !== 's3') return captureCredentialIssuer();
  if (s.roleArn) return accountStsIssuer(s);
  if (s.accessKeyId && s.secretAccessKey) return accountStaticIssuer(s);
  return null;
}

// ─── reachability probe (on save) ────────────────────────────────────────────

/** Prove a store is reachable and writable: PutObject + DeleteObject of a probe key with the issued credentials. */
export async function probeAccountStore(accountId: string, s: ResolvedStorage): Promise<{ ok: true } | { ok: false; error: string }> {
  if (s.mode !== 's3') return { ok: true };
  const store = buildStore(accountId, s);
  const key = `${accountPrefix(accountId)}/.kortix-probe-${Date.now()}`;
  try {
    await store.put(key, 'ok', 'text/plain');
    await store.remove([key]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error)?.message ?? String(error) };
  }
}

/** Drop the cache. Tests only. */
export function resetAccountStoreCache(): void {
  storeCache.clear();
}
