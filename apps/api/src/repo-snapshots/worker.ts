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
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { config } from '../config';
import { logger } from '../lib/logger';
import { getBranchCommitSha, listRepositoryBranches, parseGitHubRepoUrl } from '../projects/github';
import { withProjectGitAuth } from '../projects/lib/git';
import { metadataMergeSubtree } from '../projects/lib/metadata-merge';
import { confirmBranchDeleted } from './prepare';
import type { ProjectRow } from '../projects/lib/serializers';
import { db } from '../shared/db';
import {
  RepoSnapshotSourceMovedError,
  RepoSnapshotTooLargeError,
  buildRepoSnapshot,
  discardBuiltRepoSnapshot,
} from './build';
import { type RepoSnapshotCompression, normalizeRepoSnapshotIdentity } from './format';
import type { RepoSnapshotRepository } from './identity';
import {
  discoveryMarkerSql,
  effectiveGitSubtreeSql,
  ensureRepoSnapshotRepository,
  githubBackedProjectsSql,
  gitMetadataSubtree,
  pendingPushedRefs,
  advanceOverflowCursorExpr,
  clearPendingOverflowExpr,
  pendingOverflowState,
  pendingOverflowUnchanged,
  readRepoSnapshotRepository,
  recordedRepositoryIdSql,
  removePendingPushedRefsExpr,
  withCommit,
} from './identity';
import { publishRepoSnapshot } from './publish';
import { requireRepoSnapshotBucket, resolveRepoSnapshotBucket } from './s3';
import {
  REPO_SNAPSHOT_MAX_ATTEMPTS,
  beginRefObservation,
  claimRefsDueForReconcile,
  ensureRefReconcileScheduled,
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
    .where(and(ne(projects.status, 'archived'), sql`${recordedRepositoryIdSql} = ${repositoryId}`))
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
  let token: Awaited<ReturnType<typeof beginRefObservation>> | undefined;
  // Hoisted for the 404 path: deciding a branch is deleted takes the same
  // coordinates and the same credential. See `confirmBranchDeleted`.
  let coordinates = { owner: row.owner, repo: row.repo };
  let auth: { token: string } | undefined;
  try {
    const authed = await withProjectGitAuth(project);
    coordinates = parseGitHubRepoUrl(authed.repoUrl) ?? coordinates;
    auth = authed.gitAuthToken ? { token: authed.gitAuthToken } : undefined;
    token = await beginRefObservation(
      { provider: 'github', repositoryId: row.repositoryId },
      row.ref,
    );
    const sha = await getBranchCommitSha({
      owner: coordinates.owner,
      repo: coordinates.repo,
      branch,
      auth,
    });
    await observeRepoRef({
      identity: { provider: 'github', repositoryId: row.repositoryId, owner: row.owner, repo: row.repo },
      ref: row.ref,
      desiredSha: sha,
      via: 'reconcile',
      reconcileAfter: new Date(Date.now() + reconcileIntervalMs()),
      token,
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
    // in place pretending to be current. A 404 alone does not prove deletion.
    if (token && (await confirmBranchDeleted({ ...coordinates, error, auth }))) {
      // Carries the SAME generation token as the success path. Without it a
      // lookup that started while the branch was absent could return 404 after
      // someone else recorded a recreated branch's SHA, and erase it.
      await observeRepoRef({
        identity: { provider: 'github', repositoryId: row.repositoryId, owner: row.owner, repo: row.repo },
        ref: row.ref,
        desiredSha: null,
        via: 'reconcile',
        reconcileAfter: new Date(Date.now() + reconcileIntervalMs()),
        token,
      });
      return { ok: true, sha: null };
    }
    await scheduleRefReconcile({ provider: 'github', repositoryId: row.repositoryId }, row.ref, new Date(Date.now() + reconcileIntervalMs()));
    return { ok: false, reason: message };
  }
}

/**
 * How long a failed discovery attempt is skipped.
 *
 * Recorded in the project's own metadata, not in memory: the scan is ordered by
 * that timestamp, so a project whose lookup keeps failing moves to the BACK of
 * the queue instead of occupying the first page forever. In-memory skipping
 * cannot do this — the rows are already chosen by then, and skipping one after
 * `limit` has been applied advances nothing.
 */
export const REPO_SNAPSHOT_DISCOVERY_RETRY_MS = 10 * 60_000;

/**
 * Mark a discovery attempt. Written BEFORE the lookup, so a crash still
 * advances the scan, and into the subtree the project already uses — see
 * `gitMetadataSubtree`, which a legacy project depends on for its whole
 * credential routing.
 */
async function markDiscoveryAttempt(project: ProjectRow): Promise<void> {
  await db
    .update(projects)
    .set({
      metadata: metadataMergeSubtree(gitMetadataSubtree(project), {
        snapshot_discovery_at: new Date().toISOString(),
      }),
    })
    .where(eq(projects.projectId, project.projectId));
}

/** Test seam: forget every recorded discovery attempt for these projects. */
export async function resetRepoSnapshotDiscoveryBackoff(projectIds: string[]): Promise<void> {
  for (const projectId of projectIds) {
    const [project] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
    if (!project) continue;
    await db
      .update(projects)
      .set({ metadata: metadataMergeSubtree(gitMetadataSubtree(project), { snapshot_discovery_at: null }) })
      .where(eq(projects.projectId, projectId));
  }
}



/**
 * GitHub-backed projects that have never been registered, retried.
 *
 * Everything else in this worker is driven by ref ROWS, and a project whose
 * very first identity lookup failed has none: `prepareRefTip` returns before it
 * can schedule anything, so nothing would ever look at that project again
 * without another webhook or a manual backfill. This is the only pass that can
 * rediscover it.
 *
 * Ordered by last attempt, oldest first, so every eligible project is reached
 * in turn and a permanently failing one cannot hold the front of the queue.
 */
export async function discoverUnregisteredProjects(limit: number): Promise<number> {
  const cutoff = new Date(Date.now() - REPO_SNAPSHOT_DISCOVERY_RETRY_MS).toISOString();
  const candidates = await db
    .select()
    .from(projects)
    .where(
      and(
        ne(projects.status, 'archived'),
        githubBackedProjectsSql,
        sql`${recordedRepositoryIdSql} is null`,
        // ISO-8601 UTC sorts and compares lexicographically in time order, and
        // '' (never attempted) sorts before every timestamp. No cast, so a bad
        // value can never fail the whole scan.
        sql`${discoveryMarkerSql} < ${cutoff}`,
      ),
    )
    .orderBy(discoveryMarkerSql)
    .limit(Math.max(1, limit));

  let discovered = 0;
  for (const project of candidates) {
    await markDiscoveryAttempt(project);
    const resolved = await ensureRepoSnapshotRepository(project).catch(() => null);
    if (!resolved?.repository) continue;
    discovered += 1;
    logger.info('[repo-snapshot] registered a previously unidentified project', {
      projectId: project.projectId,
      repositoryId: resolved.repository.repositoryId,
    });
    // Branches a push parked while this project had no identity. Now it has
    // one, so they get real ref rows and the parking slot is released.
    await drainPendingPushedRefs(project, resolved.repository);
  }
  return discovered;
}

/**
 * Give parked branches real ref rows, and release exactly those.
 *
 * Releasing the whole list would drop a branch a push parked while these were
 * being scheduled, and would release refs a partial failure never scheduled.
 */
async function drainPendingPushedRefs(
  project: ProjectRow,
  repository: RepoSnapshotRepository,
): Promise<number> {
  // More branches were pushed than the parking slot holds, so the parked list
  // is not the accepted set. Ask the provider for the authoritative one — the
  // truncated names are a hint, the repository's own branch list is the answer.
  //
  // ONE PAGE per pass, resuming from where the last pass of THIS generation
  // stopped. Everything below is bound to `overflowSeq`: a push that overflows
  // while this runs raises a new generation, every write here becomes a no-op,
  // and the next pass starts that generation from its first page.
  const state = pendingOverflowState(project);
  if (state.overflowSeq !== null) {
    const overflowSeq = state.overflowSeq;
    const page = state.page;
    const names = await enumerateBranchPage(project, repository, page).catch((error) => {
      logger.warn('[repo-snapshot] could not enumerate branches for an overflowed push', {
        projectId: project.projectId,
        page,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    if (names) {
      const at = new Date();
      let scheduled = 0;
      for (const ref of names) {
        await ensureRefReconcileScheduled({ identity: repository, ref, at }).then(
          () => {
            scheduled += 1;
          },
          () => {},
        );
      }
      // Only a page every one of whose refs landed may be left behind; a
      // partial page is retried, never skipped.
      const complete = scheduled === names.length;
      const lastPage = names.length < BRANCH_PAGE_SIZE;
      if (complete) {
        const metadataExpr = lastPage
          ? clearPendingOverflowExpr(project)
          : advanceOverflowCursorExpr(project, page + 1, overflowSeq);
        await db
          .update(projects)
          .set({ metadata: metadataExpr })
          .where(
            and(eq(projects.projectId, project.projectId), pendingOverflowUnchanged(project, overflowSeq)),
          )
          .catch(() => {});
      }
      logger.info('[repo-snapshot] enumerated a branch page after an overflowed push', {
        projectId: project.projectId,
        generation: overflowSeq,
        page,
        branches: names.length,
        scheduled,
        done: complete && lastPage,
      });
      return scheduled;
    }
  }

  const parked = pendingPushedRefs(project);
  if (parked.length === 0) return 0;
  const at = new Date();
  const scheduled: string[] = [];
  for (const ref of parked) {
    await ensureRefReconcileScheduled({ identity: repository, ref, at }).then(
      () => {
        scheduled.push(ref);
      },
      () => {},
    );
  }
  if (scheduled.length > 0) {
    await db
      .update(projects)
      .set({ metadata: removePendingPushedRefsExpr(project, scheduled) })
      .where(eq(projects.projectId, project.projectId))
      .catch(() => {});
  }
  logger.info('[repo-snapshot] replayed parked pushed refs', {
    projectId: project.projectId,
    parked: parked.length,
    scheduled: scheduled.length,
  });
  return scheduled.length;
}

/** Branches per enumeration pass; one provider request. */
const BRANCH_PAGE_SIZE = 100;

/** One page of the repository's branches, as the provider reports them. */
async function enumerateBranchPage(
  project: ProjectRow,
  repository: RepoSnapshotRepository,
  page: number,
): Promise<string[]> {
  const authed = await withProjectGitAuth(project);
  const coordinates = parseGitHubRepoUrl(authed.repoUrl) ?? {
    owner: repository.owner,
    repo: repository.repo,
  };
  const branches = await listRepositoryBranches({
    owner: coordinates.owner,
    repo: coordinates.repo,
    auth: { token: authed.gitAuthToken ?? '' },
    page,
    perPage: BRANCH_PAGE_SIZE,
  });
  return branches.map((branch) => branch.name).filter(Boolean);
}

/**
 * Projects that are REGISTERED and still carry parked branches.
 *
 * The discovery scan only sees unregistered projects, so a list parked by a
 * push whose identity lookup failed — and whose project was registered by
 * something else afterwards — would never be drained by anything.
 */
export async function drainRegisteredPendingRefs(limit: number): Promise<number> {
  const candidates = await db
    .select()
    .from(projects)
    .where(
      and(
        ne(projects.status, 'archived'),
        githubBackedProjectsSql,
        sql`${recordedRepositoryIdSql} ~ '^[0-9]{1,20}$'`,
        sql`(
          (jsonb_typeof(${effectiveGitSubtreeSql} -> 'snapshot_pending_refs') = 'array'
           and jsonb_array_length(${effectiveGitSubtreeSql} -> 'snapshot_pending_refs') > 0)
          or jsonb_typeof(${effectiveGitSubtreeSql} -> 'snapshot_pending_overflow_seq') = 'number'
        )`,
      ),
    )
    .orderBy(asc(projects.updatedAt))
    .limit(Math.max(1, limit));

  let drained = 0;
  for (const project of candidates) {
    const repository = readRepoSnapshotRepository(project).repository;
    if (!repository) continue;
    drained += await drainPendingPushedRefs(project, repository);
  }
  return drained;
}

/**
 * Registered projects whose default branch has no ref row, given one.
 *
 * A project is only reconciled through its ref rows, so a project that has an
 * identity but no row is as invisible as an unregistered one. That state is
 * reachable in several ways — a failed write right after the id was persisted,
 * a row deleted by hand, an identity recorded by an older build that never
 * scheduled anything — and none of them leaves a marker to retry from. The
 * missing row IS the marker, so this asks the database for it directly.
 */
export async function scheduleMissingDefaultRefs(limit: number): Promise<number> {
  const candidates = await db
    .select()
    .from(projects)
    .where(
      and(
        ne(projects.status, 'archived'),
        githubBackedProjectsSql,
        sql`${recordedRepositoryIdSql} ~ '^[0-9]{1,20}$'`,
        sql`not exists (
          select 1 from kortix.repo_snapshot_refs r
          where r.provider = 'github'
            and r.repository_id = ${recordedRepositoryIdSql}
            and r.ref = regexp_replace(coalesce(nullif(${projects.defaultBranch}, ''), 'main'), '^refs/heads/', '')
        )`,
      ),
    )
    .orderBy(asc(projects.updatedAt))
    .limit(Math.max(1, limit));

  let scheduled = 0;
  for (const project of candidates) {
    const repository = readRepoSnapshotRepository(project).repository;
    if (!repository) continue;
    // Every candidate is attempted, so one row that cannot be written consumes
    // its own slot and nothing else's.
    try {
      await ensureRefReconcileScheduled({
        identity: repository,
        ref: project.defaultBranch || 'main',
        at: new Date(),
      });
      scheduled += 1;
    } catch (error) {
      logger.warn('[repo-snapshot] could not schedule the first reconcile', {
        projectId: project.projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return scheduled;
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
  /** Generation taken before the lookup; see `beginRefObservation`. */
  token?: import('./store').RefObservationToken;
  /**
   * The identity the caller already resolved.
   *
   * Without it this re-resolves per call, and a caller looping over a push's
   * branches hands in the SAME pre-registration project row every time — so a
   * project that had no repository id pays one GitHub lookup and one metadata
   * write per ref.
   */
  repository?: RepoSnapshotRepository;
}): Promise<{ prepared: true } | { prepared: false; reason: string }> {
  if (!repoSnapshotWorkerEnabled()) return { prepared: false, reason: 'snapshot storage is not configured' };
  const repository = input.repository ?? (await ensureRepoSnapshotRepository(input.project)).repository;
  if (!repository) {
    return {
      prepared: false,
      reason: readRepoSnapshotRepository(input.project).unsupportedReason ?? 'project is not GitHub-backed',
    };
  }
  const identity = withCommit(repository, input.commitSha);
  await observeRepoRef({
    identity: repository,
    ref: input.ref,
    desiredSha: identity.commitSha,
    via: input.via,
    reconcileAfter: new Date(Date.now() + reconcileIntervalMs()),
    token: input.token,
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
let workerStopped = false;
/** The tick a trigger started, so a caller can wait for it to finish. */
let workerTick: Promise<unknown> | null = null;

function scheduleTriggeredTick(): void {
  if (workerRunning || workerKickScheduled || workerStopped) return;
  workerKickScheduled = true;
  queueMicrotask(() => {
    workerKickScheduled = false;
    workerRerunRequested = false;
    if (workerStopped) return;
    workerTick = runRepoSnapshotTick().catch((error) => {
      logger.error('[repo-snapshot] worker tick failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
}

/**
 * Wait for whatever the worker is doing right now.
 *
 * A triggered tick is scheduled on a microtask and runs detached, so a caller
 * that stops the worker has no way to know the last one has finished — a
 * shutdown, or a test, otherwise races writes it can no longer see.
 */
export async function awaitRepoSnapshotWorkerIdle(): Promise<void> {
  for (let attempt = 0; attempt < 50 && (workerTick || workerKickScheduled || workerRunning); attempt += 1) {
    await workerTick?.catch(() => {});
    if (!workerKickScheduled && !workerRunning) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function triggerRepoSnapshotWorker(): void {
  if (!repoSnapshotWorkerEnabled()) return;
  workerRerunRequested = true;
  scheduleTriggeredTick();
}

export async function runRepoSnapshotTick(): Promise<{
  published: number;
  reconciled: number;
  discovered: number;
}> {
  if (workerRunning || !repoSnapshotWorkerEnabled())
    return { published: 0, reconciled: 0, discovered: 0 };
  workerRunning = true;
  const owner = `${config.INTERNAL_KORTIX_ENV}:${process.pid}:${randomUUID()}`;
  let published = 0;
  let reconciled = 0;
  let discovered = 0;
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
    // The two self-healing scans. Both are bounded, both return nothing once
    // every GitHub project carries an id and a ref row, and together they are
    // the ONLY paths that recover a project whose first preparation failed:
    // `prepareRefTip` has no row to schedule a retry against.
    discovered = await discoverUnregisteredProjects(batch).catch((error) => {
      logger.warn('[repo-snapshot] project discovery pass failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    });
    await scheduleMissingDefaultRefs(batch).catch((error) => {
      logger.warn('[repo-snapshot] missing-ref scan failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    await drainRegisteredPendingRefs(batch).catch((error) => {
      logger.warn('[repo-snapshot] parked-ref drain failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return { published, reconciled, discovered };
  } finally {
    workerRunning = false;
    if (workerRerunRequested) scheduleTriggeredTick();
  }
}

export function startRepoSnapshotWorker(): void {
  if (!repoSnapshotWorkerEnabled()) return;
  stopRepoSnapshotWorker();
  workerStopped = false;
  const interval = Math.max(1_000, config.KORTIX_REPO_SNAPSHOT_WORKER_INTERVAL_MS ?? 5_000);
  triggerRepoSnapshotWorker();
  workerState.__kortixRepoSnapshotWorkerTimer = setInterval(() => {
    triggerRepoSnapshotWorker();
  }, interval);
}

export function stopRepoSnapshotWorker(): void {
  // Stops EVERYTHING it started: the interval, and any triggered tick that has
  // not begun. A tick already running finishes; `awaitRepoSnapshotWorkerIdle`
  // is how a caller waits for it.
  workerStopped = true;
  if (workerState.__kortixRepoSnapshotWorkerTimer) {
    clearInterval(workerState.__kortixRepoSnapshotWorkerTimer);
    workerState.__kortixRepoSnapshotWorkerTimer = null;
  }
}
