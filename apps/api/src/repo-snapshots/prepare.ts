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
import { ensureRepoSnapshotRepository, readRepoSnapshotRepository } from './identity';
import { beginRefObservation, ensureRefReconcileScheduled, observeRepoRef } from './store';
import { prepareRevision, repoSnapshotWorkerEnabled, triggerRepoSnapshotWorker } from './worker';

export type PrepareResult = { prepared: true; commitSha: string } | { prepared: false; reason: string };

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
  const resolved = await ensureRepoSnapshotRepository(project);
  if (!resolved.repository) {
    return { prepared: false, reason: resolved.unsupportedReason ?? 'project is not GitHub-backed' };
  }
  const branch = ref.replace(/^refs\/heads\//, '');
  // Declared outside the try: the 404 path must record its result under the
  // SAME generation the lookup started from.
  let token: Awaited<ReturnType<typeof beginRefObservation>> | undefined;
  // Hoisted: the 404 path needs the same coordinates and the same credential to
  // ask whether the repository is visible at all.
  let coordinates = { owner: resolved.repository.owner, repo: resolved.repository.repo };
  let auth: { token: string } | undefined;
  try {
    const authed = await withProjectGitAuth(project);
    coordinates = parseGitHubRepoUrl(authed.repoUrl) ?? coordinates;
    auth = authed.gitAuthToken ? { token: authed.gitAuthToken } : undefined;
    // Taken BEFORE the provider call. Anything recorded while this lookup is in
    // flight invalidates it, so a slower request cannot outrank a newer one by
    // finishing later. See `beginRefObservation`.
    token = await beginRefObservation(
      { provider: 'github', repositoryId: resolved.repository.repositoryId },
      ref,
    );
    const commitSha = await getBranchCommitSha({
      owner: coordinates.owner,
      repo: coordinates.repo,
      branch,
      auth,
    });
    const outcome = await prepareRevision({ project, ref, commitSha, via, token });
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
        identity: resolved.repository,
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
      identity: resolved.repository,
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
 * Each ref is given a durable reconcile deadline FIRST. That is a local write
 * with no provider call, and it is what makes the inline budget safe: a ref past
 * the budget, or one whose preparation throws, still has a row the reconcile
 * pass will pick up, instead of being dropped until somebody pushes again. Each
 * inline preparation is isolated, so one failure cannot take the rest with it.
 */
export async function prepareRevisionsForPush(
  project: ProjectRow,
  refs: string[],
): Promise<{ prepared: number; scheduled: number }> {
  if (!repoSnapshotWorkerEnabled()) return { prepared: 0, scheduled: 0 };
  const branches = [...new Set(refs.filter((ref) => ref.startsWith('refs/heads/')))];
  if (branches.length === 0) return { prepared: 0, scheduled: 0 };

  const repository = readRepoSnapshotRepository(project).repository;
  let scheduled = 0;
  if (repository) {
    const at = new Date();
    for (const ref of branches) {
      await ensureRefReconcileScheduled({ identity: repository, ref, at }).then(
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
  } else {
    // No recorded repository id yet, so there is no key to store these under.
    // The worker's discovery pass registers the project, and the next push —
    // or the default-branch repair — brings its refs in.
    logger.info('[repo-snapshot] pushed refs not recorded; project has no repository id', {
      projectId: project.projectId,
      refs: branches.length,
    });
  }

  let prepared = 0;
  for (const ref of branches.slice(0, PREPARE_REFS_PER_PUSH)) {
    const result = await prepareRefTip(project, ref, 'proxy_push').catch((error) => ({
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
