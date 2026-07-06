// Git history — branches (Versions), commits (Checkpoints), diffs.

import { backendApi } from '../api-client';
import { unwrap } from './shared';

// ---------------------------------------------------------------------------
// Git history — branches (Versions), commits (Checkpoints), diffs
// ---------------------------------------------------------------------------

export interface ProjectBranch {
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

export interface ProjectBranchesResponse {
  default_branch: string;
  branches: ProjectBranch[];
}

export interface ProjectCommit {
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

export interface ProjectCommitsResponse {
  ref: string;
  path: string | null;
  commits: ProjectCommit[];
  hasMore: boolean;
}

export interface ProjectCommitFile {
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

export interface ProjectCommitDetail extends ProjectCommit {
  files: ProjectCommitFile[];
}

export interface ProjectCommitDiffResponse {
  hash: string;
  parent: string | null;
  path: string | null;
  patch: string;
}

export interface ProjectFileHistoryResponse {
  path: string;
  ref: string;
  commits: ProjectCommit[];
  hasMore: boolean;
}

export async function listProjectBranches(projectId: string) {
  return unwrap(
    await backendApi.get<ProjectBranchesResponse>(
      `/projects/${projectId}/branches`,
    ),
  );
}

export async function listProjectCommits(
  projectId: string,
  options?: { ref?: string; path?: string; limit?: number; skip?: number },
) {
  const params = new URLSearchParams();
  if (options?.ref) params.set('ref', options.ref);
  if (options?.path) params.set('path', options.path);
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.skip != null) params.set('skip', String(options.skip));
  const query = params.toString() ? `?${params.toString()}` : '';
  return unwrap(
    await backendApi.get<ProjectCommitsResponse>(
      `/projects/${projectId}/commits${query}`,
    ),
  );
}

export async function getProjectCommit(projectId: string, sha: string) {
  return unwrap(
    await backendApi.get<ProjectCommitDetail>(
      `/projects/${projectId}/commits/${encodeURIComponent(sha)}`,
    ),
  );
}

export async function getProjectCommitDiff(
  projectId: string,
  sha: string,
  options?: { path?: string },
) {
  const params = new URLSearchParams();
  if (options?.path) params.set('path', options.path);
  const query = params.toString() ? `?${params.toString()}` : '';
  return unwrap(
    await backendApi.get<ProjectCommitDiffResponse>(
      `/projects/${projectId}/commits/${encodeURIComponent(sha)}/diff${query}`,
    ),
  );
}

export async function getProjectFileHistory(
  projectId: string,
  path: string,
  options?: { ref?: string; limit?: number; skip?: number },
) {
  const params = new URLSearchParams({ path });
  if (options?.ref) params.set('ref', options.ref);
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.skip != null) params.set('skip', String(options.skip));
  return unwrap(
    await backendApi.get<ProjectFileHistoryResponse>(
      `/projects/${projectId}/files/history?${params.toString()}`,
    ),
  );
}
