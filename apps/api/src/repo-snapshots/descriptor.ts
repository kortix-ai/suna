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

/** True when storage is configured; false means `required` will fail closed. */
export function repoSnapshotStorageConfigured(): boolean {
  return resolveRepoSnapshotBucket() !== null;
}

/**
 * The configured mode.
 *
 * An unconfigured bucket degrades `shadow` and `prefer` to `off` — both are
 * best-effort and there is nothing to serve. `required` is NOT degraded: an
 * operator who asked to fail closed must not be silently switched to the Git
 * path by a missing environment variable. It stays `required` and every
 * eligible start then reports a preparation error naming the misconfiguration,
 * which is visible, instead of a silent downgrade, which is not.
 */
export function resolveRepoSnapshotMode(
  configured: RepoSnapshotMode,
  storageConfigured: boolean,
): RepoSnapshotMode {
  if (storageConfigured) return configured;
  return configured === 'required' ? 'required' : 'off';
}

export function repoSnapshotMode(): RepoSnapshotMode {
  return resolveRepoSnapshotMode(
    (config.KORTIX_REPO_SNAPSHOT_MODE ?? 'off') as RepoSnapshotMode,
    repoSnapshotStorageConfigured(),
  );
}

/**
 * The canary cohort: project ids this mode applies to, or every project.
 *
 * A rollout wants a handful of real projects on `prefer` while the rest of the
 * deployment keeps its existing behaviour, and the ability to take them back
 * off in one deploy. That is what this list is — a deployment-level allowlist,
 * with no per-project database state and no user-facing surface to get out of
 * step with it.
 *
 * Empty (the default) means EVERY project, so an operator who never sets it
 * gets the plain deployment-wide mode. `*` is accepted as the explicit spelling
 * of the same thing.
 */
export function parseRepoSnapshotCohort(raw: string | null | undefined): Set<string> | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || trimmed === '*') return null;
  const ids = trimmed
    .split(',')
    .map((id) => id.trim().toLowerCase())
    .filter((id) => id.length > 0);
  return ids.length > 0 ? new Set(ids) : null;
}

export function repoSnapshotCohort(): Set<string> | null {
  return parseRepoSnapshotCohort(config.KORTIX_REPO_SNAPSHOT_COHORT);
}

/** The pure decision: does this deployment-wide mode apply to this project? */
export function applyRepoSnapshotCohort(
  mode: RepoSnapshotMode,
  projectId: string,
  cohort: Set<string> | null,
): RepoSnapshotMode {
  if (mode === 'off') return 'off';
  return !cohort || cohort.has(projectId.toLowerCase()) ? mode : 'off';
}

/**
 * The mode in effect FOR ONE PROJECT.
 *
 * Outside the cohort a project behaves exactly as it did before this feature —
 * `off` — whatever the deployment-wide mode says. This is the only control that
 * decides whether a given session takes the prepared path, so every entry point
 * asks it rather than the global mode.
 */
export function repoSnapshotModeForProject(projectId: string): RepoSnapshotMode {
  return applyRepoSnapshotCohort(repoSnapshotMode(), projectId, repoSnapshotCohort());
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
  | {
      reason: 'unsupported_project';
      detail: string;
      /** Only a GitHub-backed project is in this policy's scope. */
      githubBacked: boolean;
    }
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
  const mode = repoSnapshotMode();
  if (mode === 'off') return { ok: false, miss: { reason: 'disabled' } };
  if (!repoSnapshotStorageConfigured()) {
    // `required` with no bucket. Say so plainly rather than pretend the
    // revision merely is not prepared yet.
    return {
      ok: false,
      miss: {
        reason: 'failed',
        commitSha: input.commitSha,
        detail: 'KORTIX_REPO_SNAPSHOT_BUCKET is unset, so no snapshot can be served',
      },
    };
  }
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
