// Governance guard for agent-session change-request merges (spec 2026-09-22
// §2.4). Under the agent-principal model kortix.yaml `agents` and `triggers`
// ARE agent authority, so an agent must not widen itself (or plant an
// unattended run) by merging its own edit. A person with project.gitops.merge
// merges such a change request.

import { PROJECT_ACTIONS } from '../iam';
import { manifestGovernanceChanged } from './change-request-policy';
import { readManifestFromRepo } from './git/files';
import { getMergeBase } from './git/merge';
import { refreshMirror } from './git/mirror';
import type { GitBackedProject } from './git/types';

export interface GovernanceMergeRefusal {
  status: 403 | 503;
  body: Record<string, unknown>;
  /** Seconds, set only on the retryable 503. */
  retryAfter?: number;
}

/**
 * The refusal when an agent-session merge would change kortix.yaml `agents` or
 * `triggers`; null when it would not.
 *
 * Reads the manifest at the merge base and at the CR head. Both refs are
 * proved current first: the head branch is usually pushed seconds before the
 * merge, often through another API replica, and each replica's mirror serves
 * refs up to KORTIX_GIT_REFRESH_INTERVAL_MS stale. Reading a stale mirror made
 * the head ref unresolvable, and the fail-closed path then refused a change
 * request that touched no agent (release gate GH-17, v0.13.31).
 *
 * A read that still fails refuses (fail closed) with its own code,
 * `CR_GOVERNANCE_UNVERIFIED` (503, retryable). It never claims the change
 * request changes agents when the guard could not tell.
 */
export async function agentGovernanceMergeRefusal(
  project: GitBackedProject,
  cr: { number: number; baseRef: string; headRef: string },
): Promise<GovernanceMergeRefusal | null> {
  try {
    const { manifestCandidatePaths, manifestFormatForPath } = await import('@kortix/manifest-schema');
    const candidates = manifestCandidatePaths(project.manifestPath).map((cand) => cand.path);
    // One ls-remote per ref when it has not moved; a fetch when it has or when
    // this mirror has never seen it.
    await refreshMirror(project, true, { freshRef: cr.headRef });
    await refreshMirror(project, true, { freshRef: cr.baseRef });
    const mergeBase = await getMergeBase(project, cr.baseRef, cr.headRef);
    const [before, after] = await Promise.all([
      readManifestFromRepo(project, candidates, mergeBase ?? cr.baseRef, { strictRef: true }),
      readManifestFromRepo(project, candidates, cr.headRef, { strictRef: true }),
    ]);
    const baseFormat = manifestFormatForPath(before?.path ?? after?.path ?? 'kortix.yaml');
    const headFormat = manifestFormatForPath(after?.path ?? before?.path ?? 'kortix.yaml');
    if (!manifestGovernanceChanged(before?.content ?? null, after?.content ?? null, baseFormat, headFormat)) {
      return null;
    }
    return {
      status: 403,
      body: {
        error:
          `Change request #${cr.number} changes agents or triggers in the project manifest. ` +
          'An agent cannot merge that; a person with project.gitops.merge must.',
        code: 'CR_AGENT_GOVERNANCE_CHANGE',
        action: PROJECT_ACTIONS.PROJECT_GITOPS_MERGE,
      },
    };
  } catch (err) {
    console.warn('[cr-merge] governance guard could not read the manifest; refusing the agent merge', {
      cr: cr.number,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      status: 503,
      retryAfter: 5,
      body: {
        error:
          `Could not read the project manifest to check whether change request #${cr.number} ` +
          'changes agents or triggers. The merge was not applied. Retry it.',
        code: 'CR_GOVERNANCE_UNVERIFIED',
        action: PROJECT_ACTIONS.PROJECT_GITOPS_MERGE,
      },
    };
  }
}
