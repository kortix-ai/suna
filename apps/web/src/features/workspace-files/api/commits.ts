/**
 * Whole-repo commit listing + per-commit detail for the workspace-files feature.
 * Surfaced as "Checkpoints" in the UI.
 */

import {
  getWorkspaceCommit,
  getWorkspaceCommitDiff,
  listWorkspaceCommits,
  type WorkspaceCommitDetail,
  type WorkspaceCommitDiffResponse,
  type WorkspaceCommitsResponse,
} from '@kortix/sdk';

export async function fetchCommits(
  workspaceId: string,
  options: { ref: string; limit?: number; skip?: number; path?: string },
): Promise<WorkspaceCommitsResponse> {
  return listWorkspaceCommits(workspaceId, options);
}

export async function fetchCommit(
  workspaceId: string,
  sha: string,
): Promise<WorkspaceCommitDetail> {
  return getWorkspaceCommit(workspaceId, sha);
}

export async function fetchCommitDiff(
  workspaceId: string,
  sha: string,
  options?: { path?: string },
): Promise<WorkspaceCommitDiffResponse> {
  return getWorkspaceCommitDiff(workspaceId, sha, options);
}
