/**
 * Preparation entry points: the places that learn a repository revision exists.
 *
 * Every one of them does the same two things — record the observed revision and
 * queue its publication — and none of them blocks the operation it hangs off.
 * The publisher re-resolves the tip server-side, so a caller that passes a
 * stale or out-of-order value cannot publish the wrong revision as current.
 */
import { config } from '../config';
import { logger } from '../lib/logger';
import { getBranchCommitSha, getRepo, parseGitHubRepoUrl } from '../projects/github';
import type { GitHubApiError } from '../projects/github';
import { withProjectGitAuth } from '../projects/lib/git';
import type { ProjectRow } from '../projects/lib/serializers';
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { metadataMergeSubtree } from '../projects/lib/metadata-merge';
import {
  clearPendingPushedRefsFields,
  ensureRepoSnapshotRepository,
  gitMetadataSubtree,
  pendingPushedRefs,
  pendingPushedRefsFields,
  readRepoSnapshotRepository,
} from './identity';
import { beginRefObservation, ensureRefReconcileScheduled, observeRepoRef } from './store';
import { prepareRevision, repoSnapshotWorkerEnabled, triggerRepoSnapshotWorker } from './worker';

export type PrepareResult = { prepared: true; commitSha: string } | { prepared: false; reason: string };

/** Everything one preparation needs, resolved once. */
interface PrepareContext {
  project: ProjectRow;
  repository: NonNullable<Awaited<ReturnType<typeof ensureRepoSnapshotRepository>>['repository']>;
  coordinates: { owner: string; repo: string };
  auth?: { token: string };
}

/**
 * Resolve the identity and the credential for one project, once.
 *
 * Both are per-PROJECT, not per-ref: resolving them inside a loop over a push's
 * branches cost three provider round trips per ref where one per push is
 * enough, and — worse — read the identity before the first preparation had
 * registered it, so the refs after the budget saw a project that "had no
 * repository id" and were dropped.
 */
async function prepareContext(
  project: ProjectRow,
): Promise<PrepareContext | { prepared: false; reason: string }> {
  const resolved = await ensureRepoSnapshotRepository(project);
  if (!resolved.repository) {
    return { prepared: false, reason: resolved.unsupportedReason ?? 'project is not GitHub-backed' };
  }
  const context: PrepareContext = {
    project,
    repository: resolved.repository,
    coordinates: { owner: resolved.repository.owner, repo: resolved.repository.repo },
  };
  try {
    const authed = await withProjectGitAuth(project);
    context.coordinates = parseGitHubRepoUrl(authed.repoUrl) ?? context.coordinates;
    context.auth = authed.gitAuthToken ? { token: authed.gitAuthToken } : undefined;
  } catch {
    // Leave the credential unset: every caller records a retry deadline for the
    // refs it could not resolve, and the reconcile pass tries again later.
  }
  return context;
}

/**
 * Prepare the current tip of `ref`.
 *
 * The tip is resolved from GitHub, not from a push payload or a mirror: this
 * runs off the request path, and the provider is the only thing that knows the
 * ref's state after a force push or a racing push.
 */
export async function prepareRefTip(
  project: ProjectRow,
  ref: string,
  via: 'webhook' | 'proxy_push' | 'import' | 'reconcile',
): Promise<PrepareResult> {
  if (!repoSnapshotWorkerEnabled()) return { prepared: false, reason: 'snapshot storage is not configured' };
  const context = await prepareContext(project);
  if ('prepared' in context) return context;
  return prepareRefTipWith(context, ref, via);
}

