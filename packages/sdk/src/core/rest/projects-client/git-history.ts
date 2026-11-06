// Git history — branches (Versions), commits (Checkpoints), diffs.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

// ---------------------------------------------------------------------------
// Git history — branches (Versions), commits (Checkpoints), diffs
// ---------------------------------------------------------------------------

/**
 * Which session a session branch belongs to. A session branch is named by its session id.
 *
 * @deprecated Use `WorkspaceBranchSession`. Kept permanently.
 */
export interface ProjectBranchSession {
  /** The session's title. Null when it has none yet, or when the caller may not open the session. */
  title: string | null;
  agent_name: string | null;
  /** The caller archived the session. */
  archived: boolean;
  /** The session is in Recently deleted. Its branch is kept until its restore window ends. */
  deleted: boolean;
}

/** The workspace name of {@link ProjectBranchSession}: the same type. */
export type WorkspaceBranchSession = ProjectBranchSession;

/** @deprecated Use `WorkspaceBranch`. Kept permanently. */
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
  /** Present on a session branch. Absent on the default branch, a named branch, and older servers. */
  session?: ProjectBranchSession;
}

/** The workspace name of {@link ProjectBranch}: the same type. */
export type WorkspaceBranch = ProjectBranch;

/** @deprecated Use `WorkspaceBranchesResponse`. Kept permanently. */
export interface ProjectBranchesResponse {
  default_branch: string;
  branches: ProjectBranch[];
}

/** The workspace name of {@link ProjectBranchesResponse}: the same type. */
export type WorkspaceBranchesResponse = ProjectBranchesResponse;

/** @deprecated Use `WorkspaceCommit`. Kept permanently. */
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

/** The workspace name of {@link ProjectCommit}: the same type. */
export type WorkspaceCommit = ProjectCommit;

/** @deprecated Use `WorkspaceCommitsResponse`. Kept permanently. */
export interface ProjectCommitsResponse {
  ref: string;
  path: string | null;
  commits: ProjectCommit[];
  hasMore: boolean;
}

/** The workspace name of {@link ProjectCommitsResponse}: the same type. */
export type WorkspaceCommitsResponse = ProjectCommitsResponse;

/** @deprecated Use `WorkspaceCommitFile`. Kept permanently. */
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

/** The workspace name of {@link ProjectCommitFile}: the same type. */
export type WorkspaceCommitFile = ProjectCommitFile;

/** @deprecated Use `WorkspaceCommitDetail`. Kept permanently. */
export interface ProjectCommitDetail extends ProjectCommit {
  files: ProjectCommitFile[];
}

/** The workspace name of {@link ProjectCommitDetail}: the same type. */
export type WorkspaceCommitDetail = ProjectCommitDetail;

/** @deprecated Use `WorkspaceCommitDiffResponse`. Kept permanently. */
export interface ProjectCommitDiffResponse {
  hash: string;
  parent: string | null;
  path: string | null;
  patch: string;
}

/** The workspace name of {@link ProjectCommitDiffResponse}: the same type. */
export type WorkspaceCommitDiffResponse = ProjectCommitDiffResponse;

/** @deprecated Use `WorkspaceFileHistoryResponse`. Kept permanently. */
export interface ProjectFileHistoryResponse {
  path: string;
  ref: string;
  commits: ProjectCommit[];
  hasMore: boolean;
}

/** The workspace name of {@link ProjectFileHistoryResponse}: the same type. */
export type WorkspaceFileHistoryResponse = ProjectFileHistoryResponse;

/** @deprecated Use `ListWorkspaceBranchesOptions`. Kept permanently. */
export interface ListProjectBranchesOptions {
  /** Case-insensitive substring match on branch name. */
  q?: string;
  /** Server default 500, hard cap 2000. */
  limit?: number;
  /**
   * Auto-created session branches (named by the session's UUID) are listed
   * unless this is `false`. A default-branch picker passes `false`; the
   * Files version selector and the change-request head picker leave it unset.
   */
  includeSessionBranches?: boolean;
}

/** The workspace name of {@link ListProjectBranchesOptions}: the same type. */
export type ListWorkspaceBranchesOptions = ListProjectBranchesOptions;

export async function listWorkspaceBranches(
  projectId: string,
  options?: ListProjectBranchesOptions,
) {
  const params = new URLSearchParams();
  if (options?.q) params.set('q', options.q);
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.includeSessionBranches !== undefined) {
    params.set('include_session_branches', String(options.includeSessionBranches));
  }
  const query = params.toString() ? `?${params.toString()}` : '';
  return unwrap(
    await backendApi.get<ProjectBranchesResponse>(
      `/workspaces/${projectId}/branches${query}`,
    ),
  );
}

/** @deprecated Use `listWorkspaceBranches`. Kept permanently. */
export const listProjectBranches = listWorkspaceBranches;

export async function listWorkspaceCommits(
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
      `/workspaces/${projectId}/commits${query}`,
    ),
  );
}

/** @deprecated Use `listWorkspaceCommits`. Kept permanently. */
export const listProjectCommits = listWorkspaceCommits;

export async function getWorkspaceCommit(projectId: string, sha: string) {
  return unwrap(
    await backendApi.get<ProjectCommitDetail>(
      `/workspaces/${projectId}/commits/${encodeURIComponent(sha)}`,
    ),
  );
}

/** @deprecated Use `getWorkspaceCommit`. Kept permanently. */
export const getProjectCommit = getWorkspaceCommit;

export async function getWorkspaceCommitDiff(
  projectId: string,
  sha: string,
  options?: { path?: string },
) {
  const params = new URLSearchParams();
  if (options?.path) params.set('path', options.path);
  const query = params.toString() ? `?${params.toString()}` : '';
  return unwrap(
    await backendApi.get<ProjectCommitDiffResponse>(
      `/workspaces/${projectId}/commits/${encodeURIComponent(sha)}/diff${query}`,
    ),
  );
}

/** @deprecated Use `getWorkspaceCommitDiff`. Kept permanently. */
export const getProjectCommitDiff = getWorkspaceCommitDiff;

export async function getWorkspaceFileHistory(
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
      `/workspaces/${projectId}/files/history?${params.toString()}`,
    ),
  );
}

/** @deprecated Use `getWorkspaceFileHistory`. Kept permanently. */
export const getProjectFileHistory = getWorkspaceFileHistory;
