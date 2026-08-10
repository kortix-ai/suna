// Git history — branches (Versions), commits (Checkpoints), diffs.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

// ---------------------------------------------------------------------------
// Git history — branches (Versions), commits (Checkpoints), diffs
// ---------------------------------------------------------------------------

export interface WorkspaceBranch {
  name: string;
  is_default: boolean;
  tip: string;
  tip_short: string;
  subject: string;
  committer_name: string;
  committer_email: string;
  committed_at: string;
  ahead: number | null;
  behind: number | null;
}

export interface WorkspaceBranchesResponse {
  default_branch: string;
  branches: WorkspaceBranch[];
}

export interface WorkspaceCommit {
  hash: string;
  short_hash: string;
  parents: string[];
  author_name: string;
  author_email: string;
  authored_at: string;
  committer_name: string;
  committer_email: string;
  committed_at: string;
  subject: string;
  body: string;
}

export interface WorkspaceCommitsResponse {
  ref: string;
  path: string | null;
  commits: WorkspaceCommit[];
  hasMore: boolean;
}

export interface WorkspaceCommitFile {
  path: string;
  old_path: string | null;
  status:
    | 'added'
    | 'modified'
    | 'deleted'
    | 'renamed'
    | 'copied'
    | 'typechange';
  additions: number;
  deletions: number;
}

export interface WorkspaceCommitDetail extends WorkspaceCommit {
  files: WorkspaceCommitFile[];
}

export interface WorkspaceCommitDiffResponse {
  hash: string;
  parent: string | null;
  path: string | null;
  patch: string;
}

export interface WorkspaceFileHistoryResponse {
  path: string;
  ref: string;
  commits: WorkspaceCommit[];
  hasMore: boolean;
}

export async function listWorkspaceBranches(workspaceId: string) {
  return unwrap(
    await backendApi.get<WorkspaceBranchesResponse>(
      `/workspaces/${workspaceId}/branches`,
    ),
  );
}

export async function listWorkspaceCommits(
  workspaceId: string,
  options?: { ref?: string; path?: string; limit?: number; skip?: number },
) {
  const params = new URLSearchParams();
  if (options?.ref) params.set('ref', options.ref);
  if (options?.path) params.set('path', options.path);
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.skip != null) params.set('skip', String(options.skip));
  const query = params.toString() ? `?${params.toString()}` : '';
  return unwrap(
    await backendApi.get<WorkspaceCommitsResponse>(
      `/workspaces/${workspaceId}/commits${query}`,
    ),
  );
}

export async function getWorkspaceCommit(workspaceId: string, sha: string) {
  return unwrap(
    await backendApi.get<WorkspaceCommitDetail>(
      `/workspaces/${workspaceId}/commits/${encodeURIComponent(sha)}`,
    ),
  );
}

export async function getWorkspaceCommitDiff(
  workspaceId: string,
  sha: string,
  options?: { path?: string },
) {
  const params = new URLSearchParams();
  if (options?.path) params.set('path', options.path);
  const query = params.toString() ? `?${params.toString()}` : '';
  return unwrap(
    await backendApi.get<WorkspaceCommitDiffResponse>(
      `/workspaces/${workspaceId}/commits/${encodeURIComponent(sha)}/diff${query}`,
    ),
  );
}

export async function getWorkspaceFileHistory(
  workspaceId: string,
  path: string,
  options?: { ref?: string; limit?: number; skip?: number },
) {
  const params = new URLSearchParams({ path });
  if (options?.ref) params.set('ref', options.ref);
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.skip != null) params.set('skip', String(options.skip));
  return unwrap(
    await backendApi.get<WorkspaceFileHistoryResponse>(
      `/workspaces/${workspaceId}/files/history?${params.toString()}`,
    ),
  );
}