/** One ref, with the project's identity and credential already resolved. */
async function prepareRefTipWith(
  context: PrepareContext,
  ref: string,
  via: 'webhook' | 'proxy_push' | 'import' | 'reconcile',
): Promise<PrepareResult> {
  const { project, repository, coordinates, auth } = context;
  const branch = ref.replace(/^refs\/heads\//, '');
  // Declared outside the try: the 404 path must record its result under the
  // SAME generation the lookup started from.
  let token: Awaited<ReturnType<typeof beginRefObservation>> | undefined;
  try {
    // Taken BEFORE the provider call. Anything recorded while this lookup is in
    // flight invalidates it, so a slower request cannot outrank a newer one by
    // finishing later. See `beginRefObservation`.
    token = await beginRefObservation(
      { provider: 'github', repositoryId: repository.repositoryId },
      ref,
    );
    const commitSha = await getBranchCommitSha({
      owner: coordinates.owner,
      repo: coordinates.repo,
      branch,
      auth,
    });
    const outcome = await prepareRevision({ project, ref, commitSha, via, token, repository });
    return outcome.prepared ? { prepared: true, commitSha } : { prepared: false, reason: outcome.reason };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // No token means the failure happened before the lookup even started —
    // there is nothing to be stale against and nothing to delete.
    if (token && (await confirmBranchDeleted({ ...coordinates, error, auth }))) {
      // The branch is gone and the repository is visible. Clear the desired
      // revision instead of leaving a stale one pretending to be current — but
      // under the SAME generation guard as a success, so a 404 already in
      // flight when someone recreated the branch cannot erase the new SHA. And
      // keep a reconcile deadline: a null with no deadline is invisible to the
      // due scan forever, so a branch that comes back is never noticed.
      await observeRepoRef({
        identity: repository,
        ref,
        desiredSha: null,
        via: via === 'reconcile' ? 'reconcile' : 'webhook',
        reconcileAfter: new Date(Date.now() + reconcileRetryDelayMs()),
        token,
      });
      return { prepared: false, reason: `ref ${ref} no longer exists` };
    }
    // Any other failure leaves NO revision recorded, so without this the ref
    // would never be looked at again — the row reconciliation scans is the only
    // thing that brings a project back. Schedule the retry, and never touch a
    // desired SHA that may already be correct.
    await ensureRefReconcileScheduled({
      identity: repository,
      ref,
      at: new Date(Date.now() + reconcileRetryDelayMs()),
    }).catch(() => {});
    return { prepared: false, reason: message };
  }
}

/**
 * Did this 404 genuinely mean "the branch is gone"?
 *
 * GitHub answers 404 for a repository the token cannot see, and the error text
 * is identical to a missing ref: both read
 * `GitHub /repos/o/r/git/ref/heads%2Fmain failed (404): Not Found`. The request
 * path proves which endpoint was called, never that the credential could see
 * the repository — so wording cannot decide this, and erasing a good SHA on a
 * permissions blip would take every session on that ref down with it.
 *
 * The only thing that settles it is a second, repository-level read with the
 * SAME credential. It succeeds -> the token can see the repository, so a ref
 * 404 is a real deletion. It fails for any reason -> ambiguous, so the caller
 * keeps the recorded revision and retries.
 */
export async function confirmBranchDeleted(input: {
  error: unknown;
  owner: string;
  repo: string;
  auth?: { token: string };
}): Promise<boolean> {
  // Matched on shape, not on the constructor: several suites replace
  // `projects/github` with a partial mock, and importing the class as a VALUE
  // here would make this module fail to load inside any of them.
  const error = input.error as Partial<GitHubApiError> | undefined;
  if (!error || error.name !== 'GitHubApiError' || error.status !== 404) return false;
  // Anything but the ref endpoint is a different question entirely.
  if (typeof error.path !== 'string' || !/\/git\/ref\//.test(error.path)) return false;
  try {
    await getRepo({ owner: input.owner, repo: input.repo, auth: input.auth });
    return true;
  } catch {
    return false;
  }
}

/** Backoff before a failed preparation is re-examined. */
function reconcileRetryDelayMs(): number {
  return Math.max(1, config.KORTIX_REPO_SNAPSHOT_RECONCILE_INTERVAL_MINUTES ?? 15) * 60_000;
}

/** A successful push through the Kortix git proxy. */
export async function prepareRevisionForPush(project: ProjectRow, ref: string): Promise<PrepareResult> {
  return prepareRefTip(project, ref, 'proxy_push');
}

/**
 * Branches prepared INLINE per push. Beyond this the work is left to the
 * worker: a bulk push (a mirror sync, a branch import) must not turn into one
 * provider lookup per ref on a background task.
 */
export const PREPARE_REFS_PER_PUSH = 20;

/**
 * Every branch one push touched.
 *
 * The project's identity and credential are resolved ONCE, before anything
 * else. That matters twice over: it turns three provider round trips per ref
 * into one per push, and it REGISTERS a project that had no repository id yet —
 * without which every ref past the inline budget was silently dropped, because
 * there was no key to store it under.
 *
 * Each ref is then given a durable reconcile deadline. That is a local write
 * with no provider call, and it is what makes the inline budget safe: a ref
 * past the budget, or one whose preparation throws, still has a row the
 * reconcile pass picks up, instead of waiting for somebody to push again. Each
 * inline preparation is isolated, so one failure cannot take the rest with it.
 */
export async function prepareRevisionsForPush(
  project: ProjectRow,
  refs: string[],
): Promise<{ prepared: number; scheduled: number }> {
  if (!repoSnapshotWorkerEnabled()) return { prepared: 0, scheduled: 0 };
  const branches = [...new Set(refs.filter((ref) => ref.startsWith('refs/heads/')))];
  if (branches.length === 0) return { prepared: 0, scheduled: 0 };

  // Park the branches BEFORE the identity lookup. It reaches GitHub, and a 503
  // there used to take every branch of the push with it: no repository id means
  // no ref rows, and nothing else remembered the push had happened.
  const alreadyRegistered = readRepoSnapshotRepository(project).repository !== null;
  if (!alreadyRegistered) {
    await db
      .update(projects)
      .set({
        metadata: metadataMergeSubtree(
          gitMetadataSubtree(project),
          pendingPushedRefsFields(project, branches),
        ),
      })
      .where(eq(projects.projectId, project.projectId))
      .catch((error) => {
        logger.warn('[repo-snapshot] could not park pushed refs', {
          projectId: project.projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  const context = await prepareContext(project);
  if ('prepared' in context) {
    logger.info('[repo-snapshot] pushed refs parked until the project has an identity', {
      projectId: project.projectId,
      refs: branches.length,
      reason: context.reason,
    });
    return { prepared: 0, scheduled: 0 };
  }

  // Anything parked by an earlier push that could not be recorded.
  const replayed = pendingPushedRefs(project).map((ref) => `refs/heads/${ref}`);
  const all = [...new Set([...branches, ...replayed])];

  const at = new Date();
  let scheduled = 0;
  for (const ref of all) {
    await ensureRefReconcileScheduled({ identity: context.repository, ref, at }).then(
      () => {
        scheduled += 1;
      },
      (error) => {
        logger.warn('[repo-snapshot] could not record a pushed ref', {
          projectId: project.projectId,
          ref,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }

  if (!alreadyRegistered && scheduled > 0) {
    // They have ref rows now, which is a better home than project metadata.
    await db
      .update(projects)
      .set({
        metadata: metadataMergeSubtree(gitMetadataSubtree(project), clearPendingPushedRefsFields()),
      })
      .where(eq(projects.projectId, project.projectId))
      .catch(() => {});
  }

  let prepared = 0;
  for (const ref of branches.slice(0, PREPARE_REFS_PER_PUSH)) {
    const result = await prepareRefTipWith(context, ref, 'proxy_push').catch((error) => ({
      prepared: false as const,
      reason: error instanceof Error ? error.message : String(error),
    }));
    if (result.prepared) prepared += 1;
    else {
      logger.info('[repo-snapshot] pushed ref not prepared inline', {
        projectId: project.projectId,
        ref,
        reason: result.reason,
      });
    }
  }
  if (branches.length > PREPARE_REFS_PER_PUSH) {
    logger.info('[repo-snapshot] push exceeded the inline budget; the rest are queued', {
      projectId: project.projectId,
      refs: branches.length,
      inline: PREPARE_REFS_PER_PUSH,
      queued: scheduled,
    });
  }
  return { prepared, scheduled };
}

/**
 * A project was created, imported or linked. Best-effort and non-blocking: the
 * reconciliation pass picks up anything that fails here.
 */
export function schedulePreparationForNewProject(project: ProjectRow): void {
  if (!repoSnapshotWorkerEnabled()) return;
  void (async () => {
    const result = await prepareRefTip(project, project.defaultBranch, 'import');
    if (result.prepared) {
      logger.info('[repo-snapshot] queued preparation for a new project', {
        projectId: project.projectId,
        ref: project.defaultBranch,
        commitSha: result.commitSha,
      });
      triggerRepoSnapshotWorker();
      return;
    }
    logger.info('[repo-snapshot] new project not prepared', {
      projectId: project.projectId,
      reason: result.reason,
    });
  })().catch((error) => {
    logger.warn('[repo-snapshot] new-project preparation failed', {
      projectId: project.projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
