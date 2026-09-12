/**
 * Leader-elected background publisher and reconciler for repository snapshots.
 *
 * Two loops, one tick:
 *   1. Publish — claim a queued revision, build it, upload it, record readiness.
 *   2. Reconcile — re-resolve refs whose tip the control plane may have missed,
 *      which is the safety net for every repository with no usable webhook.
 *
 * Nothing here runs on a request path. Shape follows
 * `apps/api/src/apps/deployment-worker.ts`: ownership-checked leases, bounded
 * retries, and a heartbeat that fails the attempt when the lease is reclaimed.
 */
import { randomUUID } from 'node:crypto';
import { projects } from '@kortix/db';
import { and, eq, ne, sql } from 'drizzle-orm';
import { config } from '../config';
import { logger } from '../lib/logger';
import { getBranchCommitSha, parseGitHubRepoUrl } from '../projects/github';
import { withProjectGitAuth } from '../projects/lib/git';
import type { ProjectRow } from '../projects/lib/serializers';
import { db } from '../shared/db';
import {
  RepoSnapshotSourceMovedError,
  RepoSnapshotTooLargeError,
  buildRepoSnapshot,
  discardBuiltRepoSnapshot,
} from './build';
import { type RepoSnapshotCompression, normalizeRepoSnapshotIdentity } from './format';
import { ensureRepoSnapshotRepository, withCommit } from './identity';
import { publishRepoSnapshot } from './publish';
import { requireRepoSnapshotBucket, resolveRepoSnapshotBucket } from './s3';
import {
  REPO_SNAPSHOT_MAX_ATTEMPTS,
  claimRefsDueForReconcile,
  claimRepoSnapshot,
  enqueueRepoSnapshot,
  markRepoSnapshotAttemptFailed,
  markRepoSnapshotReady,
  observeRepoRef,
  readRepoRef,
  renewRepoSnapshotLease,
  scheduleRefReconcile,
  type RepoSnapshotRefRow,
} from './store';

const HEARTBEAT_MS = 60_000;

function compression(): RepoSnapshotCompression {
  return (config.KORTIX_REPO_SNAPSHOT_COMPRESSION ?? 'gzip') as RepoSnapshotCompression;
}

function reconcileIntervalMs(): number {
  return Math.max(1, config.KORTIX_REPO_SNAPSHOT_RECONCILE_INTERVAL_MINUTES ?? 15) * 60_000;
}

export function repoSnapshotWorkerEnabled(): boolean {
  return config.KORTIX_REPO_SNAPSHOT_WORKER_ENABLED !== false && !!resolveRepoSnapshotBucket();
}

/**
 * A failure that must NOT consume the retry budget again: the commit is gone,
 * the repository is too large, or identity is wrong. Retrying these produces
 * the same result and hides a real coverage gap behind a retry loop.
 */
function isPermanent(error: unknown): boolean {
  return error instanceof RepoSnapshotSourceMovedError || error instanceof RepoSnapshotTooLargeError;
}

async function projectForSnapshot(sourceProjectId: string | null): Promise<ProjectRow | null> {
  if (!sourceProjectId) return null;
  const [row] = await db.select().from(projects).where(eq(projects.projectId, sourceProjectId)).limit(1);
  return row ?? null;
}

/**
 * Any project that can reach this repository. A snapshot is repository-scoped,
 * so when the project that requested it is gone, another project on the same
 * repository can still supply the server-side source access.
 */
