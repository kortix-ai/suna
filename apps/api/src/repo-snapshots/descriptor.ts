/**
 * The authenticated boot descriptor a session receives for one pinned revision.
 *
 * Everything here is a pure database read plus one signature computation. It
 * performs NO Git operation, NO GitHub call and NO build: a descriptor is only
 * ever produced for a revision that is already `ready`. A miss is reported as a
 * miss so the caller can apply the mode policy, never papered over with an
 * older revision.
 */
import { config } from '../config';
import { logger } from '../lib/logger';
import {
  REPO_SNAPSHOT_FORMAT,
  type RepoSnapshotCompression,
  type RepoSnapshotIdentity,
  isRepoSnapshotCompression,
  payloadKey,
} from './format';
import { presignRepoSnapshotGet, resolveRepoSnapshotBucket } from './s3';
import { findReadyRepoSnapshot, type RepoSnapshotRow } from './store';

export type RepoSnapshotMode = 'off' | 'shadow' | 'prefer' | 'required';

export function repoSnapshotMode(): RepoSnapshotMode {
  const mode = (config.KORTIX_REPO_SNAPSHOT_MODE ?? 'off') as RepoSnapshotMode;
  // An unconfigured bucket makes every mode behave as `off` rather than
  // failing sessions in `required`.
  return resolveRepoSnapshotBucket() ? mode : 'off';
}

export type RepoSnapshotDelivery = 'presigned' | 'proxy';

export interface RepoSnapshotBootDescriptor {
  url: string;
  /** How the sandbox must fetch `url`. */
  delivery: RepoSnapshotDelivery;
  /**
   * `bearer` means the sandbox attaches its Kortix session token — valid ONLY
   * for a Kortix-origin proxy URL. Object storage is never handed that token.
   */
  auth: 'bearer' | 'none';
  expiresAt: Date;
  sha256: string;
  compression: RepoSnapshotCompression;
  commitSha: string;
  repositoryId: string;
  compressedBytes: number;
  expandedBytes: number;
  entryCount: number;
}

export type RepoSnapshotMiss =
  | { reason: 'disabled' }
  | { reason: 'unsupported_project'; detail: string }
  | { reason: 'not_prepared'; commitSha: string }
  | { reason: 'preparing'; commitSha: string }
  | { reason: 'failed'; commitSha: string; detail: string };

export type RepoSnapshotResolution =
  | { ok: true; descriptor: RepoSnapshotBootDescriptor; row: RepoSnapshotRow }
  | { ok: false; miss: RepoSnapshotMiss };

/**
 * Turn a ready ledger row into a signed, object-scoped capability.
 *
 * The recorded `payloadKey` is preferred over a freshly derived one: a
 * repository rename changes the derived prefix, and an already-published object
 * must stay readable at the location it was written to.
 */
export function repoSnapshotDelivery(): RepoSnapshotDelivery {
  return (config.KORTIX_REPO_SNAPSHOT_DELIVERY ?? 'presigned') as RepoSnapshotDelivery;
}

/** `GET /v1/git/{project}/repo-snapshot/archive?sha=…` on this API's origin. */
export function proxyArchiveUrl(apiBase: string, projectId: string, commitSha: string): string {
  return `${apiBase.replace(/\/+$/, '')}/git/${encodeURIComponent(projectId)}/repo-snapshot/archive?sha=${commitSha}`;
}

export async function describeReadySnapshot(
  row: RepoSnapshotRow,
  options: { projectId?: string; apiBase?: string } = {},
): Promise<RepoSnapshotBootDescriptor | null> {
  const bucket = resolveRepoSnapshotBucket();
  if (!bucket) return null;
  if (
    row.status !== 'ready' ||
    !row.archiveSha256 ||
    !isRepoSnapshotCompression(row.compression) ||
    row.compressedBytes === null ||
    row.expandedBytes === null ||
    row.entryCount === null
  ) {
    return null;
  }
  const identity: RepoSnapshotIdentity = {
    provider: 'github',
    repositoryId: row.repositoryId,
    owner: row.owner,
    repo: row.repo,
    commitSha: row.commitSha,
  };
  const key = row.payloadKey ?? payloadKey(identity, row.archiveSha256, row.compression);
  const ttl = config.KORTIX_REPO_SNAPSHOT_URL_TTL_SECONDS ?? 3600;
  const delivery = repoSnapshotDelivery();
  // Proxy delivery keeps the object store private to the API. It costs API
  // bandwidth, so it is opt-in, but it is the ONLY mode that works when a
  // sandbox cannot route to the bucket.
  const location =
    delivery === 'proxy' && options.projectId && options.apiBase
      ? {
          url: proxyArchiveUrl(options.apiBase, options.projectId, row.commitSha),
          expiresAt: new Date(Date.now() + ttl * 1000),
        }
      : await presignRepoSnapshotGet(bucket, key, ttl);
  const usingProxy = delivery === 'proxy' && options.projectId !== undefined && options.apiBase !== undefined;
  return {
    url: location.url,
    delivery: usingProxy ? 'proxy' : 'presigned',
    auth: usingProxy ? 'bearer' : 'none',
    expiresAt: location.expiresAt,
    sha256: row.archiveSha256,
    compression: row.compression,
    commitSha: row.commitSha,
    repositoryId: row.repositoryId,
    compressedBytes: row.compressedBytes,
    expandedBytes: row.expandedBytes,
    entryCount: row.entryCount,
  };
}

