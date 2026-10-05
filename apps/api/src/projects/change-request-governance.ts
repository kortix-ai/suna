// What merging a change request writes into the project manifest, as the
// permissions that change needs. A change to `agents`, `triggers` or
// `default_agent` needs the permission its direct route asserts
// (`requiredManifestActions`), so a merge cannot do what the merger could not
// do directly.

import type { AgentGrant } from '@kortix/db';
import { grantsOfManifestText } from './agents/grants';
import { requiredManifestActions } from './change-request-policy';
import { readManifestFromRepo } from './git/files';
import { getMergeBase } from './git/merge';
import { refreshMirror } from './git/mirror';
import type { GitBackedProject } from './git/types';

/**
 * The manifest permissions merging `cr` needs: `[]` when it changes none of
 * the governed sections.
 *
 * Reads the manifest at the merge base and at the CR head. Both refs are
 * proved current first: the head branch is usually pushed seconds before the
 * merge, often through another API replica, and each replica's mirror serves
 * refs up to KORTIX_GIT_REFRESH_INTERVAL_MS stale. Reading a stale mirror made
 * the head ref unresolvable (release gate GH-17, v0.13.31).
 *
 * Throws when a side cannot be read. The caller refuses the merge with a
 * retryable 503 (`CR_GOVERNANCE_UNVERIFIED`): it never merges a change it
 * could not classify.
 */
export async function manifestChangeRequiredActions(
  project: GitBackedProject,
  cr: { baseRef: string; headRef: string },
): Promise<string[]> {
  return (await manifestChange(project, cr)).required;
}

/**
 * What merging `cr` does to the manifest: the permissions it needs
 * (`manifestChangeRequiredActions`) and every agent's grant before and after,
 * for the non-escalation check (iam/agent-grant-ceiling.ts). Throws like
 * `manifestChangeRequiredActions`.
 */
export async function manifestChange(
  project: GitBackedProject,
  cr: { baseRef: string; headRef: string },
): Promise<{ required: string[]; grantsBefore: Map<string, AgentGrant>; grantsAfter: Map<string, AgentGrant> }> {
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
  const baseText = before?.content ?? null;
  const headText = after?.content ?? null;
  return {
    required: requiredManifestActions(baseText, headText, baseFormat, headFormat),
    grantsBefore: grantsOfManifestText(baseText, baseFormat),
    grantsAfter: grantsOfManifestText(headText, headFormat),
  };
}
