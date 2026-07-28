/**
 * Whole-repo commit listing + per-commit detail for the project-files feature.
 * Surfaced as "Checkpoints" in the UI.
 */

import {
  type ProjectCommitDetail,
  type ProjectCommitDiffResponse,
  type ProjectCommitsResponse,
  getProjectCommit,
  getProjectCommitDiff,
  listProjectCommits,
} from '@kortix/sdk';

export async function fetchCommits(
  projectId: string,
  options: { ref: string; limit?: number; skip?: number; path?: string },
): Promise<ProjectCommitsResponse> {
  return listProjectCommits(projectId, options);
}

export async function fetchCommit(projectId: string, sha: string): Promise<ProjectCommitDetail> {
  return getProjectCommit(projectId, sha);
}

export async function fetchCommitDiff(
  projectId: string,
  sha: string,
  options?: { path?: string },
): Promise<ProjectCommitDiffResponse> {
  return getProjectCommitDiff(projectId, sha, options);
}