/**
 * Resolve the descriptor for one exact revision.
 *
 * `commitSha` is the pinned revision and nothing else is accepted: there is no
 * "closest ready" fallback, because substituting a different revision is the
 * failure mode this whole design rules out.
 */
export async function resolveSnapshotForRevision(input: {
  repositoryId: string;
  commitSha: string;
  /** Required for proxy delivery; ignored for presigned. */
  projectId?: string;
  apiBase?: string;
}): Promise<RepoSnapshotResolution> {
  if (repoSnapshotMode() === 'off') return { ok: false, miss: { reason: 'disabled' } };
  const row = await findReadyRepoSnapshot({
    provider: 'github',
    repositoryId: input.repositoryId,
    commitSha: input.commitSha,
  });
  if (!row) return { ok: false, miss: { reason: 'not_prepared', commitSha: input.commitSha } };
  const descriptor = await describeReadySnapshot(row, {
    projectId: input.projectId,
    apiBase: input.apiBase,
  }).catch((error) => {
    logger.warn('[repo-snapshot] could not sign descriptor', {
      repositoryId: input.repositoryId,
      commitSha: input.commitSha,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  if (!descriptor) return { ok: false, miss: { reason: 'not_prepared', commitSha: input.commitSha } };
  return { ok: true, descriptor, row };
}

/** JSON body of `GET /git/{project}/repo-snapshot`. Carries no bucket name. */
export function serializeBootDescriptor(descriptor: RepoSnapshotBootDescriptor): Record<string, unknown> {
  return {
    format: REPO_SNAPSHOT_FORMAT,
    url: descriptor.url,
    delivery: descriptor.delivery,
    auth: descriptor.auth,
    expires_at: descriptor.expiresAt.toISOString(),
    sha256: descriptor.sha256,
    compression: descriptor.compression,
    commit_sha: descriptor.commitSha,
    repository_id: descriptor.repositoryId,
    compressed_bytes: descriptor.compressedBytes,
    expanded_bytes: descriptor.expandedBytes,
    entry_count: descriptor.entryCount,
  };
}

/** Sandbox env for a pinned snapshot. Empty when there is nothing pinned. */
export function snapshotSessionEnv(
  mode: RepoSnapshotMode,
  descriptor: RepoSnapshotBootDescriptor | null,
): Record<string, string> {
  if (mode === 'off' || !descriptor) return {};
  return {
    KORTIX_REPO_SNAPSHOT_MODE: mode,
    KORTIX_REPO_SNAPSHOT_URL: descriptor.url,
    KORTIX_REPO_SNAPSHOT_AUTH: descriptor.auth,
    KORTIX_REPO_SNAPSHOT_SHA256: descriptor.sha256,
    KORTIX_REPO_SNAPSHOT_COMPRESSION: descriptor.compression,
    KORTIX_REPO_SNAPSHOT_COMMIT_SHA: descriptor.commitSha,
    KORTIX_REPO_SNAPSHOT_REPOSITORY_ID: descriptor.repositoryId,
    KORTIX_REPO_SNAPSHOT_COMPRESSED_BYTES: String(descriptor.compressedBytes),
    KORTIX_REPO_SNAPSHOT_EXPANDED_BYTES: String(descriptor.expandedBytes),
    KORTIX_REPO_SNAPSHOT_ENTRY_COUNT: String(descriptor.entryCount),
  };
}
