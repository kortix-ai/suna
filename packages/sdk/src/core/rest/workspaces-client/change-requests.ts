// Change Requests — Kortix-native PR layer, version diffs, commit-push.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';
import type { WorkspaceCommitFile } from './git-history';

// ---------------------------------------------------------------------------
// Change Requests — Kortix-native PR layer. Backend-agnostic: the underlying
// merge runs via apps/api/.../git.ts against whichever git host the workspace's
// repo URL points to.
//
// v1 is deliberately minimal — no reviews, no comments, no mirrored revision
// history. Just open / merged / closed plus the live diff against base.
// ---------------------------------------------------------------------------

export type ChangeRequestStatus = 'open' | 'merged' | 'closed';

export interface ChangeRequest {
  cr_id: string;
  account_id: string;
  workspace_id: string;
  number: number;
  title: string;
  description: string;
  base_ref: string;
  head_ref: string;
  status: ChangeRequestStatus;
  head_commit_sha: string | null;
  base_commit_sha: string | null;
  origin_session_id: string | null;
  created_by: string;
  merged_at: string | null;
  merged_by: string | null;
  merge_commit_sha: string | null;
  closed_at: string | null;
  closed_by: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ChangeRequestDetailResponse {
  change_request: ChangeRequest;
}

export interface ChangeRequestDiffResponse {
  cr_id: string;
  base_ref: string;
  head_ref: string;
  base_sha: string;
  head_sha: string;
  merge_base: string | null;
  files: WorkspaceCommitFile[];
  files_changed: number;
  additions: number;
  deletions: number;
  patch: string;
}

export interface ChangeRequestMergePreview {
  base_sha: string;
  head_sha: string;
  merge_base: string | null;
  can_fast_forward: boolean;
  can_merge: boolean;
  conflicts: string[];
  is_up_to_date: boolean;
}

export interface VersionDiffPreview {
  from: string;
  into: string;
  from_sha: string | null;
  into_sha: string | null;
  merge_base: string | null;
  files_changed: number;
  additions: number;
  deletions: number;
  is_up_to_date: boolean;
  is_same_ref: boolean;
}

export async function getVersionDiff(
  workspaceId: string,
  input: { from: string; into: string },
) {
  const params = new URLSearchParams({ from: input.from, into: input.into });
  return unwrap(
    await backendApi.get<VersionDiffPreview>(
      `/workspaces/${workspaceId}/version-diff?${params.toString()}`,
    ),
  );
}

export interface ChangeRequestMergeResponse {
  change_request: ChangeRequest;
  merge: {
    merge_commit_sha: string;
    fast_forward: boolean;
    base_sha_before: string;
    base_sha_after: string;
  };
}

export async function listChangeRequests(
  workspaceId: string,
  status?: ChangeRequestStatus | 'all',
) {
  const query = status ? `?status=${status}` : '';
  return unwrap(
    await backendApi.get<{ change_requests: ChangeRequest[] }>(
      `/workspaces/${workspaceId}/change-requests${query}`,
      {
        // This is often a badge/background poll. Keep failures visible to the
        // query consumer without turning temporary poll misses into global API
        // errors in the browser console.
        showErrors: false,
        timeout: 15_000,
      },
    ),
  );
}

export async function getChangeRequest(workspaceId: string, crId: string) {
  return unwrap(
    await backendApi.get<ChangeRequestDetailResponse>(
      `/workspaces/${workspaceId}/change-requests/${crId}`,
    ),
  );
}

export async function getChangeRequestDiff(workspaceId: string, crId: string) {
  return unwrap(
    await backendApi.get<ChangeRequestDiffResponse>(
      `/workspaces/${workspaceId}/change-requests/${crId}/diff`,
    ),
  );
}

export async function getChangeRequestMergePreview(
  workspaceId: string,
  crId: string,
) {
  return unwrap(
    await backendApi.get<ChangeRequestMergePreview>(
      `/workspaces/${workspaceId}/change-requests/${crId}/merge-preview`,
    ),
  );
}

export async function openChangeRequest(
  workspaceId: string,
  input: {
    title: string;
    description?: string;
    head_ref: string;
    base_ref?: string;
    session_id?: string;
  },
) {
  return unwrap(
    await backendApi.post<ChangeRequest>(
      `/workspaces/${workspaceId}/change-requests`,
      input,
    ),
  );
}

export async function mergeChangeRequest(
  workspaceId: string,
  crId: string,
  input?: { message?: string },
) {
  return unwrap(
    await backendApi.post<ChangeRequestMergeResponse>(
      `/workspaces/${workspaceId}/change-requests/${crId}/merge`,
      input ?? {},
      { showErrors: false },
    ),
  );
}

export async function closeChangeRequest(workspaceId: string, crId: string) {
  return unwrap(
    await backendApi.post<ChangeRequest>(
      `/workspaces/${workspaceId}/change-requests/${crId}/close`,
      {},
    ),
  );
}

export async function reopenChangeRequest(workspaceId: string, crId: string) {
  return unwrap(
    await backendApi.post<ChangeRequest>(
      `/workspaces/${workspaceId}/change-requests/${crId}/reopen`,
      {},
    ),
  );
}

/** Request changes on a CR (Review Center) — records feedback + optionally
 *  delivers it back to the originating session. */
export async function requestChangesOnChangeRequest(
  workspaceId: string,
  crId: string,
  feedback: string,
) {
  return unwrap(
    await backendApi.post<{ change_request: ChangeRequest; delivering: boolean }>(
      `/workspaces/${workspaceId}/change-requests/${crId}/request-changes`,
      { feedback },
    ),
  );
}

export interface CommitSessionResult {
  committed: boolean;
  pushed: boolean;
  nothing_to_do: boolean;
  branch: string | null;
  head_sha: string | null;
}

/**
 * Commit + push the session sandbox's pending changes to its branch — the
 * host-driven step that lets the UI open a change request without asking the
 * agent. Idempotent on the server.
 *
 * NOTE (2026-05-29): currently UNUSED. The shipped flow asks the agent to
 * commit + open the change request from a chat prompt. Kept for a possible
 * fully-UI flow (see the API endpoint /sessions/:id/commit-push).
 */
export async function commitSessionChanges(
  workspaceId: string,
  sessionId: string,
  input?: { message?: string },
) {
  return unwrap(
    await backendApi.post<CommitSessionResult>(
      `/workspaces/${workspaceId}/sessions/${sessionId}/commit-push`,
      input ?? {},
    ),
  );
}
