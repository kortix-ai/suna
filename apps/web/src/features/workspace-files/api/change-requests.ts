/**
 * Change-request data fetchers for the workspace-files feature. Thin wrappers
 * over `@kortix/sdk` so the feature module's hooks can keep their
 * query keys colocated with the rest of the file-explorer caches.
 */

import {
  closeChangeRequest,
  commitSessionChanges,
  getChangeRequest,
  getChangeRequestDiff,
  getChangeRequestMergePreview,
  getVersionDiff,
  listChangeRequests,
  mergeChangeRequest,
  openChangeRequest,
  reopenChangeRequest,
  requestChangesOnChangeRequest,
  type WorkspaceChangeRequest,
  type ChangeRequestDetailResponse,
  type ChangeRequestDiffResponse,
  type ChangeRequestMergePreview,
  type ChangeRequestMergeResponse,
  type ChangeRequestStatus,
  type CommitSessionResult,
  type VersionDiffPreview,
} from '@kortix/sdk';

export type {
  WorkspaceChangeRequest,
  ChangeRequestDetailResponse,
  ChangeRequestDiffResponse,
  ChangeRequestMergePreview,
  ChangeRequestMergeResponse,
  ChangeRequestStatus,
  CommitSessionResult,
  VersionDiffPreview,
};

export async function fetchChangeRequests(
  workspaceId: string,
  status?: ChangeRequestStatus | 'all',
) {
  return listChangeRequests(workspaceId, status);
}

export async function fetchChangeRequest(workspaceId: string, crId: string) {
  return getChangeRequest(workspaceId, crId);
}

export async function fetchChangeRequestDiff(workspaceId: string, crId: string) {
  return getChangeRequestDiff(workspaceId, crId);
}

export async function fetchChangeRequestMergePreview(
  workspaceId: string,
  crId: string,
) {
  return getChangeRequestMergePreview(workspaceId, crId);
}

export async function createChangeRequest(
  workspaceId: string,
  input: {
    title: string;
    description?: string;
    head_ref: string;
    base_ref?: string;
    session_id?: string;
  },
) {
  return openChangeRequest(workspaceId, input);
}

export async function performMerge(workspaceId: string, crId: string) {
  return mergeChangeRequest(workspaceId, crId);
}

export async function performClose(workspaceId: string, crId: string) {
  return closeChangeRequest(workspaceId, crId);
}

export async function performReopen(workspaceId: string, crId: string) {
  return reopenChangeRequest(workspaceId, crId);
}

export async function performRequestChanges(workspaceId: string, crId: string, feedback: string) {
  return requestChangesOnChangeRequest(workspaceId, crId, feedback);
}

export async function fetchVersionDiff(
  workspaceId: string,
  input: { from: string; into: string },
) {
  return getVersionDiff(workspaceId, input);
}

// NOTE (2026-05-29): currently UNUSED — kept for a possible fully-UI
// change-request flow. The shipped flow asks the agent to commit + open the CR.
export async function commitSessionChangesRequest(
  workspaceId: string,
  sessionId: string,
  input?: { message?: string },
) {
  return commitSessionChanges(workspaceId, sessionId, input);
}
