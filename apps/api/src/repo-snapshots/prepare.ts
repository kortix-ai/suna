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
import { getBranchCommitSha, parseGitHubRepoUrl } from '../projects/github';
import { withProjectGitAuth } from '../projects/lib/git';
import type { ProjectRow } from '../projects/lib/serializers';
import { ensureRepoSnapshotRepository } from './identity';
import { ensureRefReconcileScheduled, observeRepoRef } from './store';
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
  try {
    const authed = await withProjectGitAuth(project);
    const coordinates = parseGitHubRepoUrl(authed.repoUrl) ?? {
      owner: resolved.repository.owner,
      repo: resolved.repository.repo,
    };
    // Stamped BEFORE the provider call: this observation is only as fresh as
    // the moment it asked, and a slower request must not outrank a newer one
    // just by finishing later. See `observeRepoRef`.
    const observedAt = new Date();
    const commitSha = await getBranchCommitSha({
      owner: coordinates.owner,
      repo: coordinates.repo,
      branch,
      auth: authed.gitAuthToken ? { token: authed.gitAuthToken } : undefined,
    });
    const outcome = await prepareRevision({ project, ref, commitSha, via, observedAt });
    return outcome.prepared ? { prepared: true, commitSha } : { prepared: false, reason: outcome.reason };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/404|not found/i.test(message)) {
      // The branch is gone. Clear the desired revision instead of leaving a
      // stale one in place pretending to be current.
      await observeRepoRef({
        identity: resolved.repository,
        ref,
        desiredSha: null,
        via: via === 'reconcile' ? 'reconcile' : 'webhook',
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

/** Backoff before a failed preparation is re-examined. */
function reconcileRetryDelayMs(): number {
  return Math.max(1, config.KORTIX_REPO_SNAPSHOT_RECONCILE_INTERVAL_MINUTES ?? 15) * 60_000;
}

/** A successful push through the Kortix git proxy. */
export async function prepareRevisionForPush(project: ProjectRow, ref: string): Promise<PrepareResult> {
  return prepareRefTip(project, ref, 'proxy_push');
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
