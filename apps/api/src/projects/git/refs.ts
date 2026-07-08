// Submission keep-refs — pin a review item's artifact commit under
// refs/kortix/submissions/<review_item_id> on the project remote so the
// artifact survives session-branch deletion and GC. Provider-agnostic: plain
// `git push` through the bare mirror, same auth dance as branches.ts.

import { validateRef } from '../git-ref';
import { hostFromRepoUrl, refreshMirror, runGit, runGitCapture } from './mirror';
import type { GitBackedProject } from './types';

/** True when `sha` resolves to a commit object in the (force-refreshed) mirror. */
export async function commitExistsOnRemote(project: GitBackedProject, sha: string): Promise<boolean> {
  if (!/^[0-9a-f]{40}$/.test(sha)) return false;
  const repoPath = await refreshMirror(project, true);
  const result = await runGitCapture(['cat-file', '-e', `${sha}^{commit}`], repoPath);
  return result.exitCode === 0;
}

/**
 * Point `ref` (e.g. refs/kortix/submissions/<id>) at `sha` on the remote.
 * Also records the ref locally so the mirror serves reads without waiting for
 * the next fetch. Throws when the remote rejects the push.
 */
export async function createKeepRef(project: GitBackedProject, sha: string, ref: string): Promise<void> {
  const target = validateRef(ref);
  if (!target.startsWith('refs/kortix/')) {
    throw new Error('Keep-refs must live under refs/kortix/');
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Invalid commit hash');
  const authHost = hostFromRepoUrl(project.repoUrl);
  const repoPath = await refreshMirror(project, true);
  await runGit(['push', 'origin', `${sha}:${target}`], repoPath, true, project.gitAuthToken, undefined, authHost);
  await runGit(['update-ref', target, sha], repoPath, false).catch(() => undefined);
}

/** Best-effort removal (dismissed-item GC, error unwind). Never throws. */
export async function deleteKeepRef(project: GitBackedProject, ref: string): Promise<void> {
  try {
    const target = validateRef(ref);
    if (!target.startsWith('refs/kortix/')) return;
    const authHost = hostFromRepoUrl(project.repoUrl);
    const repoPath = await refreshMirror(project, true);
    await runGitCapture(['push', 'origin', `:${target}`], repoPath, project.gitAuthToken, undefined, authHost);
    await runGitCapture(['update-ref', '-d', target], repoPath);
  } catch {
    // best-effort
  }
}