async function anyProjectForRepository(repositoryId: string): Promise<ProjectRow | null> {
  const rows = await db
    .select()
    .from(projects)
    .where(
      and(
        ne(projects.status, 'archived'),
        sql`${projects.metadata} -> 'git' ->> 'external_repo_id' = ${repositoryId}`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function driveOneSnapshot(owner: string): Promise<boolean> {
  const claimed = await claimRepoSnapshot(owner);
  if (!claimed) return false;
  const heartbeat = setInterval(() => {
    void renewRepoSnapshotLease(claimed.snapshotId, owner).catch(() => {});
  }, HEARTBEAT_MS);
  let built: Awaited<ReturnType<typeof buildRepoSnapshot>> | null = null;
  try {
    const project =
      (await projectForSnapshot(claimed.sourceProjectId)) ??
      (await anyProjectForRepository(claimed.repositoryId));
    if (!project) {
      throw Object.assign(new Error('no project can supply source access for this repository'), {
        permanent: true,
      });
    }
    const identity = normalizeRepoSnapshotIdentity({
      provider: claimed.provider,
      repositoryId: claimed.repositoryId,
      owner: claimed.owner,
      repo: claimed.repo,
      commitSha: claimed.commitSha,
    });
    const authed = await withProjectGitAuth(project);
    built = await buildRepoSnapshot(authed, identity, { compression: compression() });
    const published = await publishRepoSnapshot({
      bucket: requireRepoSnapshotBucket(),
      identity,
      manifest: built.manifest,
      archivePath: built.archivePath,
    });
    const ready = await markRepoSnapshotReady({
      snapshotId: claimed.snapshotId,
      owner,
      manifest: published.manifest,
      manifestKey: published.manifestKey,
    });
    if (!ready) {
      // The lease was reclaimed mid-build. The S3 objects are immutable and
      // already durable, so the winner's own write is authoritative.
      logger.warn('[repo-snapshot] lease lost before readiness; winner owns the row', {
        snapshotId: claimed.snapshotId,
      });
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const permanent = isPermanent(error) || (error as { permanent?: boolean })?.permanent === true;
    await markRepoSnapshotAttemptFailed({
      snapshotId: claimed.snapshotId,
      owner,
      attempt: claimed.attemptCount,
      code: error instanceof Error ? error.name : 'Error',
      message,
      terminal: permanent,
    }).catch(() => {});
    logger.warn('[repo-snapshot] build attempt failed', {
      snapshotId: claimed.snapshotId,
      repositoryId: claimed.repositoryId,
      commitSha: claimed.commitSha,
      attempt: claimed.attemptCount,
      maxAttempts: REPO_SNAPSHOT_MAX_ATTEMPTS,
      permanent,
      error: message,
    });
    return true;
  } finally {
    clearInterval(heartbeat);
    if (built) await discardBuiltRepoSnapshot(built);
  }
}

/**
 * Re-resolve one ref against GitHub and enqueue its current tip.
 *
 * The provider is the authority, not the webhook payload: GitHub delivers out
 * of order, and a payload's `after` field describes the push, not the ref's
 * current state after a force push or a racing push. Resolving server-side
 * makes duplicate and reordered events converge on the same answer.
 */
export async function reconcileRef(row: RepoSnapshotRefRow): Promise<
  { ok: true; sha: string | null } | { ok: false; reason: string }
> {
  const project = await anyProjectForRepository(row.repositoryId);
  if (!project) {
    await scheduleRefReconcile({ provider: 'github', repositoryId: row.repositoryId }, row.ref, new Date(Date.now() + reconcileIntervalMs()));
    return { ok: false, reason: 'no project can supply source access for this repository' };
  }
  const branch = row.ref.replace(/^refs\/heads\//, '');
  try {
    const authed = await withProjectGitAuth(project);
    const coordinates = parseGitHubRepoUrl(authed.repoUrl) ?? { owner: row.owner, repo: row.repo };
    const sha = await getBranchCommitSha({
      owner: coordinates.owner,
      repo: coordinates.repo,
      branch,
      auth: authed.gitAuthToken ? { token: authed.gitAuthToken } : undefined,
    });
    await observeRepoRef({
      identity: { provider: 'github', repositoryId: row.repositoryId, owner: row.owner, repo: row.repo },
      ref: row.ref,
      desiredSha: sha,
      via: 'reconcile',
      reconcileAfter: new Date(Date.now() + reconcileIntervalMs()),
    });
    await enqueueRepoSnapshot({
      identity: withCommit(
        { provider: 'github', repositoryId: row.repositoryId, owner: row.owner, repo: row.repo },
        sha,
      ),
      sourceProjectId: project.projectId,
      sourceRef: row.ref,
    });
    return { ok: true, sha };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A deleted branch clears the desired revision; it never leaves a stale one
    // in place pretending to be current.
    if (/404|not found/i.test(message)) {
      await observeRepoRef({
        identity: { provider: 'github', repositoryId: row.repositoryId, owner: row.owner, repo: row.repo },
        ref: row.ref,
        desiredSha: null,
        via: 'reconcile',
        reconcileAfter: new Date(Date.now() + reconcileIntervalMs()),
      });
      return { ok: true, sha: null };
    }
    await scheduleRefReconcile({ provider: 'github', repositoryId: row.repositoryId }, row.ref, new Date(Date.now() + reconcileIntervalMs()));
    return { ok: false, reason: message };
  }
}

/**
 * Record a revision the control plane just observed and queue its publication.
 * Used by import, link, proxy pushes and webhook ingestion.
 */
export async function prepareRevision(input: {
  project: ProjectRow;
  ref: string;
  commitSha: string;
  via: 'webhook' | 'reconcile' | 'proxy_push' | 'import';
}): Promise<{ prepared: true } | { prepared: false; reason: string }> {
  if (!repoSnapshotWorkerEnabled()) return { prepared: false, reason: 'snapshot storage is not configured' };
  const resolved = await ensureRepoSnapshotRepository(input.project);
  if (!resolved.repository) {
    return { prepared: false, reason: resolved.unsupportedReason ?? 'project is not GitHub-backed' };
  }
  const identity = withCommit(resolved.repository, input.commitSha);
  await observeRepoRef({
    identity: resolved.repository,
    ref: input.ref,
    desiredSha: identity.commitSha,
    via: input.via,
    reconcileAfter: new Date(Date.now() + reconcileIntervalMs()),
  });
  await enqueueRepoSnapshot({
    identity,
    sourceProjectId: input.project.projectId,
    sourceRef: input.ref,
  });
  triggerRepoSnapshotWorker();
  return { prepared: true };
}

/** Desired revision for a ref, with no provider call. */
export async function readDesiredRevision(
  repositoryId: string,
  ref: string,
): Promise<{ sha: string | null; observedAt: Date; via: string } | null> {
  const row = await readRepoRef({ provider: 'github', repositoryId }, ref);
  if (!row) return null;
  return { sha: row.desiredSha, observedAt: row.observedAt, via: row.observedVia };
}

const workerState = globalThis as unknown as {
  __kortixRepoSnapshotWorkerTimer?: ReturnType<typeof setInterval> | null;
};
let workerRunning = false;
let workerKickScheduled = false;
let workerRerunRequested = false;

function scheduleTriggeredTick(): void {
  if (workerRunning || workerKickScheduled) return;
  workerKickScheduled = true;
  queueMicrotask(() => {
    workerKickScheduled = false;
    workerRerunRequested = false;
    void runRepoSnapshotTick().catch((error) => {
      logger.error('[repo-snapshot] worker tick failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
}

export function triggerRepoSnapshotWorker(): void {
  if (!repoSnapshotWorkerEnabled()) return;
  workerRerunRequested = true;
  scheduleTriggeredTick();
}

export async function runRepoSnapshotTick(): Promise<{ published: number; reconciled: number }> {
  if (workerRunning || !repoSnapshotWorkerEnabled()) return { published: 0, reconciled: 0 };
  workerRunning = true;
  const owner = `${config.INTERNAL_KORTIX_ENV}:${process.pid}:${randomUUID()}`;
  let published = 0;
  let reconciled = 0;
  try {
    const batch = Math.max(1, Math.min(10, config.KORTIX_REPO_SNAPSHOT_WORKER_BATCH ?? 2));
    for (let index = 0; index < batch; index++) {
      if (!(await driveOneSnapshot(owner))) break;
      published += 1;
    }
    for (const row of await claimRefsDueForReconcile(batch)) {
      await reconcileRef(row);
      reconciled += 1;
    }
    return { published, reconciled };
  } finally {
    workerRunning = false;
    if (workerRerunRequested) scheduleTriggeredTick();
  }
}

export function startRepoSnapshotWorker(): void {
  if (!repoSnapshotWorkerEnabled()) return;
  stopRepoSnapshotWorker();
  const interval = Math.max(1_000, config.KORTIX_REPO_SNAPSHOT_WORKER_INTERVAL_MS ?? 5_000);
  triggerRepoSnapshotWorker();
  workerState.__kortixRepoSnapshotWorkerTimer = setInterval(() => {
    triggerRepoSnapshotWorker();
  }, interval);
}

export function stopRepoSnapshotWorker(): void {
  if (workerState.__kortixRepoSnapshotWorkerTimer) {
    clearInterval(workerState.__kortixRepoSnapshotWorkerTimer);
    workerState.__kortixRepoSnapshotWorkerTimer = null;
  }
}
